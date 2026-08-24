import {
  extractApiKey, isValidApiKey,
  getProviderCredentials, markAccountUnavailable,
} from "../services/auth.js";
import { getSettings, getApiKeyByKey, getProviderNodes, getComboByName } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleTtsCore } from "open-sse/handlers/ttsCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { AI_PROVIDERS, CUSTOM_TTS_PREFIX } from "@/shared/constants/providers";
import { handleComboChat } from "open-sse/services/combo.js";
import { buildComboExecutionGraph } from "../services/comboExecutionPolicy.js";
import { createComboBudget } from "open-sse/services/comboBudget.js";
import * as log from "../utils/logger.js";
import { assertModelAllowed } from "../utils/modelAccess.js";

// Derived from providers.js: any TTS provider not noAuth requires stored credentials
const CREDENTIALED_PROVIDERS = new Set(
  Object.entries(AI_PROVIDERS)
    .filter(([, p]) => p.serviceKinds?.includes("tts") && !p.noAuth && p.ttsConfig?.authType !== "none")
    .map(([id]) => id)
);

export async function handleTts(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const url = new URL(request.url);
  const modelStr = body.model;
  const responseFormat = url.searchParams.get("response_format") || "mp3"; // mp3 (default) | json
  const language = body.language || ""; // Optional language hint (currently used by Gemini)
  log.request("POST", `${url.pathname} | ${modelStr} | format=${responseFormat}${language ? ` | lang=${language}` : ""}`);

  const apiKey = extractApiKey(request);
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    const valid = await isValidApiKey(apiKey);
    if (!valid) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  }

  if (!modelStr) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  if (!body.input) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: input");

  // ACL: enforce per-key model access (hot path, mirrors handleChat)
  if (apiKey) {
    const keyObj = await getApiKeyByKey(apiKey).catch(() => null);
    const denied = assertModelAllowed(keyObj, modelStr);
    if (denied) return denied;
  }

  // Combo expansion: model may be a combo name → run fallback/round-robin across models.
  // Gated through the same budget pre-flight as chat.js so media combos are subject
  // to logical-call / cost caps before any provider call.
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    const comboStrategies = settings.comboStrategies || {};
    const comboStrategy = comboStrategies[modelStr]?.fallbackStrategy || settings.comboStrategy || "fallback";
    const comboStickyLimit = settings.comboStickyRoundRobinLimit;

    const combo = await getComboByName(modelStr);
    let runBudget;
    if (combo) {
      const graph = await buildComboExecutionGraph(combo, comboStrategies[modelStr]);
      const budget = createComboBudget({ body, config: graph.config, leaves: graph.leaves, logicalCalls: graph.logicalCalls });
      if (!budget.ok) return errorResponse(HTTP_STATUS.BAD_REQUEST, `Combo budget rejected: ${budget.code}`);
      runBudget = budget;
    }

    log.info("TTS", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: comboModels,
      // Wave 1C: the combo engine consumes ChatResult — wrap this pipeline's
      // bare-Response result so success derives from Response.ok as before.
      handleSingleModel: async (b, m) => {
        const r = await handleSingleModelTts(b, m, responseFormat, language, apiKey);
        return { success: r.ok, status: r.status, response: r };
      },
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
      runBudget,
    });
  }

  return handleSingleModelTts(body, modelStr, responseFormat, language, apiKey);
}

async function handleSingleModelTts(body, modelStr, responseFormat, language, apiKey) {
  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");

  const { provider, model } = modelInfo;
  log.info("ROUTING", `Provider: ${provider}, Voice: ${model}`);

  // Self-hosted TTS node (custom-tts-*) — baseUrl lives on the node, gateway API
  // key doubles as bearer when set. OpenAI-compatible POST /v1/audio/speech.
  if (provider.startsWith(CUSTOM_TTS_PREFIX)) {
    const node = (await getProviderNodes({ type: "custom-tts" })).find((n) => n.id === provider);
    if (!node?.baseUrl) return errorResponse(HTTP_STATUS.BAD_GATEWAY, "Self-hosted TTS node has no baseUrl");
    const credentials = { providerSpecificData: { baseUrl: node.baseUrl }, ...(apiKey ? { apiKey } : {}) };
    const result = await handleTtsCore({ provider, model, input: body.input, credentials, responseFormat, language });
    if (result.success) return result.response;
    return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "TTS failed");
  }

  // noAuth providers — no credential needed
  if (!CREDENTIALED_PROVIDERS.has(provider)) {
    const result = await handleTtsCore({ provider, model, input: body.input, responseFormat, language });
    if (result.success) return result.response;
    return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "TTS failed");
  }

  // Credentialed providers — fallback loop (same pattern as embeddings)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model);

    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const msg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        return unavailableResponse(status, `[${provider}/${model}] ${msg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    log.info("AUTH", `\x1b[32mUsing ${provider} account: ${credentials.connectionName}\x1b[0m`);

    const result = await handleTtsCore({ provider, model, input: body.input, credentials, responseFormat, language });

    if (result.success) return result.response;

    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model);
    if (shouldFallback) {
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }
    return result.response || errorResponse(result.status, result.error);
  }
}
