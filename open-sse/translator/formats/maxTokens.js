// Token-budget normalization for the OpenAI intermediate format.
//
// adjustMaxTokens is a backward-compatible wrapper around resolveOutputBudget
// (the canonical token-budget resolver). It preserves the existing signature
// (body, provider, model) so existing call sites in translators keep working,
// while delegating to the single source-of-truth clamp chain.

import { DEFAULT_MAX_TOKENS, DEFAULT_MIN_TOKENS, ROUTER_MAX_OUTPUT_TOKENS } from "../../config/runtimeConfig.js";
import { resolveOutputBudget, clampOutputTokens } from "../../services/tokenBudget.js";

/**
 * Adjust max_tokens based on request context and model capabilities.
 * Delegates to resolveOutputBudget (canonical resolver).
 *
 * KEY SEMANTICS:
 * - If user EXPLICITLY provides max_tokens: respect it (clamp only to hard ceilings)
 * - If user does NOT provide max_tokens: use default (64K), then apply tool-aware default if tools present
 * - Hard ceilings (model.maxOutput, routerMax, context) ALWAYS win
 * - Returns 0 if request is infeasible (context exhausted)
 *
 * @param {object} body - Request body (OpenAI intermediate format)
 * @param {string} [provider] - Provider id (e.g. "tokenrouter") for capability lookup
 * @param {string} [model] - Model id (e.g. "qwen/qwen3.8-max-free") for capability lookup
 * @returns {number} Adjusted max_tokens (0 if infeasible)
 */
export function adjustMaxTokens(body, provider = null, model = null) {
  const hasExplicitMaxTokens = body.max_tokens != null && body.max_tokens > 0;
  const requested = hasExplicitMaxTokens ? body.max_tokens : null;

  const result = resolveOutputBudget({
    requestedOutputTokens: requested,
    body,
    provider,
    model,
    defaultOutputTokens: DEFAULT_MAX_TOKENS,
    routerMaxOutputTokens: ROUTER_MAX_OUTPUT_TOKENS,
    enforceReasoningInvariant: true,
  });

  let effective = result.effectiveOutputTokens;

  // Tool-calling default: ONLY applies when user did NOT specify max_tokens
  // If user explicitly set max_tokens=4096, we respect it — even if tools are present
  // The provider may return truncation/tool failure, but we don't silently override the user
  if (!hasExplicitMaxTokens && body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
    // User didn't specify → we can choose a tool-aware default
    // But it must still obey hard ceilings (already enforced by resolver)
    const toolDefault = DEFAULT_MIN_TOKENS;
    effective = Math.max(effective, toolDefault);
    // Re-clamp to router ceiling (though resolver already did this)
    if (ROUTER_MAX_OUTPUT_TOKENS != null && effective > ROUTER_MAX_OUTPUT_TOKENS) {
      effective = ROUTER_MAX_OUTPUT_TOKENS;
    }
  }

  return effective;
}

// Re-export the canonical resolver for providers that need full detail
export { resolveOutputBudget, clampOutputTokens, checkFeasibility };

// Re-export extractThinkingBudgetTokens for callers that need it
export { extractThinkingBudgetTokens } from "../../utils/tokenEstimate.js";