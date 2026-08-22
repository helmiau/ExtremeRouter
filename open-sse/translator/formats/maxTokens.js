// Token-budget normalization for the OpenAI intermediate format.
//
// adjustMaxTokens is a backward-compatible wrapper around resolveOutputBudget
// (the canonical token-budget resolver). It preserves the existing signature
// (body, provider, model) so existing call sites in translators keep working,
// while delegating to the single source-of-truth clamp chain.
import { DEFAULT_MAX_TOKENS, DEFAULT_MIN_TOKENS, ROUTER_MAX_OUTPUT_TOKENS } from "../../config/runtimeConfig.js";
import { resolveOutputBudget } from "../../services/tokenBudget.js";
import { extractThinkingBudgetTokens } from "../../utils/tokenEstimate.js";

/**
 * Adjust max_tokens based on request context and model capabilities.
 * Delegates to resolveOutputBudget (canonical resolver).
 *
 * @param {object} body - Request body (OpenAI intermediate format)
 * @param {string} [provider] - Provider id (e.g. "tokenrouter") for capability lookup
 * @param {string} [model] - Model id (e.g. "qwen/qwen3.8-max-free") for capability lookup
 * @returns {number} Adjusted max_tokens
 */
export function adjustMaxTokens(body, provider = null, model = null) {
  const requested = body.max_tokens != null ? body.max_tokens : null;

  const result = resolveOutputBudget({
    requestedOutputTokens: requested,
    body,
    provider,
    model,
    defaultOutputTokens: DEFAULT_MAX_TOKENS,
    routerMaxOutputTokens: ROUTER_MAX_OUTPUT_TOKENS,
  });

  let effective = result.effective;

  // Tool-calling safety: if tools are present and the budget is below the tool
  // minimum, bump to DEFAULT_MIN_TOKENS (prevents truncated tool arguments).
  // Only bumps — never exceeds model.maxOutput or routerMax (already clamped).
  if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
    if (result.modelMaxOutput != null) {
      effective = Math.max(effective, Math.min(DEFAULT_MIN_TOKENS, result.modelMaxOutput));
    } else {
      effective = Math.max(effective, DEFAULT_MIN_TOKENS);
    }
    // Re-clamp to router ceiling after tool bump
    if (ROUTER_MAX_OUTPUT_TOKENS != null && effective > ROUTER_MAX_OUTPUT_TOKENS) {
      effective = ROUTER_MAX_OUTPUT_TOKENS;
    }
  }

  return effective;
}

// Re-export the canonical resolver for providers that need full detail
export { resolveOutputBudget };

// Re-export extractThinkingBudgetTokens for callers that need it
export { extractThinkingBudgetTokens };
