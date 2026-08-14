import { NextResponse } from "next/server";
import { getModelInfo } from "@/sse/services/model";
import { compareStrategies } from "open-sse/services/comboLab.js";
import { getUsageHistory } from "@/lib/usageDb";
import { aggregateModelLatency } from "@/lib/usageStats";
import { getBreakerStates } from "open-sse/services/circuitBreaker.js";
import { buildHealthOverview } from "open-sse/services/healthOverview.js";
import { getProviderConnections } from "@/lib/localDb";

export const dynamic = "force-dynamic";

// Statuses recorded in usageHistory that count as a provider SUCCESS. Everything
// else (429/404/503/0/"error"/"failed"/…) is a failure for the reliability axis.
// 499 (client abort) is excluded entirely — it is a cancellation, not a provider
// outcome (same convention as the health samples).
const SUCCESS_STATUS = new Set(["ok", "success", "200", ""]);

/**
 * POST /api/combos/lab
 *
 * Combo Lab — what-if comparison of routing strategies for a member set, using
 * historical latency + reliability + pricing, with a recommendation.
 *
 * Body:
 *   {
 *     models: ["cc/claude-opus-4-7", "gh/gpt-5.3-codex"],  // required
 *     inputTokens?: number,                                // default 1000
 *     weights?: { latency, cost, reliability },            // default 0.4/0.4/0.2
 *     strategies?: ["fallback", "fusion", ...]             // default all 5
 *   }
 *
 * Response: { comparison, recommendation, weights, normalizedWeights,
 *   activeAxes, dataCoverage, atRiskProviders }
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { models, inputTokens, weights, strategies } = body;

    if (!Array.isArray(models) || models.length === 0) {
      return NextResponse.json({ error: "models must be a non-empty array" }, { status: 400 });
    }
    const refs = models.map((m) => (typeof m === "string" ? m.trim() : "")).filter(Boolean);
    if (refs.length === 0) {
      return NextResponse.json({ error: "models must be a non-empty array" }, { status: 400 });
    }

    // Resolve refs to canonical provider/model (same path the execution graph uses).
    const resolved = [];
    for (const ref of refs) {
      try {
        const info = await getModelInfo(ref);
        if (info?.provider && info?.model) {
          resolved.push({ ref, provider: info.provider, model: info.model, fullModel: `${info.provider}/${info.model}` });
        }
      } catch { /* unresolvable ref → skipped */ }
    }
    if (resolved.length === 0) {
      return NextResponse.json({ error: "None of the model refs could be resolved" }, { status: 400 });
    }

    // Historical latency + reliability from the last 30 days of usage.
    let latency = {};
    let reliability = {};
    try {
      const history = await getUsageHistory({ period: "30d" });
      latency = aggregateModelLatency(history);
      reliability = computeModelReliability(history);
    } catch { /* optional — the lab proceeds with pricing-only estimates */ }

    // Live breaker + connection lock state (informational — flagged, not scored).
    let providerHealth = {};
    try {
      const [breakerList, connections] = await Promise.all([
        getBreakerStates(),
        getProviderConnections({ isActive: true }).catch(() => []),
      ]);
      const overview = buildHealthOverview({ healthList: [], breakerList, connections });
      for (const p of overview) {
        providerHealth[p.id] = {
          locked: p.cooldownActive === true || p.lockedConnections > 0,
          breakerOpen: p.breaker?.state === "open",
        };
      }
    } catch { /* live health is informational */ }

    const result = compareStrategies({
      members: resolved,
      strategies: Array.isArray(strategies) ? strategies : undefined,
      inputTokens: Number.isFinite(Number(inputTokens)) && Number(inputTokens) > 0 ? Number(inputTokens) : 1000,
      weights,
      latency,
      reliability,
      providerHealth,
    });

    return NextResponse.json({
      comparison: result.strategies,
      recommendation: result.recommendation,
      weights: result.weights,
      normalizedWeights: result.normalizedWeights,
      activeAxes: result.activeAxes,
      dataCoverage: result.dataCoverage,
      atRiskProviders: result.atRiskProviders,
      unresolved: refs.filter((r) => !resolved.some((m) => m.ref === r)),
    });
  } catch (error) {
    console.error("[API] Combo Lab failed:", error);
    return NextResponse.json({ error: "Combo Lab analysis failed" }, { status: 500 });
  }
}

/**
 * Per-model success rate from usage history rows. A row is a failure unless its
 * status is a known success value. 499 (client abort) rows are dropped from
 * both counts. Requires ≥ 2 samples before emitting a rate (a single sample
 * would report 100%/0% on noise).
 *
 * @param {Array<object>} history  getUsageHistory output
 * @returns {Object<string, number>} fullModel → success rate 0..1
 */
export function computeModelReliability(history) {
  const counts = {};
  for (const row of history || []) {
    if (!row?.provider || !row?.model) continue;
    const status = String(row.status || "ok").toLowerCase();
    if (status === "499") continue; // client abort — not a provider outcome
    const key = `${row.provider}/${row.model}`;
    if (!counts[key]) counts[key] = { ok: 0, total: 0 };
    counts[key].total++;
    if (SUCCESS_STATUS.has(status)) counts[key].ok++;
  }
  const out = {};
  for (const [key, c] of Object.entries(counts)) {
    if (c.total >= 2) out[key] = c.ok / c.total;
  }
  return out;
}
