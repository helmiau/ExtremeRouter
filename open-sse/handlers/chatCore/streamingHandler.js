import { FORMATS } from "../../translator/formats.js";
import { needsTranslation } from "../../translator/index.js";
import { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } from "../../utils/stream.js";
import { pipeWithDisconnect } from "../../utils/streamHandler.js";
import { PROVIDERS } from "../../config/providers.js";
import { STREAM_STALL_TIMEOUT_MS } from "../../config/runtimeConfig.js";
import { buildAbortedResponsesTerminalBytes } from "../../utils/responsesStreamHelpers.js";
import { createResponsesAccumulator } from "../../translator/concerns/responsesAccumulator.js";
import { createStreamState } from "../../utils/streamState.js";
import { buildRequestDetail, extractRequestConfig, saveUsageStats } from "./requestDetail.js";
import { saveRequestDetail } from "@/lib/usageDb.js";
import { SSE_HEADERS_CORS as SSE_HEADERS } from "../../utils/sseConstants.js";
import { augmentWithOutputSaverSavings } from "../../rtk/outputSaver.js";

// Codex returns Responses API SSE → which client format to translate INTO, by request sourceFormat.
// Gemini-family all map to ANTIGRAVITY decoder; unknown sources fall back to OPENAI.
const CODEX_SOURCE_TO_TARGET = {
  [FORMATS.OPENAI_RESPONSES]: FORMATS.OPENAI_RESPONSES,
  [FORMATS.CLAUDE]: FORMATS.CLAUDE,
  [FORMATS.ANTIGRAVITY]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI_CLI]: FORMATS.ANTIGRAVITY,
};

/**
 * Determine which SSE transform stream to use based on provider/format.
 */
function buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, responsesAccumulator, streamState }) {
  const isDroidCLI = userAgent?.toLowerCase().includes("droid") || userAgent?.toLowerCase().includes("codex-cli");
  // Responses-API providers (e.g. codex) emit Responses SSE → translate into client format
  const isResponsesProvider = PROVIDERS[provider]?.format === FORMATS.OPENAI_RESPONSES;
  const needsCodexTranslation = isResponsesProvider && targetFormat === FORMATS.OPENAI_RESPONSES && !isDroidCLI;

  if (needsCodexTranslation) {
    const codexTarget = CODEX_SOURCE_TO_TARGET[sourceFormat] || FORMATS.OPENAI;
    return createSSETransformStreamWithLogger(FORMATS.OPENAI_RESPONSES, codexTarget, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, responsesAccumulator, streamState);
  }

  if (needsTranslation(targetFormat, sourceFormat)) {
    return createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete, apiKey, responsesAccumulator, streamState);
  }

  return createPassthroughStreamWithLogger(provider, reqLogger, model, connectionId, body, onStreamComplete, apiKey, streamState);
}

/**
 * Handle streaming response — pipe provider SSE through transform stream to client.
 */
export async function handleStreamingResponse({ providerResponse, provider, model, sourceFormat, targetFormat, userAgent, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, reqLogger, toolNameMap, streamController, onStreamComplete, streamDetailId, savedTokens, combo }) {
  if (onRequestSuccess) {
    Promise.resolve()
      .then(onRequestSuccess)
      .catch(err => {
        console.error("[ChatCore] onRequestSuccess failed:", err?.message || err);
      });
  }

  // When upstream returns HTML/text instead of SSE (e.g. Cloudflare 5xx error
  // page), piping it through the SSE transform stream causes Next.js
  // "failed to pipe response" and crashes the chat router. Read the body,
  // pull a short human-readable message from the <title>, sanitize it, and
  // return a clean JSON error instead. The message is stripped of HTML tags
  // and clamped so untrusted upstream text never reaches the client verbatim
  // (the UI may render error.message as HTML).
  const upstreamContentType = (providerResponse.headers.get('content-type') || '').toLowerCase();
  if (upstreamContentType && !upstreamContentType.includes('text/event-stream') && !upstreamContentType.includes('application/json')) {
    const bodyText = await providerResponse.text().catch(() => '');
    const titleMatch = bodyText.match(/<title>([^<]+)<\/title>/i);
    const sanitizedTitle = (titleMatch?.[1] || '').replace(/<[^>]*>/g, '').replace(/[\r\n]+/g, ' ').trim().slice(0, 160);
    const shortMsg = sanitizedTitle
      || (bodyText.length < 200 ? bodyText.replace(/<[^>]*>/g, '').trim().slice(0, 160) : `Upstream returned non-SSE response (${upstreamContentType})`);
    const status = providerResponse.status || 502;
    console.warn(`[STREAM] ${provider} | ${model} | blocked pipe: ${shortMsg} [${status}]`);
    streamController?.handleError?.(new Error(`upstream non-SSE: ${status}`));
    return {
      success: false,
      response: new Response(JSON.stringify({ error: { message: `[${status}]: ${shortMsg}`, type: status >= 500 ? "server_error" : "bad_gateway", code: `HTTP_${status}` } }), {
        status,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      }),
    };
  }

  // Per-request Responses accumulator: shared across the transform stream
  // (translator), forced non-stream converter, and abort handler. Created here
  // so all consumers see the same correlation state. Only for Responses-format
  // targets (passthrough or translation).
  const responsesAccumulator = targetFormat === FORMATS.OPENAI_RESPONSES || sourceFormat === FORMATS.OPENAI_RESPONSES
    ? createResponsesAccumulator({ model })
    : null;

  // Wave 2: stream-scoped observational state. Owned by THIS request; handed
  // to the transform stream and appended to onStreamComplete for telemetry.
  // Purely observational — nothing downstream reads it for behavior decisions.
  const streamState = createStreamState();
  // The completion callback is built upstream (chatCore) before this function
  // runs, so wrap it: existing positional args preserved, state appended 4th.
  const onStreamCompleteWithState = onStreamComplete
    ? (contentObj, usage, ttftAt) => onStreamComplete(contentObj, usage, ttftAt, streamState)
    : null;

  const transformStream = buildTransformStream({ provider, sourceFormat, targetFormat, userAgent, reqLogger, toolNameMap, model, connectionId, body, onStreamComplete: onStreamCompleteWithState, apiKey, responsesAccumulator, streamState });

  // Responses passthrough: synthesize response.failed + [DONE] if the stream aborts/stalls before a terminal event
  const isResponsesPassthrough = sourceFormat === FORMATS.OPENAI_RESPONSES && targetFormat === FORMATS.OPENAI_RESPONSES;
  // Pass the accumulator to the abort handler so it finalizes with the
  // partial output + error (preserving exactly-once terminal semantics).
  const onAbortTerminal = isResponsesPassthrough
    ? () => buildAbortedResponsesTerminalBytes(responsesAccumulator)
    : null;
  const stallTimeoutMs = PROVIDERS[provider]?.stallTimeoutMs || STREAM_STALL_TIMEOUT_MS;
  // Wave 2 observational wiring: disconnect/cancel → abortSeen (client-side,
  // NOT a provider failure); upstream read errors → errorSeen. No behavior.
  const transformedBody = pipeWithDisconnect(providerResponse, transformStream, streamController, onAbortTerminal, stallTimeoutMs, {
    onAbort: () => { streamState.abortSeen = true; },
    onError: () => { streamState.errorSeen = true; },
  });

  saveRequestDetail(buildRequestDetail({
    provider, model, connectionId,
    latency: { ttft: 0, total: Date.now() - requestStartTime },
    tokens: { prompt_tokens: 0, completion_tokens: 0 },
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null,
    providerResponse: "[Streaming - raw response not captured]",
    response: { content: "[Streaming in progress...]", thinking: null, type: "streaming" },
    status: "success",
    combo
  }, { id: streamDetailId })).catch(err => {
    console.error("[RequestDetail] Failed to save streaming request:", err.message);
  });

  return {
    success: true,
    response: new Response(transformedBody, { headers: SSE_HEADERS })
  };
}

/**
 * Observational stream-state fields safe to persist: booleans + short enums
 * only. Never content, prompts, keys, or raw provider payloads.
 */
function pickStreamObservability(state) {
  if (!state) return undefined;
  return {
    streamStarted: !!state.streamStarted,
    hasText: !!state.hasText,
    hasReasoning: !!state.hasReasoning,
    hasToolCall: !!state.hasToolCall,
    hasUsage: !!state.hasUsage,
    terminalSeen: !!state.terminalSeen,
    terminalState: state.terminalState ?? null,
    terminalType: state.terminalType ?? null,
    finishReason: state.finishReason ?? null,
    eofSeen: !!state.eofSeen,
    errorSeen: !!state.errorSeen,
    abortSeen: !!state.abortSeen,
  };
}

/**
 * Build onStreamComplete callback for streaming usage tracking.
 */
export function buildOnStreamComplete({ provider, model, connectionId, apiKey, requestStartTime, body, stream, finalBody, translatedBody, clientRawRequest, savedTokens, savedTokensByMechanism, savedBytesByMechanism, cavemanActive, ponytailActive, retryCount, combo }) {
  const streamDetailId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

  // Wave 2: the transform appends the observational streamState as the 4th
  // argument when available; absent for legacy callers — telemetry omits it.
  const onStreamComplete = (contentObj, usage, ttftAt, streamState) => {
    const latency = {
      ttft: ttftAt ? ttftAt - requestStartTime : Date.now() - requestStartTime,
      total: Date.now() - requestStartTime
    };
    const safeContent = contentObj?.content || "[Empty streaming response]";
    const safeThinking = contentObj?.thinking || null;
    const observability = pickStreamObservability(streamState);

    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId,
      latency,
      tokens: usage || { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: finalBody || translatedBody || null,
      providerResponse: safeContent,
      response: { content: safeContent, thinking: safeThinking, type: "streaming" },
      status: "success",
      combo
    }, { id: streamDetailId, ...(observability ? { streamObservability: observability } : {}) })).catch(err => {
      console.error("[RequestDetail] Failed to update streaming content:", err.message);
    });

    const augmented = augmentWithOutputSaverSavings({
      usage, provider, model,
      savedTokens, savedTokensByMechanism,
      cavemanActive, ponytailActive,
    });
    saveUsageStats({
      provider, model, tokens: usage, connectionId, apiKey,
      endpoint: clientRawRequest?.endpoint, latency,
      savedTokens: augmented.savedTokens,
      savedTokensByMechanism: augmented.savedTokensByMechanism,
      savedBytesByMechanism,
      retryCount, label: "STREAM USAGE",
    });
  };

  return { onStreamComplete, streamDetailId };
}
