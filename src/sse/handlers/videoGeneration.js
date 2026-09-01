import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { getSettings, getApiKeyByKey } from "@/lib/localDb";
import { getModelInfo } from "../services/model.js";
import { handleVideoGenerationCore } from "open-sse/handlers/videoGenerationCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { assertModelAllowed } from "../utils/modelAccess.js";

/**
 * Handle a video generation request.
 * Thin orchestrator — request-level setup, auth/ACL, provider selection and the
 * account fallback loop. Provider-specific logic lives in videoGenerationCore +
 * the videoProviders adapters.
 * @param {Request} request
 */
export async function handleVideoGeneration(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const url = new URL(request.url);
  const preferredConnectionId = request.headers.get("x-connection-id") || null;
  const binaryOutput = url.searchParams.get("response_format") === "binary";
  const origin = url.origin;
  const modelStr = body.model;

  const apiKey = extractApiKey(request);
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    const valid = await isValidApiKey(apiKey);
    if (!valid) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  }

  if (!modelStr) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");

  // ACL: enforce per-key model access (mirrors the chat/image hot path).
  if (apiKey) {
    const keyObj = await getApiKeyByKey(apiKey).catch(() => null);
    const denied = assertModelAllowed(keyObj, modelStr);
    if (denied) return denied;
  }

  return handleSingleModelVideo(body, modelStr, { preferredConnectionId, binaryOutput, origin });
}

async function handleSingleModelVideo(body, modelStr, { preferredConnectionId, binaryOutput, origin } = {}) {
  const modelInfo = await getModelInfo(modelStr).catch(() => null);
  if (!modelInfo?.provider) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }
  const { provider, model } = modelInfo;

  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, {
      preferredConnectionId,
    });

    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
      }
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    const result = await handleVideoGenerationCore({
      body,
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      binaryOutput,
      mediaResultOrigin: origin || "",
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          accessToken: newCreds.accessToken,
          refreshToken: newCreds.refreshToken,
          providerSpecificData: newCreds.providerSpecificData,
          testStatus: "active",
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
      },
    });

    if (result.success) return result.response;

    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model);

    if (shouldFallback) {
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }
}