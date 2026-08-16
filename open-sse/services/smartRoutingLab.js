/**
 * Combo Strategy A/B Lab — compares how different combo strategies would route
 * the SAME request, with the same cost model the runtime enforces.
 *
 * Pure: no DB, no network, no model calls. Member resolution is registry-based
 * (resolveProviderAlias) and cost comes from the exact runtime functions
 * (simulateCombo → estimateLeafCostUsd), so the numbers the lab shows are the
 * numbers the runtime would enforce. Smart-routing uses its heuristic-only
 * path (the classifier LLM is never invoked here — matches the default runtime
 * config where llmClassifierFallback.enabled is false), so the lab is
 * deterministic and free.
 *
 * Per-strategy result:
 *   - order          — pool order the strategy would try
 *   - primaryModel   — the model that nominally answers first
 *   - reason         — smart-routing decision reason (tool_calling, …)
 *   - excludedCookies — cookie members dropped for tool-calling requests
 *   - intent         — heuristic signal behind a research decision
 *   - calls / cost   — {min,max} calls + optimistic/worst USD (runtime model)
 *   - roleModels     — swarm manager/staff/audit refs
 *   - memberRows     — per-member cost + role rows (simulateCombo output)
 */
import { normalizeComboStrategyConfig } from "./comboConfig.js";
import { simulateCombo } from "./comboSimulator.js";
import {
  buildSmartRoutingOrder,
  detectResearchHeuristic,
  isCookieModel,
  lastUserMessageText,
  requiresToolCalling,
} from "./smartRouting.js";
import { resolveProviderAlias } from "./model.js";

/** Strategies the lab can compare (order = comparison column order). */
export const LAB_STRATEGIES = ["fallback", "smart-routing", "swarm"];

/**
 * Success rate at/below which a model is flagged as at-risk in production.
 * 0.5 = fails ≥ half its requests. Models need ≥ 2 samples before being flagged
 * (a single failure is noise, same convention as computeModelReliability).
 */
export const AT_RISK_SUCCESS_RATE = 0.5;

export const LAB_STRATEGY_META = {
  fallback: {
    label: "Fallback",
    description: "Plain ordered chain — try member 1, then 2, … until one answers.",
  },
  "smart-routing": {
    label: "Smart Routing",
    description: "Order the pool per request: tool-calling → API models only; research → cookie pool first; else default chain.",
  },
  swarm: {
    label: "Hierarchical Swarm",
    description: "Gatekeeper triage → manager strategy → parallel workers → staff audit → manager synthesis.",
  },
};

/**
 * Resolve "alias/model" member refs to the {provider, model, fullModel} shape
 * simulateCombo expects. Aliases are canonicalized (felo → felo-web) exactly
 * like the runtime execution graph does.
 */
export function resolveLabMembers(members) {
  const out = [];
  for (const ref of members || []) {
    if (typeof ref !== "string" || !ref) continue;
    const slash = ref.indexOf("/");
    const prefix = slash > 0 ? ref.slice(0, slash) : "";
    const model = slash > 0 ? ref.slice(slash + 1) : "";
    if (!prefix || !model) continue;
    out.push({ ref, provider: resolveProviderAlias(prefix), model, fullModel: ref });
  }
  return out;
}

/**
 * Simulate ONE strategy on a request. Pure (async only because smart-routing
 * ordering is async). Never throws for a valid strategy.
 */
async function simulateStrategy({ strategy, members, strategyConfig, body, inputTokens }) {
  let order = members;
  let reason = null;
  let excludedCookies = [];
  let intent = null;

  if (strategy === "smart-routing") {
    const routing = await buildSmartRoutingOrder({
      body,
      members,
      config: strategyConfig.smartRouting || {},
      // No resolveIntent → heuristic-only path (classifier never called).
    });
    order = routing.order;
    reason = routing.reason;
    excludedCookies = routing.details?.excludedCookies || [];
    const promptText = lastUserMessageText(body);
    if (promptText) {
      const h = detectResearchHeuristic(promptText, strategyConfig.smartRouting?.intentDetection || {});
      intent = { intent: h.intent, signal: h.signal, confidence: h.confidence };
    }
  }

  const sim = simulateCombo({
    members: resolveLabMembers(order),
    // Smart-routing hands the ordered pool to the fallback chain; swarm keeps
    // its own orchestration. Everything else (tuning, budgets, role models)
    // comes from the combo's normalized config.
    strategyConfig: { ...strategyConfig, fallbackStrategy: strategy },
    inputTokens,
  });

  const primaryModel =
    strategy === "swarm"
      ? sim.roleModels.manager || order[0] || null
      : order[0] || null;

  return {
    strategy,
    order,
    primaryModel,
    reason,
    excludedCookies,
    intent,
    calls: sim.calls,
    cost: {
      perCall: sim.perCallCost,
      optimistic: sim.estimatedCost.optimistic,
      worst: sim.estimatedCost.worst,
    },
    roleModels: sim.roleModels,
    memberRows: sim.memberRows,
  };
}

/**
 * Candidate keys for looking up a pool ref in outcome/reliability maps: the ref
 * itself plus its canonical alias-resolved form ("kr/..." → "kiro/..."). Usage
 * rows store the canonical provider id, pool refs may use an alias.
 */
function outcomeKeysOf(modelStr) {
  if (typeof modelStr !== "string" || !modelStr) return [];
  const slash = modelStr.indexOf("/");
  const prefix = slash > 0 ? modelStr.slice(0, slash) : "";
  const model = slash > 0 ? modelStr.slice(slash + 1) : "";
  if (!prefix || !model) return [modelStr];
  const canonical = `${resolveProviderAlias(prefix)}/${model}`;
  return canonical === modelStr ? [modelStr] : [modelStr, canonical];
}

/**
 * Match each simulated strategy's predicted first responder against what ACTUALLY
 * happened on the original run (the persisted servedModel + status).
 *
 * match ∈ "served" (prediction hit) | "different" (prediction missed — another
 * model answered) | "failed" (the real run errored — nothing answered) |
 * "no_data" (no run or still in flight).
 */
export function analyzeReality(run, rows) {
  const base = {
    servedModel: run?.servedModel || null,
    status: run?.status || null,
    error: run?.error || null,
    originalReason: run?.routing?.reason || null,
    originalOrder: Array.isArray(run?.routing?.order) ? run.routing.order : [],
    totalDurationMs: run?.totalDurationMs ?? null,
  };
  const served = base.servedModel;
  const failed = Boolean(run && (run.status === "error" || !served));

  return {
    ...base,
    // The predicted head of the pool did not answer → the chain fell through
    // (classic smart-routing story: cookie provider 403 → normal pool served).
    fellThrough: Boolean(served && base.originalOrder.length > 1 && served !== base.originalOrder[0]),
    strategies: rows.map((r) => {
      let match;
      if (!run) match = "no_data";
      else if (failed) match = "failed";
      else if (r.primaryModel === served) match = "served";
      else match = "different";
      return {
        strategy: r.strategy,
        predicted: r.primaryModel,
        match,
        // For smart-routing, also compare the simulated decision with the one
        // the runtime actually made (may differ when the request had a
        // classifier decision or tools the lab inferred differently).
        originalReason: r.strategy === "smart-routing" ? base.originalReason : null,
        reasonMatch: r.strategy === "smart-routing" && base.originalReason != null ? base.originalReason === r.reason : null,
      };
    }),
  };
}

/**
 * Compare the requested strategies on one request + member pool.
 *
 * @param {object} opts
 * @param {string} [opts.comboName] - combo label (may be null when deleted)
 * @param {string[]} opts.members - combo member refs ("provider/model")
 * @param {object} [opts.strategyConfig] - combo's normalized strategy config
 * @param {object} opts.body - reconstructed request body ({ messages, tools? })
 * @param {string[]} [opts.strategies] - subset of LAB_STRATEGIES (default all)
 * @param {number} [opts.inputTokens] - assumed input tokens per call (default 1000)
 * @param {object} [opts.reality] - the persisted run (servedModel/status/routing)
 *   for the prediction-vs-reality comparison; null when testing an ad-hoc prompt
 * @param {object} [opts.modelOutcomes] - computeModelOutcomes(usageHistory)
 *   keyed by fullModel; used to flag at-risk models + show per-model reliability
 * @returns {Promise<object>} comparison result
 */
export async function buildLabComparison({
  comboName,
  members,
  strategyConfig,
  body,
  strategies,
  inputTokens = 1000,
  reality = null,
  modelOutcomes = {},
}) {
  const cfg = normalizeComboStrategyConfig(strategyConfig || {});
  const list = (Array.isArray(strategies) ? strategies : LAB_STRATEGIES)
    .filter((s) => LAB_STRATEGIES.includes(s));

  const rows = [];
  for (const strategy of list) {
    rows.push(await simulateStrategy({ strategy, members, strategyConfig: cfg, body, inputTokens }));
  }

  const pool = {
    cookie: members.filter((m) => isCookieModel(m)),
    normal: members.filter((m) => !isCookieModel(m)),
  };

  // Per-model production reliability (30d usage) restricted to THIS pool, with
  // alias resolution so "kr/x" finds outcomes recorded under "kiro/x".
  const reliability = {};
  for (const m of members) {
    for (const key of outcomeKeysOf(m)) {
      if (modelOutcomes[key]) {
        reliability[m] = modelOutcomes[key];
        break;
      }
    }
  }
  const atRiskModels = Object.entries(reliability)
    .filter(([, o]) => o.total >= 2 && o.successRate !== null && o.successRate <= AT_RISK_SUCCESS_RATE)
    .map(([m]) => m);

  return {
    comboName: comboName || null,
    memberCount: members.length,
    request: {
      prompt: lastUserMessageText(body) || "",
      hadTools: requiresToolCalling(body),
    },
    pool,
    strategies: rows,
    reality: analyzeReality(reality, rows),
    reliability,
    atRiskModels,
    assumptions: {
      inputTokens,
      // The lab never calls the classifier — deterministic + free.
      intentDetection: "heuristic-only (classifier disabled in lab)",
    },
  };
}
