// Canonical token-budget resolver — single source of truth for effective output tokens.
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
// Hard constraints MUST always dominate soft constraints/heuristics.
// Heuristics (tool defaults, reasoning requirements) may INFLUENCE the desired
// budget but CANNOT override a previously established hard ceiling.
//
// When hard constraints make a request infeasible, the resolver returns
// feasible: false with effective: 0 instead of fabricating tokens.

import { DEFAULT_MAX_TOKENS, ROUTER_MAX_OUTPUT_TOKENS } from "../config/runtimeConfig.js";
import { getCapabilitiesForModel } from "../providers/capabilities.js";
import { estimateInputTokens, extractThinkingBudgetTokens } from "../utils/tokenEstimate.js";

/**
 * @typedef {Object} TokenBudgetConstraints
 * @property {number|null} modelMaxOutput
 * @property {number|null} providerMaxOutput
 * @property {number|null} routerMaxOutput
 * @property {number|null} contextWindow
 * @property {number} inputTokens
 * @property {number} reservedTokens
 * @property {number} availableContext
 */

/**
 * @typedef {Object} TokenBudgetResult
 * @property {number} requestedOutputTokens — what the client explicitly asked for (null if not provided)
 * @property {number} desiredOutputTokens — requested OR default (what we'd like to send)
 * @property {number} hardMaxOutputTokens — min of all known hard ceilings
 * @property {number} effectiveOutputTokens — final clamped value to send upstream (0 if infeasible)
 * @property {boolean} feasible — whether the request can produce valid output
 * @property {string} limitingFactor — which constraint determined the effective value
 * @property {TokenBudgetConstraints} constraints — all constraint values for debugging
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
 * @param {number} [opts.defaultOutputTokens=64000] — fallback when client omits output limit AND no tools
 * @param {number} [opts.toolAwareDefaultOutputTokens] — fallback when client omits output limit AND tools present
 * @param {number} [opts.routerMaxOutputTokens=128000] — router-level safety ceiling (null = no cap)
 * @param {boolean} [opts.enforceReasoningInvariant=true] — ensure effective > thinking budget (but never violate hard ceilings)
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
    toolAwareDefaultOutputTokens,
    routerMaxOutputTokens = ROUTER_MAX_OUTPUT_TOKENS,
    enforceReasoningInvariant = true,
  } = opts;

  // 1. Requested: what client explicitly asked for (null = not provided)
  const hasExplicitRequest = (requestedOutputTokens != null && requestedOutputTokens > 0);
  const requested = hasExplicitRequest ? Math.floor(requestedOutputTokens) : null;

  // 2. Resolve model capabilities
  const caps = (provider && model) ? getCapabilitiesForModel(provider, model) : null;
  const modelMaxOutput = caps?.maxOutput ?? null;
  const contextWindow = caps?.contextWindow ?? null;

  // 3. Estimate input tokens (conservative)
  const inputTokens = estimateInputTokens(body, exactInputTokens != null ? { exactInputTokens } : {});

  // 3b. Calculate available context (can be negative)
  let availableContext = null;
  if (contextWindow != null && inputTokens >= 0) {
    availableContext = contextWindow - inputTokens - reservedTokens;
  }

  // 4. Desired budget: explicit request OR tool-aware default (if tools present) OR normal default
  // This is the ONLY place where "desired" is determined — no post-resolution bumps allowed
  let desired;
  if (requested != null) {
    desired = requested; // explicit client limit always wins as desired
  } else {
    const hasTools = body && Array.isArray(body.tools) && body.tools.length > 0;
    desired = hasTools && toolAwareDefaultOutputTokens != null
      ? toolAwareDefaultOutputTokens
      : defaultOutputTokens;
  }

  // 5. Compute HARD maximum from all known hard ceilings
  // These are ABSOLUTE — no heuristic may increase effective beyond these
  const hardCeilings = [];
  if (modelMaxOutput != null) hardCeilings.push(modelMaxOutput);
  if (routerMaxOutputTokens != null && routerMaxOutputTokens > 0) hardCeilings.push(routerMaxOutputTokens);
  if (availableContext != null) hardCeilings.push(availableContext);
  // Provider-specific max would go here if/when available

  const hardMax = hardCeilings.length > 0 ? Math.min(...hardCeilings) : null;

  // 6. Effective = min(desired, hardMax) — but never negative
  // If hardMax is null (no known ceilings), effective = desired
  let effective = hardMax != null ? Math.min(desired, hardMax) : desired;
  if (effective < 0) effective = 0;

  // 7. Determine limiting factor(s) (for debugging)
  // Track ALL active constraints, not just the first match.
  // Primary limiter = the constraint that determined effective value
  // Co-limiters = other constraints with equal value
  const activeLimiters = [];
  if (effective < desired) {
    if (modelMaxOutput != null && effective === modelMaxOutput) activeLimiters.push("model_max_output");
    if (routerMaxOutputTokens != null && effective === routerMaxOutputTokens) activeLimiters.push("router_max_output");
    if (availableContext != null && effective === availableContext) activeLimiters.push("context_window");
  } else if (!hasExplicitRequest) {
    activeLimiters.push("default");
  }

  // Primary limiter: first active limiter (deterministic precedence order)
  // Co-limiters: remaining active limiters
  // 8. Apply reasoning/thinking invariant — BUT NEVER EXCEED HARD CEILINGS
  // If thinking budget requires more than hardMax allows, the request is INFEASIBLE
  // for that reasoning configuration. We do NOT silently violate hardMax.
  let reasoningFeasible = true;
  if (enforceReasoningInvariant && body) {
    const thinkingBudget = extractThinkingBudgetTokens(body);
    const MIN_COMPLETION_TOKENS = 1024;
    if (thinkingBudget > 0 && Number.isFinite(thinkingBudget)) {
      const requiredForReasoning = thinkingBudget + MIN_COMPLETION_TOKENS;
      if (effective < requiredForReasoning) {
        // Reasoning requirement exceeds what hard constraints allow
        reasoningFeasible = false;
        // When reasoning infeasibility is the PRIMARY cause of infeasibility,
        // make it the primary limiter (moves to front of activeLimiters)
        activeLimiters.unshift("reasoning_exceeds_hard_ceiling");
        // DO NOT increase effective — hard ceiling wins
        // The caller can decide to fail or reduce thinking budget
      }
    }
  }

  // 7b. Determine limiting factor(s) AFTER reasoning check
  // The limiting factor is what actually constrained the effective value
  const limitingFactor = activeLimiters[0] ?? "none";
  const limitingFactors = activeLimiters;

  // 9. Feasibility determination
  // Context exhausted = no room for ANY completion tokens
  const contextExhausted = (availableContext != null && availableContext <= 0);
  // Hard max exhausted = hard ceiling is 0 or negative
  const hardMaxExhausted = (hardMax != null && hardMax <= 0);

  // Feasible = we can allocate at least 1 token AND reasoning can be satisfied
  // Note: effective keeps the hard ceiling value even if reasoning is infeasible
  // Only context/hardMax exhaustion forces effective to 0
  const feasible = effective >= 1 && reasoningFeasible && !contextExhausted && !hardMaxExhausted;

  // 10. If context/hardMax exhausted, effective is 0 (not 1)
  // But if only reasoning is infeasible, effective keeps the hard ceiling value
  // (caller sees effective=hardMax, feasible=false, limitingFactor=reasoning_exceeds_hard_ceiling)
  const finalEffective = (contextExhausted || hardMaxExhausted) ? 0 : Math.max(1, effective);

  return {
    requestedOutputTokens: requested,
    desiredOutputTokens: desired,
    hardMaxOutputTokens: hardMax,
    effectiveOutputTokens: finalEffective,
    feasible,
    limitingFactor, // primary limiter for backward compatibility
    limitingFactors, // all active constraints
    constraints: {
      modelMaxOutput,
      providerMaxOutput: null, // reserved for future provider-specific limits
      routerMaxOutput: routerMaxOutputTokens,
      contextWindow,
      inputTokens,
      reservedTokens,
      availableContext,
    },
  };
}

/**
 * Convenience: just get the clamped effective number.
 * Returns 0 if infeasible.
 */
export function clampOutputTokens(opts) {
  return resolveOutputBudget(opts).effectiveOutputTokens;
}

/**
 * Check feasibility without computing full budget (lighter weight).
 */
export function checkFeasibility(opts) {
  return resolveOutputBudget(opts).feasible;
}