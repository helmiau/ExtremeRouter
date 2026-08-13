import { NextResponse } from "next/server";
import { getModelInfo } from "@/sse/services/model";
import { simulateCombo } from "open-sse/services/comboSimulator.js";
import { getUsageHistory } from "@/lib/usageDb";
import { aggregateModelLatency } from "@/lib/usageStats";

export const dynamic = "force-dynamic";

/**
 * POST /api/combos/simulate
 *
 * Pre-save combo simulation: logical calls (nominal..worst), cost estimate,
 * capability compatibility, per-member latency, control-role violations and
 * budget rejection risk — composed from the exact runtime functions, so the
 * numbers shown before saving are the numbers the runtime enforces after.
 *
 * Request body:
 *   {
 *     models: ["cc/claude-opus-4-7", "gh/gpt-5.3-codex"],   // required
 *     strategyConfig?: {...},                                // defaults to fallback
 *     inputTokens?: number,                                  // default 1000
 *     includeLatency?: boolean                               // default true
 *   }
 *
 * Response:
 *   { simulation: { strategy, members, calls, maxProviderFanout, estimatedCost,
 *     perCallCost, budgetRisk, budgetsEnabled, capabilities, roleModels,
 *     roleViolations, memberRows, assumptions } }
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { models, strategyConfig, inputTokens, includeLatency = true } = body;

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
      } catch { /* unresolvable ref → skipped below */ }
    }

    let latency = {};
    if (includeLatency !== false) {
      try {
        const history = await getUsageHistory({ period: "30d" });
        latency = aggregateModelLatency(history);
      } catch { /* latency is optional — simulation proceeds without it */ }
    }

    const simulation = simulateCombo({
      members: resolved,
      strategyConfig: strategyConfig || {},
      inputTokens: Number.isFinite(Number(inputTokens)) && Number(inputTokens) > 0 ? Number(inputTokens) : 1000,
      latency,
    });

    return NextResponse.json({ simulation, unresolved: refs.filter((r) => !resolved.some((m) => m.ref === r)) });
  } catch (error) {
    console.error("[API] Combo simulate failed:", error);
    return NextResponse.json({ error: "Simulation failed" }, { status: 500 });
  }
}
