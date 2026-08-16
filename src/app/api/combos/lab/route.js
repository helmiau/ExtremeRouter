import { NextResponse } from "next/server";
import { getModelInfo } from "@/sse/services/model";
import { compareStrategies } from "open-sse/services/comboLab.js";
import { getUsageHistory } from "@/lib/usageDb";
import { aggregateModelLatency, computeModelReliability } from "@/lib/usageStats";
import { getBreakerStates } from "open-sse/services/circuitBreaker.js";
import { buildHealthOverview } from "open-sse/services/healthOverview.js";
import { getProviderConnections } from "@/lib/localDb";

export const dynamic = "force-dynamic";

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
    });    } catch (error) {
    console.error("[API] Combo Lab failed:", error);
    return NextResponse.json({ error: "Combo Lab analysis failed" }, { status: 500 });
  }
}

