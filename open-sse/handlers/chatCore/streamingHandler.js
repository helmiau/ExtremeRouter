import { FORMATS } from "../../translator/formats.js";
import { needsTranslation } from "../../translator/index.js";
import { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } from "../../utils/stream.js";
import { pipeWithDisconnect } from "../../utils/streamHandler.js";
import { PROVIDERS } from "../../config/providers.js";
import { STREAM_STALL_TIMEOUT_MS } from "../../config/runtimeConfig.js";
import { buildAbortedResponsesTerminalBytes } from "../../utils/responsesStreamHelpers.js";
import { createResponsesAccumulator } from "../../translator/concerns/responsesAccumulator.js";
import { createStreamState } from "../../utils/streamState.js";
import { createCanonicalAttempt, deriveUsableOutput } from "../../utils/canonicalAttempt.js";
import {
  mapCanonicalAttemptToRequestStatus,
  REQUEST_DETAIL_STREAMING_STATUS,
} from "../../utils/requestDetailStatus.js";
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
export async function handleStreamingResponse({ providerResponse, provider, model, sourceFormat, targetFormat, userAgent, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, reqLogger, toolNameMap, streamController, onStreamComplete, streamDetailId, savedTokens, combo, forensic }) {
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
      // No provider attempt was produced before the pipe was blocked — null,
      // never fabricated.
      canonicalAttempt: null,
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

  // Request-detail lifecycle: the admission save marks the row "streaming"
  // (non-terminal). The FINAL terminal write happens exactly once — either in
  // the completion callback (buildOnStreamComplete, canonical outcome) or in
  // the abort/error finalizers below when the stream ends without a flush.
  // requestDetailsRepo additionally enforces first-terminal-wins at the DB.
  let detailFinalized = false;
  const claimDetailFinalization = () => {
    if (detailFinalized) return false;
    detailFinalized = true;
    return true;
  };

  // Finalize the request detail when the stream ends WITHOUT reaching the
  // transform flush (client disconnect / upstream read error / stall). The
  // status is derived from the canonical attempt built from the observed
  // stream state (abortSeen → cancelled, errorSeen → provider failure).
  const finalizeDetailOnTermination = (terminationReason) => {
    if (!claimDetailFinalization()) return;
    const attempt = createCanonicalAttempt(streamState, { status: providerResponse.status, source: "provider" });
    const status = mapCanonicalAttemptToRequestStatus(attempt);
    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId,
      latency: { ttft: 0, total: Date.now() - requestStartTime },
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: finalBody || translatedBody || null,
      providerResponse: "[Streaming - raw response not captured]",
      response: { content: "[Stream terminated before completion]", thinking: null, type: "streaming" },
      status,
      combo,
    }, {
      id: streamDetailId,
      correlation: forensic || null,
      transport: { status: providerResponse.status, contentType: upstreamContentType, streamMode: "streaming", sourceFormat, targetFormat },
      canonicalAttempt: attempt,
      streamObservability: pickStreamObservability(streamState, { sourceFormat, targetFormat, mode: "streaming" }),
    })).catch(err => {
      console.error("[RequestDetail] Failed to finalize streaming request:", err.message);
    });
    console.log(`[RequestDetail] lifecycle: streaming → ${status} | provider=${provider} | model=${model} | reason=${terminationReason} | classification=${attempt.classification ?? "null"}${combo ? ` | combo=${combo.id || "custom"}` : ""}`);
  };

  // Commit D: the ChatResult carry a live canonical-attempt holder. At handler
  // return the stream has not completed, so the holder truthfully reflects "no
  // completion evidence yet" (completionState=unknown). When the transform
  // flushes, onStreamCompleteWithState overwrites the SAME reference with the
  // finalized attempt — no stream consumption, no blocking downstream delivery.
  const canonicalAttempt = createCanonicalAttempt(streamState, { status: providerResponse.status, source: "provider" });

  // The completion callback is built upstream (chatCore) before this function
  // runs, so wrap it: existing positional args preserved, state appended 4th.
  // Wave 2/2: append the observational stream state (4th) and the provider HTTP
// status (5th, for transport metadata in canonicalAttempt). Status is read
// without touching the stream body. Existing positional args preserved.
  const onStreamCompleteWithState = onStreamComplete
    ? (contentObj, usage, ttftAt) => {
        // The flush is the authoritative finalizer for the request detail;
        // claim it so a late abort/error observer cannot double-finalize.
        claimDetailFinalization();
        Object.assign(canonicalAttempt, createCanonicalAttempt(streamState, { status: providerResponse.status, source: "provider" }));
        return onStreamComplete(contentObj, usage, ttftAt, streamState, providerResponse.status);
      }
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
  // NOT a provider failure); upstream read errors → errorSeen. The observers
  // also finalize the request detail when the stream ends without a flush.
  const transformedBody = pipeWithDisconnect(providerResponse, transformStream, streamController, onAbortTerminal, stallTimeoutMs, {
    onAbort: () => { streamState.abortSeen = true; finalizeDetailOnTermination("client_disconnect"); },
    onError: () => { streamState.errorSeen = true; finalizeDetailOnTermination("stream_error"); },
  });

  saveRequestDetail(buildRequestDetail({
    provider, model, connectionId,
    latency: { ttft: 0, total: Date.now() - requestStartTime },
    tokens: { prompt_tokens: 0, completion_tokens: 0 },
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null,
    providerResponse: "[Streaming - raw response not captured]",
    response: { content: "[Streaming in progress...]", thinking: null, type: "streaming" },
    status: REQUEST_DETAIL_STREAMING_STATUS,
      combo,
    }, {
      id: streamDetailId,
      correlation: forensic || null,
      transport: { status: providerResponse.status, contentType: upstreamContentType, streamMode: "streaming", sourceFormat, targetFormat },
      streamObservability: pickStreamObservability(streamState, { sourceFormat, targetFormat, mode: "streaming" }),
    })).catch(err => {
    console.error("[RequestDetail] Failed to save streaming request:", err.message);
  });

  return {
    success: true,
    response: new Response(transformedBody, { headers: SSE_HEADERS }),
    // Commit D: live holder — fills with the finalized attempt at flush.
    canonicalAttempt,
  };
}

/**
 * Observational stream-state fields safe to persist: booleans + short enums
 * only. Never content, prompts, keys, or raw provider payloads.
 * Wave 2/2 adds the derived semantic fields (usableOutput / logicalSuccess /
 * outcome) — informational, consulted by no production behavior.
 */
function pickStreamObservability(state, meta = {}) {
  if (!state) return undefined;
  const hasCounters = Number.isFinite(state.recvLines) || Number.isFinite(state.dataLines) || Number.isFinite(state.eventLines) || Number.isFinite(state.emitted);
  return {
    sourceFormat: meta.sourceFormat || null,
    targetFormat: meta.targetFormat || null,
    mode: meta.mode || "streaming",
    recvLines: hasCounters && Number.isFinite(state.recvLines) ? state.recvLines : null,
    dataLines: hasCounters && Number.isFinite(state.dataLines) ? state.dataLines : null,
    eventLines: hasCounters && Number.isFinite(state.eventLines) ? state.eventLines : null,
    emitted: hasCounters && Number.isFinite(state.emitted) ? state.emitted : null,
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
    usableOutput: deriveUsableOutput(state),
    logicalSuccess: createCanonicalAttempt(state).logicalSuccess,
    outcome: createCanonicalAttempt(state).outcome,
  };
}

/**
 * Build onStreamComplete callback for streaming usage tracking.
 */
export function buildOnStreamComplete({ provider, model, sourceFormat, targetFormat, connectionId, apiKey, requestStartTime, body, stream, finalBody, translatedBody, clientRawRequest, savedTokens, savedTokensByMechanism, savedBytesByMechanism, cavemanActive, ponytailActive, retryCount, combo, forensic }) {
  const streamDetailId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

  // Wave 2: the transform appends the observational streamState as the 4th
  // argument when available; absent for legacy callers — telemetry omits it.
  const onStreamComplete = (contentObj, usage, ttftAt, streamState, transportStatus) => {
    const latency = {
      ttft: ttftAt ? ttftAt - requestStartTime : Date.now() - requestStartTime,
      total: Date.now() - requestStartTime
    };
    const safeContent = contentObj?.content || "[Empty streaming response]";
    const safeThinking = contentObj?.thinking || null;
    const observability = pickStreamObservability(streamState, { sourceFormat, targetFormat, mode: "streaming" });
    // Canonical attempt: pure derivation composed with transport status at
    // the integration boundary (status only — body never touched). This is
    // the FINAL outcome evidence for the request detail: the persisted status
    // is mapped from the canonical classification, never from transport
    // success alone. source='provider' — this IS a live upstream attempt.
    const canonicalAttempt = streamState
      ? createCanonicalAttempt(streamState, { status: transportStatus, source: "provider" })
      : null;
    const finalStatus = mapCanonicalAttemptToRequestStatus(canonicalAttempt);

    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId,
      latency,
      tokens: usage || { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: finalBody || translatedBody || null,
      providerResponse: safeContent,
      response: { content: safeContent, thinking: safeThinking, type: "streaming" },
      status: finalStatus,
      combo,
    }, {
      id: streamDetailId,
      correlation: forensic || null,
      transport: { status: transportStatus ?? null, contentType: null, streamMode: "streaming" },
      ...(observability ? { streamObservability: observability } : {}),
      ...(canonicalAttempt ? { canonicalAttempt } : {}),
    })).catch(err => {
      console.error("[RequestDetail] Failed to update streaming content:", err.message);
    });
    console.log(`[RequestDetail] lifecycle: streaming → ${finalStatus} | provider=${provider} | model=${model} | reason=stream_complete | classification=${canonicalAttempt?.classification ?? "null"}${combo ? ` | combo=${combo.id || "custom"}` : ""}`);

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
