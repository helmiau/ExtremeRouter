import { convertResponsesStreamToJson } from "../../transformer/streamToJsonConverter.js";
import { createErrorResult } from "../../utils/error.js";
import { HTTP_STATUS } from "../../config/runtimeConfig.js";
import { FORMATS } from "../../translator/formats.js";
import { PROVIDERS } from "../../config/providers.js";
import { buildRequestDetail, extractRequestConfig, saveUsageStats } from "./requestDetail.js";

// Responses-API providers (e.g. codex) may emit SSE without content-type + use Responses output shape
const isResponsesProvider = (p) => PROVIDERS[p]?.format === FORMATS.OPENAI_RESPONSES;
import { saveRequestDetail, appendRequestLog } from "@/lib/usageDb.js";
import { augmentWithOutputSaverSavings } from "../../rtk/outputSaver.js";
import { createCanonicalAttemptFromForcedSse } from "../../utils/forcedSseAttempt.js";

function textFromResponsesMessageItem(item) {
  if (!item?.content || !Array.isArray(item.content)) return "";
  const byType = item.content.find((c) => c.type === "output_text");
  if (typeof byType?.text === "string") return byType.text;
  const anyText = item.content.find((c) => typeof c.text === "string");
  if (typeof anyText?.text === "string") return anyText.text;
  return "";
}

/**
 * Codex / Responses API may emit many alternating reasoning + message items.
 * Early message blocks often have empty output_text; the user-visible answer is usually in the last non-empty message.
 */
function pickAssistantMessageForChatCompletion(output) {
  if (!Array.isArray(output)) return { msgItem: null, textContent: null };
  const messages = output.filter((item) => item?.type === "message");
  if (messages.length === 0) return { msgItem: null, textContent: null };
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = textFromResponsesMessageItem(messages[i]);
    if (text.length > 0) return { msgItem: messages[i], textContent: text };
  }
  const last = messages[messages.length - 1];
  return { msgItem: last, textContent: textFromResponsesMessageItem(last) };
}

/**
 * Parse OpenAI-style SSE text into a single chat completion JSON.
 * Used when provider forces streaming but client wants non-streaming.
 */
export function parseSSEToOpenAIResponse(rawSSE, fallbackModel, { onMalformedLine = null } = {}) {
  const chunks = [];

  for (const line of String(rawSSE || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try { chunks.push(JSON.parse(payload)); } catch {
      // Commit C: canonical semantics need to know whether the converted 200
      // JSON came from corrupted-only SSE. Track malformed data lines via an
      // optional observer (read-only — parser behavior unchanged).
      onMalformedLine?.(payload);
    }
  }

  if (chunks.length === 0) return null;

  const first = chunks[0];
  const contentParts = [];
  const reasoningParts = [];
  const toolCallMap = new Map(); // index -> { id, type, function: { name, arguments } }
  let finishReason = "stop";
  let usage = null;

  for (const chunk of chunks) {
    const choice = chunk?.choices?.[0];
    const delta = choice?.delta || {};
    if (typeof delta.content === "string" && delta.content.length > 0) contentParts.push(delta.content);
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) reasoningParts.push(delta.reasoning_content);
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk?.usage && typeof chunk.usage === "object") usage = chunk.usage;

    // Accumulate tool_calls from streaming deltas
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolCallMap.has(idx)) {
          toolCallMap.set(idx, { id: tc.id || "", type: "function", function: { name: "", arguments: "" } });
        }
        const existing = toolCallMap.get(idx);
        if (tc.id) existing.id = tc.id;
        if (tc.function?.name) existing.function.name += tc.function.name;
        if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
      }
    }
  }

  const message = { role: "assistant", content: contentParts.join("") || (toolCallMap.size > 0 ? null : "") };
  if (reasoningParts.length > 0) message.reasoning_content = reasoningParts.join("");
  if (toolCallMap.size > 0) {
    message.tool_calls = [...toolCallMap.entries()].sort((a, b) => a[0] - b[0]).map(([, tc]) => tc);
  }

  const result = {
    id: first.id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: first.created || Math.floor(Date.now() / 1000),
    model: first.model || fallbackModel || "unknown",
    choices: [{ index: 0, message, finish_reason: finishReason }]
  };
  if (usage) result.usage = usage;
  return result;
}

/**
 * Handle case: provider forced streaming but client wants JSON.
 * Supports both Codex/Responses API SSE and standard Chat Completions SSE.
 */
export async function handleForcedSSEToJson({ providerResponse, sourceFormat, provider, model, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, trackDone, appendLog, savedTokens, savedTokensByMechanism, savedBytesByMechanism, cavemanActive, ponytailActive, retryCount, combo }) {
  const contentType = providerResponse.headers.get("content-type") || "";
  const isSSE = contentType.includes("text/event-stream") || (contentType === "" && isResponsesProvider(provider));
  if (!isSSE) return null; // not handled here

  trackDone();

  const ctx = {
    provider, model, connectionId, combo,
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null
  };

  // Codex/Responses API SSE path
  const isCodexResponsesApi = isResponsesProvider(provider) || sourceFormat === FORMATS.OPENAI_RESPONSES;
  if (isCodexResponsesApi) {
    try {
      const jsonResponse = await convertResponsesStreamToJson(providerResponse.body);
      if (onRequestSuccess) await onRequestSuccess();

      const usage = jsonResponse.usage || {};
      const totalLatency = Date.now() - requestStartTime;
      appendLog({ tokens: usage, status: "200 OK" });
      const augmented1 = augmentWithOutputSaverSavings({
        usage, provider, model,
        savedTokens, savedTokensByMechanism,
        cavemanActive, ponytailActive,
      });
      saveUsageStats({
        provider, model, tokens: usage, connectionId, apiKey,
        endpoint: clientRawRequest?.endpoint,
        latency: { ttft: totalLatency, total: totalLatency },
        savedTokens: augmented1.savedTokens,
        savedTokensByMechanism: augmented1.savedTokensByMechanism,
        savedBytesByMechanism,
        retryCount,
      });

      const { msgItem, textContent } = pickAssistantMessageForChatCompletion(jsonResponse.output);
      // Commit C: Responses/Codex forced-SSE canonical attempt. Build a tiny
      // OpenAI-normalized view the shared adapter understands; no re-read and
      // no public response mutation. Tool calls are reconstructed below, so
      // include the raw output array in the adapter input after mapping it.
      const responseToolCalls = (jsonResponse.output || [])
        .filter((item) => item.type === "function_call")
        .map((item) => ({ id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments } }));
      const canonicalResponsesJson = {
        choices: [{ message: {
          role: "assistant",
          content: textContent || null,
          ...(responseToolCalls.length > 0 ? { tool_calls: responseToolCalls } : {}),
        } }],
        ...(jsonResponse.error ? { error: jsonResponse.error } : {}),
      };
      const canonicalAttempt = createCanonicalAttemptFromForcedSse({
        status: providerResponse.status,
        finalJson: canonicalResponsesJson,
        usage,
        responsesStatus: jsonResponse.status || null,
        structuredContract: Boolean(body?.response_format),
      });

      saveRequestDetail(buildRequestDetail({
        ...ctx,
        latency: { ttft: totalLatency, total: totalLatency },
        tokens: { prompt_tokens: usage.input_tokens || 0, completion_tokens: usage.output_tokens || 0 },
        response: { content: textContent, thinking: null, finish_reason: jsonResponse.status || "unknown" },
        status: "success"
      }, {
        endpoint: clientRawRequest?.endpoint || null,
        canonicalAttempt,
      })).catch(() => {});

      // Client is Responses API → return as-is
      if (sourceFormat === FORMATS.OPENAI_RESPONSES) {
        return { success: true, response: new Response(JSON.stringify(jsonResponse), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }) };
      }

      // Build client-format response
      const inTokens = usage.input_tokens || 0;
      const outTokens = usage.output_tokens || 0;
      let finalResp;

      // Extract tool calls from Responses API output (function_call items)
      const funcCallItems = (jsonResponse.output || []).filter(item => item.type === "function_call");
      const toolCalls = funcCallItems.map((item, idx) => ({
        id: item.call_id || `call_${item.name}_${Date.now()}_${idx}`,
        type: "function",
        function: {
          name: item.name,
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {})
        }
      }));
      const hasToolCalls = toolCalls.length > 0;

      if (sourceFormat === FORMATS.ANTIGRAVITY || sourceFormat === FORMATS.GEMINI || sourceFormat === FORMATS.GEMINI_CLI) {
        finalResp = {
          response: {
            candidates: [{ content: { role: "model", parts: [{ text: textContent || "" }] }, finishReason: "STOP", index: 0 }],
            usageMetadata: { promptTokenCount: inTokens, candidatesTokenCount: outTokens, totalTokenCount: inTokens + outTokens },
            modelVersion: model,
            responseId: jsonResponse.id || `resp_${Date.now()}`
          }
        };
      } else {
        const message = { role: "assistant", content: textContent || (hasToolCalls ? null : "") };
        if (hasToolCalls) message.tool_calls = toolCalls;
        const responseDone = jsonResponse.status === "completed" || jsonResponse.status === "done";
        const finishReason = hasToolCalls ? "tool_calls" : (responseDone ? "stop" : (jsonResponse.status || "stop"));
        finalResp = {
          id: jsonResponse.id || `chatcmpl-${Date.now()}`,
          object: "chat.completion",
          created: jsonResponse.created_at || Math.floor(Date.now() / 1000),
          model: jsonResponse.model || model,
          choices: [{ index: 0, message, finish_reason: finishReason }],
          usage: { prompt_tokens: inTokens, completion_tokens: outTokens, total_tokens: inTokens + outTokens }
        };
      }

      return { success: true, response: new Response(JSON.stringify(finalResp), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }) };
    } catch (err) {
      // Client cancellation (stop/disconnect) aborts the upstream stream read.
      // That is expected, not an upstream failure — mirror the chatCore 499
      // convention instead of dumping a stack trace + mislabeling it a 502.
      if (err?.name === "AbortError") {
        return createErrorResult(499, "Request aborted");
      }
      console.error("[ChatCore] Responses API SSE→JSON failed:", err);
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, `Failed to convert streaming response to JSON: ${err?.message || err}`);
    }
  }

  // Standard Chat Completions SSE path
  try {
    const sseText = await providerResponse.text();
    let malformedLines = 0;
    const parsed = parseSSEToOpenAIResponse(sseText, model, {
      onMalformedLine: () => { malformedLines++; },
    });
    if (!parsed) {
      // C.1: preserve the existing 502 exactly, but persist the bounded
      // canonical failure before returning. `malformedLines` was collected by
      // the optional parser observer; no body re-read or parser behavior change.
      const canonicalAttempt = createCanonicalAttemptFromForcedSse({
        status: providerResponse.status,
        finalJson: null,
        malformedLines,
      });
      const totalLatency = Date.now() - requestStartTime;
      saveRequestDetail(buildRequestDetail({
        ...ctx,
        latency: { ttft: totalLatency, total: totalLatency },
        tokens: { prompt_tokens: 0, completion_tokens: 0 },
        response: { content: null, thinking: null, finish_reason: "unknown" },
        status: "error",
      }, {
        endpoint: clientRawRequest?.endpoint || null,
        canonicalAttempt,
      })).catch(() => {});
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Invalid SSE response for non-streaming request");
    }

    if (onRequestSuccess) await onRequestSuccess();

    const usage = parsed.usage || {};
    const totalLatency = Date.now() - requestStartTime;
    appendLog({ tokens: usage, status: "200 OK" });
    const augmented2 = augmentWithOutputSaverSavings({
      usage, provider, model,
      savedTokens, savedTokensByMechanism,
      cavemanActive, ponytailActive,
    });
    saveUsageStats({
      provider, model, tokens: usage, connectionId, apiKey,
      endpoint: clientRawRequest?.endpoint,
      latency: { ttft: totalLatency, total: totalLatency },
      savedTokens: augmented2.savedTokens,
      savedTokensByMechanism: augmented2.savedTokensByMechanism,
      savedBytesByMechanism,
      retryCount,
    });

    // Commit C: forced SSE→JSON canonical attempt from the parser's existing
    // normalized output + already extracted usage. malformedLines is
    // observation-only: a recoverable malformed event followed by valid
    // output remains success; malformed-only never reaches this point (the
    // existing parser returns null → existing public 502 is preserved).
    const canonicalAttempt = createCanonicalAttemptFromForcedSse({
      status: providerResponse.status,
      finalJson: parsed,
      usage,
      malformedLines,
      structuredContract: Boolean(body?.response_format),
    });

    saveRequestDetail(buildRequestDetail({
      ...ctx,
      latency: { ttft: totalLatency, total: totalLatency },
      tokens: usage,
      response: {
        content: parsed.choices?.[0]?.message?.content || null,
        thinking: parsed.choices?.[0]?.message?.reasoning_content || null,
        finish_reason: parsed.choices?.[0]?.finish_reason || "unknown"
      },
      status: "success"
    }, {
      endpoint: clientRawRequest?.endpoint || null,
      canonicalAttempt,
    })).catch(() => {});

    // Strip reasoning_content only when content is non-empty.
    // When content is empty (e.g. thinking models that used all tokens for reasoning),
    // reasoning_content is the only useful output and must be preserved.
    // Previously this was unconditional, which broke Qwen3.5, Claude extended thinking, etc.
    if (parsed?.choices) {
      for (const choice of parsed.choices) {
        if (choice?.message?.reasoning_content && choice.message.content) {
          delete choice.message.reasoning_content;
        }
      }
    }

    return { success: true, response: new Response(JSON.stringify(parsed), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }) };
  } catch (err) {
    // Client cancellation (stop/disconnect) aborts the upstream stream read.
    // That is expected, not an upstream failure — mirror the chatCore 499
    // convention instead of dumping a stack trace + mislabeling it a 502.
    if (err?.name === "AbortError") {
      return createErrorResult(499, "Request aborted");
    }
    console.error("[ChatCore] Chat Completions SSE→JSON failed:", err);
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, `Failed to convert streaming response to JSON: ${err?.message || err}`);
  }
}
