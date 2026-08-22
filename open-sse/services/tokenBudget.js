// Canonical token-budget resolver — single source of truth for effective output tokens.
//
// Replaces scattered `Math.min(maxTokens, DEFAULT_MAX_TOKENS)` and per-provider
// ceiling logic with one deterministic clamp chain.
//
// Semantics (per ExtremeRouter token-budget spec):
//
//   effective = min(
//     requestedOutput,       // client-requested (or default if absent)
//     model.maxOutput,       // model-declared output ceiling
//     contextWindow − inputTokens − reservedTokens,  // context safety
//     routerMaxOutputTokens  // global router safety limit
//   )
//
// where:
//   - defaultOutputTokens: used ONLY when client sends no explicit value (not a hard ceiling)
//   - model.maxOutput: per-model cap from capabilities (may exceed default)
//   - routerMaxOutputTokens: explicit safety ceiling; null = no router-level cap
//   - inputTokens: estimated via conservative heuristic (no tokenizer in repo)
//   - reservedTokens: headroom reserved for system/tooling overhead (default 0)
//
// The old DEFAULT_MAX_TOKENS (64000) was used as BOTH default AND hard ceiling.
// This refactor separates the two:
//   - defaultOutputTokens = 64000 (fallback when client omits max_tokens)
//   - routerMaxOutputTokens = 128000 (explicit safety ceiling)

import { DEFAULT_MAX_TOKENS } from "../config/runtimeConfig.js";
import { getCapabilitiesForModel } from "../providers/capabilities.js";
import { estimateInputTokens, extractThinkingBudgetTokens } from "../utils/tokenEstimate.js";

/**
 * @typedef {Object} TokenBudgetResult
 * @property {number} requested     — what the client asked for (post-default)
 * @property {number} effective     — clamped output token budget to send upstream
 * @property {number} modelMaxOutput — model.maxOutput from capabilities (or null)
 * @property {number} contextWindow  — model contextWindow (or null)
 * @property {number} inputTokens    — estimated input tokens
 * @property {number} reservedTokens — reserved headroom
 * @property {number} routerMax      — router-level safety ceiling (or null)
 * @property {string} limitingFactor — which clamp won: "model_max_output" | "context_window" | "router_max" | "default" | "none"
 */

/**
 * Resolve the effective output token budget.
 *
 * @param {Object} opts
 * @param {number} [opts.requestedOutputTokens] — client-requested max_tokens (if any)
 * @param {Object} [opts.body] — raw request body (for input token estimation + thinking budget)
 * @param {string} [opts.provider] — provider id/alias for capability lookup
 * @param {string} [opts.model] — model id for capability lookup
 * @param {number} [opts.exactInputTokens] — known input token count (prefer over estimation)
 * @param {number} [opts.reservedTokens=0] — headroom reserved from contextWindow for overhead
 * @param {number} [opts.defaultOutputTokens=64000] — fallback when client omits output limit
 * @param {number} [opts.routerMaxOutputTokens=128000] — router-level safety ceiling (null = no cap)
 * @param {boolean} [opts.enforceReasoningInvariant=true] — ensure effective > thinking budget
 * @returns {TokenBudgetResult}
 */
export function resolveOutputBudget(opts) {
  const {
    requestedOutputTokens,
    body = null,
    provider = null,
    model = null,
    exactInputTokens,
    reservedTokens = 0,
    defaultOutputTokens = DEFAULT_MAX_TOKENS,
    routerMaxOutputTokens = 128000,
    enforceReasoningInvariant = true,
  } = opts;

  // 1. Requested: client value or default (NOT a ceiling)
  const requested = (requestedOutputTokens != null && requestedOutputTokens > 0)
    ? Math.floor(requestedOutputTokens)
    : defaultOutputTokens;

  // 2. Resolve model capabilities
  const caps = (provider && model) ? getCapabilitiesForModel(provider, model) : null;
  const modelMaxOutput = caps?.maxOutput ?? null;
  const contextWindow = caps?.contextWindow ?? null;

  // 3. Estimate input tokens (conservative)
  const inputTokens = estimateInputTokens(body, exactInputTokens != null ? { exactInputTokens } : {});

  // 4. Start with requested, apply clamps in order of specificity:
  //    model.maxOutput < contextWindow < router safety ceiling
  let effective = requested;
  let limitingFactor = "default";

  if (effective === defaultOutputTokens && requestedOutputTokens == null) {
    limitingFactor = "default";
  }

  // 4a. Clamp to model.maxOutput
  if (modelMaxOutput != null && effective > modelMaxOutput) {
    effective = modelMaxOutput;
    limitingFactor = "model_max_output";
  }

  // 4b. Clamp to context safety: effective ≤ contextWindow − input − reserved
  if (contextWindow != null && inputTokens > 0) {
    const available = contextWindow - inputTokens - reservedTokens;
    if (effective > available) {
      effective = available;
      limitingFactor = "context_window";
    }
  }

  // 4c. Clamp to router-level safety ceiling (null = no ceiling, 0 = disabled)
  if (routerMaxOutputTokens != null && routerMaxOutputTokens > 0 && effective > routerMaxOutputTokens) {
    effective = routerMaxOutputTokens;
    limitingFactor = "router_max";
  }

  // 4d. Reasoning/thinking invariant: effective must be strictly greater than the
  //     thinking budget tokens (Claude API requirement). Some providers (OpenAI,
  //     Gemini) share the output budget with thinking — if thinkingBudget >= effective,
  //     there would be 0 tokens left for the actual completion.
  if (enforceReasoningInvariant) {
    const thinkingBudget = extractThinkingBudgetTokens(body);
    const MIN_COMPLETION_TOKENS = 1024; // minimum non-thinking completion tokens
    if (thinkingBudget > 0 && Number.isFinite(thinkingBudget)) {
      const required = thinkingBudget + MIN_COMPLETION_TOKENS;
      if (effective < required) {
        const before = effective;
        effective = required;
        limitingFactor = "reasoning_budget";
      }
    }
  }

  // 5. Floor: never send 0 or negative (would error or produce empty response)
  if (effective < 1) {
    effective = 1;
    if (limitingFactor === "default") limitingFactor = "none";
  }

  return {
    requested,
    effective: Math.max(1, effective),
    modelMaxOutput,
    contextWindow,
    inputTokens,
    reservedTokens,
    routerMax: routerMaxOutputTokens,
    limitingFactor,
  };
}

/**
 * Convenience: just get the clamped effective number.
 * Most call sites only need the final value.
 */
export function clampOutputTokens(opts) {
  return resolveOutputBudget(opts).effective;
}
