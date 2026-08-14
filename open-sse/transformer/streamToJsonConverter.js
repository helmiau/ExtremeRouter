/**
 * Stream-to-JSON Converter
 * Converts Responses API SSE stream to single JSON response.
 * Used when client requests non-streaming but provider forces streaming (e.g. Codex).
 *
 * Uses the shared ResponsesAccumulator (createResponsesAccumulator +
 * finalizeResponsesAccumulator) for item correlation + terminal output
 * reconstruction — the same accumulator the streaming translator uses,
 * ensuring consistent output/usage/error handling between both paths.
 */

import {
  createResponsesAccumulator,
  finalizeResponsesAccumulator,
} from "../translator/concerns/responsesAccumulator.js";

const EMPTY_RESPONSE = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

function streamFailure(code, message) {
  return { type: "stream_error", code, message };
}

/**
 * Process a single SSE message through the shared accumulator.
 */
function processSSEMessage(msg, accumulator) {
  if (!msg.trim()) return;

  const eventMatch = msg.match(/^event:\s*(.+)$/m);
  const dataMatch = msg.match(/^data:\s*(.+)$/m);
  if (!dataMatch) return;

  const eventType = eventMatch?.[1]?.trim();
  const dataStr = dataMatch[1].trim();
  if (dataStr === "[DONE]") return;

  let parsed;
  try { parsed = JSON.parse(dataStr); }
  catch { return; }

  accumulator.ingest(eventType || parsed.type, parsed);
}

/**
 * Convert Responses API SSE stream to single JSON response.
 * @param {ReadableStream} stream - SSE stream from provider
 * @returns {Promise<Object>} Final JSON response in Responses API format
 */
export async function convertResponsesStreamToJson(stream) {
  const accumulator = createResponsesAccumulator();

  if (!stream || typeof stream.getReader !== "function") {
    const terminal = finalizeResponsesAccumulator(accumulator, {
      error: streamFailure("invalid_stream", "response stream is unavailable"),
    });
    return { ...terminal.response, usage: { ...EMPTY_RESPONSE } };
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let readError = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const messages = buffer.split("\n\n");
      buffer = messages.pop() || "";

      for (const msg of messages) {
        processSSEMessage(msg, accumulator);
      }
    }

    // Flush remaining buffer (last event may not end with \n\n)
    if (buffer.trim()) {
      processSSEMessage(buffer, accumulator);
    }
  } catch (error) {
    // Client cancellation must propagate to the caller (which maps AbortError
    // → 499), not be swallowed into a generic stream_read_error response —
    // an abort is expected, not an upstream failure.
    if (error?.name === "AbortError") throw error;
    readError = error;
  } finally {
    reader.releaseLock();
  }

  // Finalize: if the stream threw or closed without a terminal event, mark
  // the accumulator as failed with the appropriate error. This preserves
  // partial output + exactly-once failure semantics.
  if (readError || !accumulator.status) {
    finalizeResponsesAccumulator(accumulator, {
      error: readError
        ? streamFailure("stream_read_error", readError.message || "stream read failed")
        : streamFailure("stream_disconnected", "stream closed before response.completed"),
      status: "failed",
    });
  }

  const { response } = finalizeResponsesAccumulator(accumulator);

  // Usage: from response.completed if captured, else zeros.
  const usage = accumulator.usage
    ? { input_tokens: accumulator.usage.input_tokens, output_tokens: accumulator.usage.output_tokens, total_tokens: accumulator.usage.total_tokens }
    : { ...EMPTY_RESPONSE };

  return { ...response, usage };
}
