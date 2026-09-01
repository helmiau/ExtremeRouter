import { ERROR_TYPES, DEFAULT_ERROR_MESSAGES } from "../config/errorConfig.js";
import { ANTHROPIC_API_VERSION } from "../providers/shared.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";

/**
 * Build OpenAI-compatible error response body
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @param {string} [code] - Optional explicit error code override (e.g. media-result codes)
 * @returns {object} Error response object
 */
export function buildErrorBody(statusCode, message, code) {
  const errorInfo = ERROR_TYPES[statusCode] || 
    (statusCode >= 500 
      ? { type: "server_error", code: "internal_server_error" }
      : { type: "invalid_request_error", code: "" });

  return {
    error: {
      message: message || DEFAULT_ERROR_MESSAGES[statusCode] || "An error occurred",
      type: errorInfo.type,
      code: code || errorInfo.code
    }
  };
}

/**
 * Create error Response object (for non-streaming)
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @param {string} [code] - Optional explicit error code override
 * @returns {Response} HTTP Response object
 */
export function errorResponse(statusCode, message, code) {
  return new Response(JSON.stringify(buildErrorBody(statusCode, message, code)), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      // Required by Anthropic SDK/CLI — validates the streaming/protocol version
      // even on error responses (Claude clients abort without it).
      "anthropic-version": ANTHROPIC_API_VERSION
    }
  });
}

/**
 * Write error to SSE stream (for streaming)
 * @param {WritableStreamDefaultWriter} writer - Stream writer
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 */
export async function writeStreamError(writer, statusCode, message) {
  const errorBody = buildErrorBody(statusCode, message);
  const encoder = new TextEncoder();
  // event: error — named event so SSE clients (Claude/OpenAI) dispatch it as an
  // error instead of treating the data frame as a message/parse failure.
  await writer.write(encoder.encode(`event: error\ndata: ${JSON.stringify(errorBody)}\n\n`));
}

/**
 * Parse upstream provider error response
 * @param {Response} response - Fetch response from provider
 * @param {object} [executor] - Optional executor with parseError() override for provider-specific parsing
 * @returns {Promise<{statusCode: number, message: string, resetsAtMs?: number}>}
 */
export async function parseUpstreamError(response, executor = null) {
  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    bodyText = "";
  }

  // Let executor-specific parser extract provider-specific fields (e.g. codex resetsAtMs)
  if (executor && typeof executor.parseError === "function") {
    try {
      const parsed = executor.parseError(response, bodyText);
      if (parsed && typeof parsed === "object") {
        const msg = parsed.message || DEFAULT_ERROR_MESSAGES[response.status] || `Upstream error: ${response.status}`;
        // Non-JSON upstream bodies (e.g. zed 500 "An internal server error occurred")
        // surfaced via rawBody so the failure stays debuggable instead of lossy.
        const raw = parsed.rawBody ? ` (raw: ${parsed.rawBody})` : "";
        return { statusCode: parsed.status || response.status, message: msg + raw, resetsAtMs: parsed.resetsAtMs };
      }
    } catch { /* fall through to default parsing */ }
  }

  let message = "";
  try {
    const json = JSON.parse(bodyText);
    message = json.error?.message || json.message || json.error || bodyText;
  } catch {
    message = bodyText;
  }

  const messageStr = typeof message === "string" ? message : JSON.stringify(message);
  const finalMessage = messageStr || DEFAULT_ERROR_MESSAGES[response.status] || `Upstream error: ${response.status}`;

  return { statusCode: response.status, message: finalMessage };
}

/**
 * Normalized internal result envelope returned by handleChatCore. A single
 * source of truth for "did the provider call produce a logical response" so
 * callers (handleSingleModelChat) branch on one contract instead of mixing
 * Response.ok and a custom success boolean.
 *
 * Success paths carry { success:true, response } plus optional metadata
 * (fromCache / url / headers / transformedBody / cacheSimilarity).
 * Error paths carry { success:false, status, error, response, resetsAtMs? }.
 *
 * @typedef {Object} ChatResult
 * @property {boolean} success - logical success (true for a usable response, false for an error)
 * @property {Response} response - HTTP Response to stream back to the client
 * @property {number} [status] - provider HTTP status code (error path)
 * @property {string} [error] - human-readable error message (error path)
 * @property {number} [resetsAtMs] - precise cooldown expiry (quota errors)
 * @property {boolean} [fromCache] - true if served from semantic cache
 * @property {string} [url] - provider URL ("(cache)" for cache hits)
 * @property {object} [headers] - provider response headers
 * @property {*} [transformedBody] - request body after translation
 * @property {number} [cacheSimilarity] - jaccard similarity for cache near-hits
 */

/**
 * Construct a ChatResult envelope. Centralizes the result shape so every
 * return path of handleChatCore (and the sub-handlers it delegates to) carries
 * an explicit `success` boolean — the gap that let cache-hit results be
 * misread as failures (fixed in P1). Use this for success returns;
 * createErrorResult covers the failure side.
 * @param {Object} opts
 * @param {boolean} opts.success
 * @param {Response} opts.response
 * @param {Object} [rest] - additional metadata (fromCache, url, headers, …)
 * @returns {ChatResult}
 */
export function buildChatResult({ success, response, ...rest }) {
  return {
    success,
    response,
    ...rest,
    // Commit D: additive universal canonical-attempt field on the ChatResult
    // envelope. Defaults to null — a path only sets it when the corresponding
    // adapter actually produced a canonical attempt. Never fabricated.
    canonicalAttempt: rest.canonicalAttempt ?? null,
  };
}

/**
 * Encode a bare HTTP error Response as a ChatResult. Wave 1B compatibility
 * boundary: bounds where a caller already produced a `Response` (e.g. the
 * nested-combo path inside handleSingleModelChat) can be adapted to the
 * envelope without constructing a new error Response.
 * @param {Response} response - existing error Response (non-2xx)
 * @returns {ChatResult}
 */
export function chatResultFromErrorResponse(response, status) {
  const effective = status ?? response?.status ?? 500;
  return buildChatResult({ success: false, status: effective, response, error: `HTTP ${effective}` });
}

/**
 * Create error result for chatCore handler
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @param {number} [resetsAtMs] - Optional precise cooldown expiry (ms epoch) for provider-specific quota errors
 * @returns {ChatResult}
 */
export function createErrorResult(statusCode, message, resetsAtMs, options = {}) {
  return buildChatResult({
    success: false,
    status: statusCode,
    error: message,
    resetsAtMs,
    response: errorResponse(statusCode, message),
    canonicalAttempt: options.canonicalAttempt ?? null,
    // G2-D.2: shared retry accounting — executor transport retries ride on the
    // envelope so the semantic retry gate consumes the same budget.
    retryCount: options.retryCount,
  });
}

/**
 * Create an error result from a thrown exception, mapping client aborts to 499.
 *
 * Codebase convention (chatCore.js): an AbortError means the request was
 * cancelled — a client stop/disconnect, or a combo closing a straggler leaf —
 * NOT a provider failure. Returning 502 for it would mislabel the cancellation
 * and (via markAccountUnavailable) lock a healthy account for the cooldown.
 * All other exceptions keep the caller's status (default 502).
 *
 * @param {Error} error - The thrown exception
 * @param {number} [statusCode=502] - Status for non-abort failures
 * @param {string} [message] - Override message (defaults to error.message);
 *   ignored for aborts, which always report "Request aborted"
 * @returns {{ success: false, status: number, error: string, response: Response }}
 */
export function createErrorResultFromError(error, statusCode = HTTP_STATUS.BAD_GATEWAY, message) {
  const isAbort = error?.name === "AbortError";
  const status = isAbort ? 499 : statusCode;
  const msg = isAbort ? "Request aborted" : (message || error?.message || "Request failed");
  return createErrorResult(status, msg);
}

/**
 * Create unavailable response when all accounts are rate limited
 * @param {number} statusCode - Original error status code
 * @param {string} message - Error message (without retry info)
 * @param {string} retryAfter - ISO timestamp when earliest account becomes available
 * @param {string} retryAfterHuman - Human-readable retry info e.g. "reset after 30s"
 * @returns {Response}
 */
export function unavailableResponse(statusCode, message, retryAfter, retryAfterHuman) {
  const retryAfterSec = Math.max(Math.ceil((new Date(retryAfter).getTime() - Date.now()) / 1000), 1);
  const msg = `${message} (${retryAfterHuman})`;
  return new Response(
    JSON.stringify({ error: { message: msg, type: "server_error", code: "service_unavailable" } }),
    {
      status: statusCode,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSec)
      }
    }
  );
}

/**
 * Format provider error with context
 * @param {Error} error - Original error
 * @param {string} provider - Provider name
 * @param {string} model - Model name
 * @param {number|string} statusCode - HTTP status code or error code
 * @returns {string} Formatted error message
 */
export function formatProviderError(error, provider, model, statusCode) {
  const code = statusCode || error.code || "FETCH_FAILED";
  const message = error.message || "Unknown error";
  // Expose low-level cause (e.g. UND_ERR_SOCKET, ECONNRESET, ETIMEDOUT) for diagnosing fetch failures
  const causeCode = error.cause?.code;
  const causeMsg = error.cause?.message;
  const causeStr = causeCode || causeMsg ? ` (cause: ${[causeCode, causeMsg].filter(Boolean).join(": ")})` : "";
  return `[${code}]: ${message}${causeStr}`;
}
