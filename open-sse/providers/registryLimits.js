// Registry-declared per-model token limits — provider-scoped evidence.
//
// Provider registry entries (open-sse/providers/registry/*.js) may declare
// `contextWindow` / `maxOutput` on individual models. Those numbers come from
// the provider's own catalog or docs for THAT endpoint, so they are more
// specific than a family wildcard in capabilities.js: GitHub Copilot serves
// claude-opus-4.7 with a 64k output cap even though Anthropic's own API allows
// 128k, and Forge serves gpt-5.6-sol with a different window than the ChatGPT
// backend does.
//
// Before this module existed the values were declared but never reached the
// runtime, so Token Budget used family-pattern numbers instead and the
// dashboard (which reads the registry field directly via /v1/models/info)
// disagreed with what the router actually enforced.
//
// SCOPE: limits only. Registry entries do not describe vision / reasoning /
// thinking, so this is an overlay on top of the capability resolution rather
// than a replacement for it.

import REGISTRY from "./registry/index.js";

// canonical provider id -> model id -> { contextWindow?, maxOutput? }
const REGISTRY_LIMITS = (() => {
  const table = {};
  for (const entry of REGISTRY) {
    if (!Array.isArray(entry.models)) continue;
    for (const raw of entry.models) {
      if (typeof raw === "string") continue; // terse form carries no limits
      // Registries predate the canonical field names and use two spellings
      // (kiro: contextLength/maxOutputTokens, github: contextWindow/maxOutput).
      // Accept both — canonical name wins when a model declares both.
      const ctx = raw.contextWindow ?? raw.contextLength;
      const out = raw.maxOutput ?? raw.maxOutputTokens;
      const hasCtx = typeof ctx === "number" && Number.isFinite(ctx) && ctx > 0;
      const hasOut = typeof out === "number" && Number.isFinite(out) && out > 0;
      if (!hasCtx && !hasOut) continue;

      const limits = {};
      if (hasCtx) limits.contextWindow = ctx;
      // A model cannot emit more tokens than its window holds. Registries are
      // hand-maintained and occasionally carry an output value copied from a
      // sibling with a larger window; clamping keeps the pair self-consistent
      // instead of handing Token Budget an impossible ceiling.
      if (hasOut) limits.maxOutput = hasCtx ? Math.min(out, ctx) : out;

      (table[entry.id] ||= {})[raw.id] = limits;
    }
  }
  return table;
})();

/**
 * Registry-declared limits for a canonical provider id + model id.
 * @param {string} providerId - canonical provider id (already alias-resolved)
 * @param {string} modelId - model id as it appears in the registry
 * @returns {{contextWindow?: number, maxOutput?: number}|null}
 */
export function getRegistryLimits(providerId, modelId) {
  if (!providerId || !modelId) return null;
  return REGISTRY_LIMITS[providerId]?.[modelId] ?? null;
}

export { REGISTRY_LIMITS };
