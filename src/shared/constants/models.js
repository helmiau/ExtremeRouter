// Import directly from file to avoid pulling in server-side dependencies via index.js
export {
  PROVIDER_MODELS,
  getProviderModels,
  getDefaultModel,
  isValidModel as isValidModelCore,
  findModelName,
  getModelTargetFormat,
  getModelStrip,
  PROVIDER_ID_TO_ALIAS,
  getModelsByProviderId,
  getModelUpstreamId,
  getModelQuotaFamily
} from "open-sse/config/providerModels.js";

import { AI_PROVIDERS, isOpenAICompatibleProvider } from "./providers.js";
import { PROVIDER_MODELS as MODELS } from "open-sse/config/providerModels.js";

// Providers that accept any model (passthrough)
const PASSTHROUGH_PROVIDERS = new Set(
  Object.entries(AI_PROVIDERS)
    .filter(([, p]) => p.passthroughModels)
    .map(([key]) => key)
);

// Wrap isValidModel with passthrough providers
export function isValidModel(aliasOrId, modelId) {
  if (isOpenAICompatibleProvider(aliasOrId)) return true;
  if (PASSTHROUGH_PROVIDERS.has(aliasOrId)) return true;
  const models = MODELS[aliasOrId];
  if (!models) return false;
  return models.some(m => m.id === modelId);
}

// Legacy AI_MODELS for backward compatibility. Dedupe by provider/model — some
// providers (e.g. gemini) legitimately list the same model id for multiple kinds
// (LLM + STT), which would otherwise emit duplicate refs into the LLM catalog
// and break React list keys in consumers of /api/models.
export const AI_MODELS = (() => {
  const seen = new Set();
  const out = [];
  for (const [alias, models] of Object.entries(MODELS)) {
    for (const m of models) {
      const full = `${alias}/${m.id}`;
      if (seen.has(full)) continue;
      seen.add(full);
      out.push({ provider: alias, model: m.id, name: m.name });
    }
  }
  return out;
})();

export const getModelKind = (m, fallback = null) => m?.kind || m?.type || fallback;

// Capacity metadata for UI badges — icon + label + color per capability.
export const CAPACITY_META = {
  vision: { icon: "visibility", label: "Vision", desc: "Supports image input", color: "text-blue-500" },
  pdf: { icon: "description", label: "PDF", desc: "Supports PDF input", color: "text-red-500" },
  audioInput: { icon: "graphic_eq", label: "Audio", desc: "Supports audio input", color: "text-green-500" },
  videoInput: { icon: "videocam", label: "Video", desc: "Supports video input", color: "text-purple-500" },
  search: { icon: "travel_explore", label: "Web Search", desc: "Supports web search", color: "text-cyan-500" },
  reasoning: { icon: "neurology", label: "Reasoning", desc: "Supports reasoning / thinking", color: "text-amber-500" },
};
