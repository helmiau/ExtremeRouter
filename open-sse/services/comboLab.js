// Combo Lab — what-if engine that compares combo strategies side-by-side and
// recommends the best one for a given member set.
//
// Pure: every input is injected (no DB/network), so it is unit-testable. It
// composes the runtime's own building blocks (simulateCombo, estimateLeafCostUsd,
// normalizeComboStrategyConfig) so the numbers shown here are the same formulas
// the runtime enforces — zero drift, same philosophy as comboSimulator.js.
//
// Each strategy is simulated with its DEFAULT tuning (the lab answers "which
// strategy fits these members best?", not "how should I tune fusion?"):
//   fallback   → tries members in order until one succeeds
//   round-robin→ rotates members across requests
//   fusion     → parallel panel (minPanel) + judge synthesis (deterministic)
//   swarm      → manager → workers → staff audit → manager synthesis
//   cascade    → escalate cheap→capable on low confidence
//
// Three axes are scored (user-weightable), each normalized 0..1 relative to
// the best strategy in the comparison:
//   latency     — expected wall-clock p95 per request (parallel fanout is
//                 modeled as the slowest in-flight leaf + serial hops)
//   cost        — expected USD per request (typical call count, NOT worst case)
//   reliability — expected success probability per request from usage history
// Axes with no usable data are dropped and the remaining weights renormalized.

import { normalizeComboStrategyConfig } from "./comboConfig.js";
import { simulateCombo } from "./comboSimulator.js";
import { estimateLeafCostUsd } from "./comboBudget.js";

/** The five strategies the lab compares (same set the runtime supports). */
export const LAB_STRATEGIES = ["fallback", "round-robin", "fusion", "swarm", "cascade"];

/** Default axis weights — latency/cost dominate, reliability a tie-breaker. */
export const DEFAULT_WEIGHTS = { latency: 0.4, cost: 0.4, reliability: 0.2 };

/**
 * Reliability assumed for a member with no usage history. 0.9 (not 1.0) so a
 * brand-new member cannot out-rank proven ones on the reliability axis just
 * because it has never failed. The UI surfaces dataCoverage so the user knows
 * which members are assumed.
 */
export const UNKNOWN_RELIABILITY = 0.9;

const clamp01 = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null);

const p95Of = (lat) => (lat && typeof lat.p95 === "number" && lat.p95 > 0 ? lat.p95 : null);

/**
 * Poisson-binomial survival: P(at least k of the items succeed) when item i
 * succeeds with probability probs[i]. Computed with a small DP over the count
 * of successes (items are treated as independent — a documented simplification
 * for provider-unrelated failures).
 */
export function probAtLeastK(probs, k) {
  const list = probs.filter((p) => typeof p === "number" && p > 0 && p < 1);
  const certain = probs.filter((p) => p >= 1).length;
  const needed = Math.max(0, k - certain);
  if (needed <= 0) return 1;
  if (list.length < needed) return 0;
  let dp = [1];
  for (const p of list) {
    const next = new Array(dp.length + 1).fill(0);
    for (let i = 0; i < dp.length; i++) {
      next[i] += dp[i] * (1 - p);
      next[i + 1] += dp[i] * p;
    }
    dp = next;
  }
  let sum = 0;
  for (let i = needed; i < dp.length; i++) sum += dp[i];
  return Math.min(1, sum);
}

/**
 * Median fallback for a member missing latency data: use the median of the
 * members that DO have p95 data, so a partially-covered panel still gets a
 * sensible wall-clock estimate. Returns null when no member has data.
 */
function medianP95(members, latency) {
  const known = members.map((m) => p95Of(latency[m.fullModel])).filter((v) => v != null).sort((a, b) => a - b);
  if (known.length === 0) return null;
  const mid = Math.floor(known.length / 2);
  return known.length % 2 ? known[mid] : Math.round((known[mid - 1] + known[mid]) / 2);
}

/**
 * Compare strategies for a resolved member set.
 *
 * @param {object} params
 * @param {Array<{provider: string, model: string, fullModel: string}>} params.members
 * @param {string[]} [params.strategies]  subset of LAB_STRATEGIES (default all)
 * @param {number} [params.inputTokens]   assumed input tokens per call
 * @param {object} [params.weights]       { latency, cost, reliability } (default DEFAULT_WEIGHTS)
 * @param {object} [params.latency]       fullModel → { p50, p95, ... } (aggregateModelLatency)
 * @param {object} [params.reliability]   fullModel → success rate 0..1 (usage history)
 * @param {object} [params.providerHealth] provider → { locked?, breakerOpen? } (live state)
 * @returns {object} ranked comparison + recommendation (see below)
 */
export function compareStrategies({
  members = [],
  strategies,
  inputTokens = 1000,
  weights = {},
  latency = {},
  reliability = {},
  providerHealth = {},
} = {}) {
  const list = (strategies && strategies.length ? strategies : LAB_STRATEGIES)
    .filter((s) => LAB_STRATEGIES.includes(s))
    .slice(0, LAB_STRATEGIES.length);
  const w = { ...DEFAULT_WEIGHTS, ...weights };

  if (!Array.isArray(members) || members.length === 0) {
    return {
      strategies: [],
      recommendation: null,
      weights: w,
      activeAxes: [],
      normalizedWeights: {},
      dataCoverage: { latency: { known: 0, total: 0 }, reliability: { known: 0, total: 0 }, cost: { known: 0, total: 0 } },
      atRiskProviders: [],
    };
  }

  const costOf = (m) => estimateLeafCostUsd(m.provider, m.model, inputTokens);
  const relOf = (fullModel) => clamp01(reliability[fullModel]) ?? UNKNOWN_RELIABILITY;
  const providerAtRisk = (fullModel) => {
    const provider = fullModel.split("/")[0];
    const h = providerHealth[provider];
    return h && (h.locked === true || h.breakerOpen === true);
  };

  // Per-strategy simulation with default tuning (role models default to panel[0],
  // mirroring buildComboExecutionGraph). Config fields users might set on the
  // combo are NOT carried over — the lab compares stock strategies.
  const strategiesOut = list.map((strategy) => {
    const config = normalizeComboStrategyConfig({ fallbackStrategy: strategy });
    const sim = simulateCombo({ members, strategyConfig: config, inputTokens, latency });

    const avgCost = members.length ? members.reduce((s, m) => s + costOf(m), 0) / members.length : 0;
    const costs = members.map(costOf);
    const probs = members.map((m) => relOf(m.fullModel));
    const knownP95 = members.map((m) => p95Of(latency[m.fullModel]));
    const median = medianP95(members, latency);

    const p95 = (fullModel) => p95Of(latency[fullModel]) ?? median;

    let expectedCostUsd;
    let wallClockP95Ms;
    let reliabilityP;
    switch (strategy) {
      case "fallback": {
        // Typical request succeeds on the first member.
        expectedCostUsd = costs[0] ?? 0;
        wallClockP95Ms = p95(members[0]?.fullModel);
        reliabilityP = probs.length ? 1 - probs.reduce((acc, p) => acc * (1 - p), 1) : null;
        break;
      }
      case "round-robin": {
        // Each member is equally likely per request.
        expectedCostUsd = avgCost;
        const known = knownP95.filter((v) => v != null);
        wallClockP95Ms = known.length ? Math.round(known.reduce((a, b) => a + b, 0) / known.length) : null;
        reliabilityP = probs.reduce((s, p) => s + p, 0) / Math.max(1, probs.length);
        break;
      }
      case "fusion": {
        // Deterministic: full panel + judge. Wall clock = slowest panel leaf
        // (parallel) + judge (serial after the panel).
        expectedCostUsd = sim.budgetRisk.estimatedCostUsd; // runtime Σ incl. judge ref
        const panelP95 = Math.max(...knownP95.filter((v) => v != null), 0) || null;
        const judgeP95 = p95(sim.roleModels.judge);
        wallClockP95Ms = panelP95 != null && judgeP95 != null ? panelP95 + judgeP95 : null;
        const minPanel = config.fusionTuning.minPanel;
        reliabilityP = probAtLeastK(probs, minPanel) * relOf(sim.roleModels.judge);
        break;
      }
      case "swarm": {
        // Workers = up to workerCount members (parallel), then staff audit +
        // manager synthesis are serial hops. Expected cost = workers × avg
        // member + control refs (each once).
        const workersActive = Math.min(config.workerCount, Math.max(1, members.length));
        const controlRefs = Object.values(sim.roleModels);
        const controlCost = controlRefs.reduce((s, ref) => s + costOf({ provider: ref.split("/")[0], model: ref.split("/").slice(1).join("/") }), 0);
        expectedCostUsd = workersActive * avgCost + controlCost;
        const workerP95 = Math.max(...knownP95.filter((v) => v != null), 0) || null;
        const mgrP95 = p95(sim.roleModels.manager);
        const audP95 = p95(sim.roleModels.audit);
        wallClockP95Ms = workerP95 != null && mgrP95 != null && audP95 != null ? workerP95 + mgrP95 + audP95 : null;
        const quorum = config.swarmTuning.workerQuorum;
        reliabilityP = relOf(sim.roleModels.manager) * probAtLeastK(probs, quorum) * relOf(sim.roleModels.audit);
        break;
      }
      case "cascade": {
        // Typical request is answered confidently by stage 1; escalate to stage
        // 2 only on failure/low confidence.
        expectedCostUsd = costs[0] ?? 0;
        wallClockP95Ms = p95(members[0]?.fullModel);
        const p0 = probs[0] ?? UNKNOWN_RELIABILITY;
        const p1 = probs[1] ?? 0;
        reliabilityP = p0 + (1 - p0) * p1;
        break;
      }
      default:
        expectedCostUsd = 0;
        wallClockP95Ms = null;
        reliabilityP = null;
    }

    // Control-role violations (e.g. a web-cookie member as fusion judge) make a
    // strategy un-runnable as configured — flag it and keep it out of the winner
    // pool rather than silently ranking it.
    const roleViolations = sim.roleViolations || [];
    const invalid = roleViolations.length > 0;

    const atRiskProviders = [...new Set([...members, ...Object.values(sim.roleModels)].map((r) => (typeof r === "string" ? r : r.fullModel).split("/")[0]).filter((p) => providerAtRisk(`${p}/x`)))];

    return {
      strategy,
      label: strategy,
      calls: sim.calls,
      expectedCalls: (sim.calls.min + sim.calls.max) / 2,
      maxProviderFanout: sim.maxProviderFanout,
      perCallCost: sim.perCallCost,
      expectedCostUsd,
      wallClockP95Ms,
      reliability: reliabilityP != null ? Math.min(1, Math.max(0, reliabilityP)) : null,
      invalid,
      invalidReasons: roleViolations.map((v) => v.reason),
      atRiskProviders,
      capabilities: sim.capabilities,
    };
  });

  // ── Scoring: normalize each axis relative to the best strategy with data ──
  // Invalid strategies (control-role violations) are kept in the output so the
  // UI can show WHY they are excluded, but they never enter the scoring pool or
  // the recommendation — ranked last with score 0.
  const valid = strategiesOut.filter((s) => !s.invalid);
  const invalidRows = strategiesOut.filter((s) => s.invalid);
  const withLatency = valid.filter((s) => s.wallClockP95Ms != null);
  const withCost = valid.filter((s) => typeof s.expectedCostUsd === "number" && s.expectedCostUsd > 0);
  const withReliability = valid.filter((s) => s.reliability != null);

  const axisActive = {
    latency: withLatency.length > 1 && withLatency.some((s) => s.wallClockP95Ms !== withLatency[0].wallClockP95Ms),
    cost: withCost.length > 1 && withCost.some((s) => s.expectedCostUsd !== withCost[0].expectedCostUsd),
    reliability: withReliability.length > 1 && withReliability.some((s) => s.reliability !== withReliability[0].reliability),
  };

  const bestLatency = axisActive.latency ? Math.min(...withLatency.map((s) => s.wallClockP95Ms)) : null;
  const bestCost = axisActive.cost ? Math.min(...withCost.map((s) => s.expectedCostUsd)) : null;
  const bestReliability = axisActive.reliability ? Math.max(...withReliability.map((s) => s.reliability)) : null;

  // Renormalize weights over the active axes (a dropped axis's weight is
  // redistributed proportionally among the remaining ones).
  const activeKeys = Object.keys(axisActive).filter((k) => axisActive[k]);
  const rawSum = activeKeys.reduce((s, k) => s + (w[k] || 0), 0);
  const normWeights = {};
  for (const k of activeKeys) normWeights[k] = rawSum > 0 ? (w[k] || 0) / rawSum : 1 / activeKeys.length;

  const scored = valid.map((s) => {
    const scores = {};
    if (axisActive.latency) scores.latency = bestLatency > 0 ? bestLatency / s.wallClockP95Ms : 1;
    if (axisActive.cost) scores.cost = bestCost > 0 ? bestCost / s.expectedCostUsd : 1;
    if (axisActive.reliability) scores.reliability = bestReliability > 0 ? s.reliability / bestReliability : 1;
    let score = 0;
    for (const k of activeKeys) score += normWeights[k] * (scores[k] ?? 0);
    return { ...s, scores, score, scoreParts: Object.fromEntries(activeKeys.map((k) => [k, scores[k]])) };
  });

  scored.sort((a, b) => b.score - a.score || String(a.strategy).localeCompare(String(b.strategy)));

  // Invalid rows at the bottom, after the ranked pool.
  for (const s of invalidRows) scored.push({ ...s, score: 0, scores: {}, scoreParts: {} });

  // ── Recommendation with a human-readable reason ──
  let recommendation = null;
  if (scored.length > 0 && scored[0].score > 0) {
    const top = scored[0];
    const runner = scored[1] || null;
    const wins = [];
    const close = [];
    if (axisActive.latency) {
      const d = runner ? runner.wallClockP95Ms - top.wallClockP95Ms : 0;
      if (d > 100) wins.push(`latency (~${top.wallClockP95Ms}ms vs ${runner.wallClockP95Ms}ms)`);
      else close.push("latency");
    }
    if (axisActive.cost) {
      const d = runner ? runner.expectedCostUsd - top.expectedCostUsd : 0;
      if (d > 0.001) wins.push(`cost ($${top.expectedCostUsd.toFixed(4)} vs $${runner.expectedCostUsd.toFixed(4)})`);
      else close.push("cost");
    }
    if (axisActive.reliability) {
      const d = runner ? top.reliability - runner.reliability : 0;
      if (d > 0.002) wins.push(`reliability (${(top.reliability * 100).toFixed(1)}% vs ${(runner.reliability * 100).toFixed(1)}%)`);
      else close.push("reliability");
    }
    let reason;
    if (wins.length === activeKeys.length) {
      reason = `Best on all axes — ${wins.join(", ")}.`;
    } else if (wins.length > 0) {
      const rest = close.length ? `; ${close.join(" & ")} competitive` : "";
      reason = `Best overall — wins on ${wins.join(", ")}${rest}.`;
    } else {
      reason = `Best balance — no axis dominates, ${activeKeys.map((k) => k).join("/")} all within range.`;
    }
    recommendation = {
      strategy: top.strategy,
      score: top.score,
      reason,
      runnerUp: runner ? { strategy: runner.strategy, score: runner.score } : null,
    };
  }

  const coverage = {
    latency: { known: members.filter((m) => p95Of(latency[m.fullModel]) != null).length, total: members.length },
    reliability: { known: members.filter((m) => clamp01(reliability[m.fullModel]) != null).length, total: members.length },
    cost: { known: members.filter((m) => costOf(m) > 0).length, total: members.length },
  };

  return {
    strategies: scored,
    recommendation,
    weights: { ...DEFAULT_WEIGHTS, ...w },
    activeAxes: activeKeys,
    normalizedWeights: normWeights,
    dataCoverage: coverage,
    atRiskProviders: [...new Set(members.map((m) => m.fullModel.split("/")[0]).filter((p) => providerAtRisk(`${p}/x`)))],
  };
}
