// Combo Simulator — pre-save simulation of a combo configuration.
//
// Pure: every input is passed in (no DB/network). It composes the runtime's
// own building blocks so the numbers shown BEFORE saving are exactly the
// numbers the runtime uses AFTER saving (zero drift):
//   • estimateCallsRange       → logical calls (nominal..worst)
//   • deriveComboCapabilities  → capability compatibility
//   • estimateLeafCostUsd      → per-leaf cost (same formula createComboBudget
//     uses to reject with combo_cost_budget_exceeded)
//   • validateComboRoles       → control-role violations (same as the
//     create/update combo routes and the runtime)
//   • latency map (aggregateModelLatency) → per-member expected p50/p95
//
// Role models mirror buildComboExecutionGraph: fusion judge = judgeModel ||
// panel[0]; swarm manager/staff/audit cascade down to panel[0]. These refs are
// included in `leaves` so the cost estimate accounts for the control calls a
// fusion/swarm request actually makes.

import { normalizeComboStrategyConfig, estimateCallsRange } from "./comboConfig.js";
import { estimateLeafCostUsd } from "./comboBudget.js";
import { getPricingForModel } from "../providers/pricing.js";
import { getCapabilitiesForModel } from "../providers/capabilities.js";
import { deriveComboCapabilities } from "../providers/comboCapabilities.js";
import { validateComboRoles } from "./providerCapabilities.js";

/** Default assumption: output tokens per leaf call (matches comboBudget.js). */
export const SIMULATED_OUTPUT_TOKENS = 4000;

/**
 * Resolve the control-role model refs for a normalized strategy config, mirroring
 * buildComboExecutionGraph's cascade (role || panel[0]).
 * @returns {Object<string, string>} role → model ref ("" when strategy has no roles)
 */
export function resolveRoleModels(config, members) {
  const first = (Array.isArray(members) && members[0]) || "";
  if (config.fallbackStrategy === "fusion") {
    return { judge: config.judgeModel || first };
  }
  if (config.fallbackStrategy === "swarm") {
    return {
      manager: config.managerModel || first,
      staff: config.staffModel || config.managerModel || first,
      audit: config.auditModel || config.staffModel || config.managerModel || first,
    };
  }
  return {};
}

/**
 * Simulate ONE request of a combo. Pure — no I/O.
 *
 * @param {object} params
 * @param {Array<{provider: string, model: string, fullModel: string}>} params.members
 *   resolved combo members (the route resolves refs via getModelInfo).
 * @param {object} params.strategyConfig  merged combo strategy config (normalized
 *   internally; same normalizeComboStrategyConfig the runtime applies).
 * @param {number} [params.inputTokens]  assumed input tokens per call (default 1000).
 * @param {object} [params.latency]  modelLatency map keyed by fullModel
 *   "provider/model" (aggregateModelLatency output) — optional.
 * @returns {object} simulation result (see below).
 */
export function simulateCombo({ members = [], strategyConfig = {}, inputTokens = 1000, latency = {} }) {
  const config = normalizeComboStrategyConfig(strategyConfig);
  const strategy = config.fallbackStrategy;
  const memberCount = members.length;
  const calls = estimateCallsRange(config, memberCount);

  // Leaf set = members + control roles (fusion judge / swarm manager·staff·audit),
  // deduped by fullModel. Mirror of the execution graph's leaves.
  const roleModels = resolveRoleModels(config, members.map((m) => m.fullModel));
  const seen = new Set();
  const leaves = [];
  const pushLeaf = (fullModel) => {
    if (!fullModel || seen.has(fullModel)) return;
    seen.add(fullModel);
    leaves.push(fullModel);
  };
  for (const m of members) pushLeaf(m.fullModel);
  for (const roleRef of Object.values(roleModels)) pushLeaf(roleRef);

  // Per-leaf economics — same formula createComboBudget uses for the runtime cap.
  const leafCosts = leaves.map((fullModel) => {
    const slash = fullModel.indexOf("/");
    const provider = slash > 0 ? fullModel.slice(0, slash) : "";
    const model = slash > 0 ? fullModel.slice(slash + 1) : fullModel;
    return {
      fullModel,
      costPerCall: estimateLeafCostUsd(provider, model, inputTokens),
      pricing: getPricingForModel(provider, model) || null,
    };
  });
  const perCall = leafCosts.reduce((sum, l) => sum + l.costPerCall, 0);
  const estimatedCost = {
    optimistic: perCall * calls.min,
    worst: perCall * calls.max,
  };

  // Budget rejection risk — the runtime rejects when budgets.enabled AND the
  // worst-case cost exceeds maxEstimatedCostUsd (same comparison, same formula).
  const limits = config.budgets;
  let budgetRisk = { level: "ok", rejected: false };
  if (limits.enabled && limits.maxEstimatedCostUsd < Infinity) {
    const limit = limits.maxEstimatedCostUsd;
    budgetRisk = estimatedCost.worst > limit
      ? { level: "rejected", rejected: true, limit, estimatedCostUsd: estimatedCost.worst }
      : { level: "ok", rejected: false, limit };
  }

  // Control-role capability violations (web-cookie providers cannot judge/manage).
  const roleViolations = validateComboRoles(strategy, config, members.map((m) => m.fullModel));

  // Capability compatibility — union modalities / min limits over the members.
  const capabilities = deriveComboCapabilities(
    members.map((m) => getCapabilitiesForModel(m.provider, m.model)),
    config,
  );

  // Per-member detail rows for the UI (role badges, cost, latency).
  const memberRows = members.map((m) => {
    const caps = getCapabilitiesForModel(m.provider, m.model);
    const pricing = getPricingForModel(m.provider, m.model);
    const lat = latency[m.fullModel] || null;
    const roles = Object.entries(roleModels)
      .filter(([, ref]) => ref === m.fullModel)
      .map(([role]) => role);
    return {
      fullModel: m.fullModel,
      provider: m.provider,
      model: m.model,
      roles,
      capabilities: {
        thinking: caps.reasoning === true,
        vision: caps.vision === true,
        audio: caps.audioInput === true,
        pdf: caps.pdf === true,
        tools: caps.tools === true,
        contextWindow: caps.contextWindow ?? null,
      },
      costPerCall: estimateLeafCostUsd(m.provider, m.model, inputTokens),
      hasPricing: Boolean(pricing),
      latency: lat
        ? { p50: lat.p50, p95: lat.p95, avg: lat.avgLatency, sampleCount: lat.sampleCount }
        : null,
    };
  });

  return {
    strategy,
    members: memberCount,
    calls,
    maxProviderFanout: strategy === "swarm"
      ? Math.min(memberCount, config.swarmTuning?.maxWorkers || memberCount)
      : strategy === "fusion"
        ? memberCount
        : 1,
    estimatedCost,
    perCallCost: perCall,
    budgetRisk,
    budgetsEnabled: limits.enabled,
    capabilities,
    roleModels,
    roleViolations,
    memberRows,
    assumptions: {
      inputTokens,
      outputTokens: SIMULATED_OUTPUT_TOKENS,
    },
  };
}
