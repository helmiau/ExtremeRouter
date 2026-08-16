import { NextResponse } from "next/server";
import { getSmartRunById } from "@/lib/db/repos/smartRoutingRunsRepo.js";
import { getComboByName } from "@/lib/db/repos/combosRepo.js";
import { getUsageHistory } from "@/lib/usageDb";
import { computeModelOutcomes } from "@/lib/usageStats";
import { buildLabComparison, LAB_STRATEGIES } from "open-sse/services/smartRoutingLab.js";

export const dynamic = "force-dynamic";

/** Reasons that prove the original request carried tools. */
const TOOL_CALLING_REASONS = new Set(["tool_calling", "tool_calling_pool_empty_fallback"]);

const dedupe = (arr) => [...new Set(arr.filter(Boolean))];

/**
 * POST /api/smart-routing/lab — A/B compare combo strategies on ONE request.
 *
 * Picks a request from smart-routing history (or any prompt), then simulates
 * fallback vs smart-routing vs swarm on the same member pool, showing which
 * model would answer first + the runtime cost estimate for each strategy.
 *
 * Body:
 *   {
 *     runId?: string,          // pick request from history (loads prompt + combo)
 *     comboName?: string,      // override/select combo (by name) instead
 *     prompt?: string,         // editable prompt (defaults to the run's text)
 *     hadTools?: boolean,      // simulate a tool-calling request
 *     strategies?: string[],   // subset of LAB_STRATEGIES (default all 3)
 *     inputTokens?: number     // assumed input tokens per call (default 1000)
 *   }
 *
 * Response: { comboName, memberCount, request, pool, strategies, assumptions,
 *   runId, originalReason }
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const { runId, comboName: comboNameParam, prompt, hadTools, strategies, inputTokens } = body;

    let comboName = typeof comboNameParam === "string" && comboNameParam.trim() ? comboNameParam.trim() : null;
    let run = null;
    if (runId) {
      run = await getSmartRunById(runId);
      if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });
      comboName = run.comboName || comboName;
    }

    // Member pool: prefer the live combo definition; reconstruct from the run's
    // routing arrays when the combo was deleted since the request was served.
    let combo = null;
    if (comboName) {
      combo = await getComboByName(comboName);
    }
    let members = combo && Array.isArray(combo.models) && combo.models.length > 0 ? combo.models : null;
    if (!members && run?.routing) {
      members = dedupe([
        ...(run.routing.order || []),
        ...(run.routing.excludedCookies || []),
        ...(run.routing.cookiePool || []),
        ...(run.routing.normalPool || []),
      ]);
    }
    if (!members || members.length === 0) {
      return NextResponse.json(
        { error: "no member pool available — combo not found and run has no routing data" },
        { status: 400 },
      );
    }

    const promptText = typeof prompt === "string" && prompt.trim()
      ? prompt.trim()
      : (run?.lastUserMessage || run?.promptPreview || "");
    if (!promptText.trim()) {
      return NextResponse.json({ error: "prompt is required" }, { status: 400 });
    }

    // Reconstruct the tool-calling signal: the user's toggle wins; otherwise
    // infer it from the original routing decision.
    const originalHadTools = run?.routing?.reason ? TOOL_CALLING_REASONS.has(run.routing.reason) : false;
    const useTools = typeof hadTools === "boolean" ? hadTools : originalHadTools;

    const requestBody = {
      messages: [{ role: "user", content: promptText }],
      ...(useTools
        ? { tools: [{ type: "function", function: { name: "lab_probe", description: "A/B Lab tool-calling probe" } }] }
        : {}),
    };

    // Production reliability per model (30d usage) — powers the prediction-vs-
    // reality comparison + at-risk flags. Optional: the lab proceeds with no
    // reliability data when the history query fails.
    let modelOutcomes = {};
    try {
      const history = await getUsageHistory({ period: "30d" });
      modelOutcomes = computeModelOutcomes(history);
    } catch {
      // reliability is informational — never block the comparison
    }

    const result = await buildLabComparison({
      comboName,
      members,
      strategyConfig: combo ? combo.strategyConfig : {},
      body: requestBody,
      strategies: Array.isArray(strategies) && strategies.length > 0 ? strategies : LAB_STRATEGIES,
      inputTokens: Number.isFinite(Number(inputTokens)) && Number(inputTokens) > 0 ? Number(inputTokens) : 1000,
      reality: run,
      modelOutcomes,
    });

    return NextResponse.json({
      ...result,
      runId: run?.runId || null,
      originalReason: run?.routing?.reason || null,
    });
  } catch (error) {
    console.error("[API] Smart-routing A/B lab failed:", error);
    return NextResponse.json({ error: "Lab comparison failed" }, { status: 500 });
  }
}
