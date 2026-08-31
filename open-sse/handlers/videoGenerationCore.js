import { createErrorResult, createErrorResultFromError, parseUpstreamError, formatProviderError } from "../utils/error.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { refreshWithRetry } from "../services/tokenRefresh.js";
import { getExecutor } from "../executors/index.js";
import { getVideoAdapter } from "./videoProviders/index.js";
import { getModelType } from "../config/providerModels.js";
import { safeFetchMediaResult } from "../utils/mediaResultDownload.js";

function serializeRequestBody(requestBody) {
  if (typeof FormData !== "undefined" && requestBody instanceof FormData) return requestBody;
  if (typeof requestBody === "string") return requestBody;
  return JSON.stringify(requestBody);
}

/**
 * Core video generation handler — orchestrator only.
 * Provider-specific URL/headers/body/parse/normalize live in `./videoProviders/{id}.js`.
 *
 * Generation is ASYNC (submit → poll) but executed in-process (blocking) so the
 * response is only produced once the task completes, times out, or fails. This
 * matches the existing image media architecture — there is no persisted job
 * table or background worker.
 *
 * @param {object} options
 * @param {object} options.body - Request body { model, prompt, duration, size, ... }
 * @param {object} options.modelInfo - { provider, model }
 * @param {object} options.credentials - Provider credentials
 * @param {object} [options.log] - Logger
 * @param {boolean} [options.binaryOutput] - Proxy the completed video bytes instead of returning URLs
 * @param {function} [options.onCredentialsRefreshed]
 * @param {function} [options.onRequestSuccess]
 * @returns {Promise<{ success: boolean, response: Response, status?: number, error?: string }>}
 */
export async function handleVideoGenerationCore({
  body,
  modelInfo,
  credentials,
  log,
  binaryOutput = false,
  onCredentialsRefreshed,
  onRequestSuccess,
}) {
  const { provider, model } = modelInfo;

  if (!body.prompt || typeof body.prompt !== "string" || !body.prompt.trim()) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, "Missing required field: prompt");
  }

  // Model-level capability gate: only models declared `kind: "video"` are
  // eligible. An image-only model (kind "image") or an untyped LLM model must
  // never reach a video adapter — `provider.video = true` is NOT the signal.
  const modelKind = getModelType(provider, model);
  if (modelKind !== "video") {
    return createErrorResult(
      HTTP_STATUS.BAD_REQUEST,
      `Model '${model}' does not support video generation`
    );
  }

  const adapter = getVideoAdapter(provider);
  if (!adapter) {
    return createErrorResult(
      HTTP_STATUS.BAD_REQUEST,
      `Provider '${provider}' does not support video generation`
    );
  }

  const buildRequest = async () => {
    const url = adapter.buildUrl(model, credentials);
    const requestBody = await adapter.buildBody(model, body);
    const headers = adapter.buildHeaders(credentials, requestBody, model, body);
    return { url, headers, requestBody };
  };

  let { url, headers, requestBody } = await buildRequest();
  log?.debug?.("VIDEO", `${provider.toUpperCase()} | ${model} | prompt="${body.prompt.slice(0, 50)}..."`);

  let providerResponse;
  try {
    providerResponse = await fetch(url, {
      method: "POST",
      headers,
      body: serializeRequestBody(requestBody),
    });
  } catch (error) {
    const errMsg = formatProviderError(error, provider, model, HTTP_STATUS.BAD_GATEWAY);
    log?.debug?.("VIDEO", `Fetch error: ${errMsg}`);
    return createErrorResultFromError(error, HTTP_STATUS.BAD_GATEWAY, errMsg);
  }

  // 401/403 — try token refresh, then retry once.
  const executor = getExecutor(provider);
  if (
    !executor?.noAuth &&
    !adapter.noAuth &&
    (providerResponse.status === HTTP_STATUS.UNAUTHORIZED ||
      providerResponse.status === HTTP_STATUS.FORBIDDEN)
  ) {
    const newCredentials = await refreshWithRetry(
      () => executor.refreshCredentials(credentials, log),
      3,
      log
    );

    if (newCredentials?.accessToken || newCredentials?.apiKey) {
      log?.info?.("TOKEN", `${provider.toUpperCase()} | refreshed for video generation`);
      Object.assign(credentials, newCredentials);
      if (onCredentialsRefreshed) await onCredentialsRefreshed(newCredentials);

      try {
        const retry = await buildRequest();
        providerResponse = await fetch(retry.url, {
          method: "POST",
          headers: retry.headers,
          body: serializeRequestBody(retry.requestBody),
        });
      } catch {
        log?.warn?.("TOKEN", `${provider.toUpperCase()} | retry after refresh failed`);
      }
    } else {
      log?.warn?.("TOKEN", `${provider.toUpperCase()} | refresh failed`);
    }
  }

  if (!providerResponse.ok) {
    const { statusCode, message } = await parseUpstreamError(providerResponse);
    const errMsg = formatProviderError(new Error(message), provider, model, statusCode);
    log?.debug?.("VIDEO", `Provider error: ${errMsg}`);
    return createErrorResult(statusCode, errMsg);
  }

  // Submit+poll is provider-specific (parseResponse reads the task id, polls to
  // completion, and may throw on FAILED/timeout/malformed/missing-output).
  let parsed;
  try {
    parsed = await adapter.parseResponse(providerResponse, { headers, log, model, body });
  } catch (error) {
    const errMsg = formatProviderError(error, provider, model, HTTP_STATUS.BAD_GATEWAY);
    log?.debug?.("VIDEO", `Generation error: ${errMsg}`);
    return createErrorResultFromError(error, HTTP_STATUS.BAD_GATEWAY, errMsg);
  }

  if (onRequestSuccess) await onRequestSuccess();

  const normalized = adapter.normalize(parsed);
  const finalBody = normalized?.created && Array.isArray(normalized?.data) ? normalized : parsed;

  // Binary output: proxy the completed video bytes through the SSRF-hardened
  // downloader (never the unguarded urlToBase64 path).
  if (binaryOutput) {
    const firstUrl = Array.isArray(finalBody?.data) ? finalBody.data[0]?.url : null;
    if (firstUrl) {
      const media = await safeFetchMediaResult(firstUrl);
      if (media) {
        return {
          success: true,
          response: new Response(media.buffer, {
            headers: {
              "Content-Type": media.mimeType,
              "Access-Control-Allow-Origin": "*",
            },
          }),
        };
      }
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Failed to download generated video");
    }
  }

  // Default: return provider URLs (same convention as the image pipeline).
  return {
    success: true,
    response: new Response(JSON.stringify(finalBody), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    }),
  };
}