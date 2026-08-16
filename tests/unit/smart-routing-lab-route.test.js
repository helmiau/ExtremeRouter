// Route-level guard for the A/B Lab API: run lookup, combo fallback to routing
// reconstruction, prompt/tools overrides, and error paths (404 / 400).
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db/repos/smartRoutingRunsRepo.js", () => ({
  getSmartRunById: vi.fn(async () => null),
}));
vi.mock("@/lib/db/repos/combosRepo.js", () => ({
  getComboByName: vi.fn(async () => null),
}));
vi.mock("@/lib/usageDb", () => ({
  getUsageHistory: vi.fn(async () => []),
}));

const { getSmartRunById } = await import("@/lib/db/repos/smartRoutingRunsRepo.js");
const { getComboByName } = await import("@/lib/db/repos/combosRepo.js");
const { getUsageHistory } = await import("@/lib/usageDb");
const { POST } = await import("../../src/app/api/smart-routing/lab/route.js");

const RUN = {
  runId: "r1",
  comboName: "ai-researcher",
  promptPreview: "research the latest AI trends",
  lastUserMessage: "research the latest AI trends and cite sources from reputable publications",
  routing: {
    reason: "research_cookie_primary",
    order: ["felo-web/deepseek-v4-flash", "kr/claude-opus-4-7"],
    excludedCookies: [],
    cookiePool: ["felo-web/deepseek-v4-flash"],
    normalPool: ["kr/claude-opus-4-7"],
    intent: { intent: "research", source: "heuristic", signal: "keyword", confidence: 0.75, classifierModel: null },
  },
  servedModel: "felo-web/deepseek-v4-flash",
  status: "done",
  startedAt: 1000,
  completedAt: 5000,
  totalDurationMs: 4000,
};

const COMBO = {
  id: "c1",
  name: "ai-researcher",
  models: ["kr/claude-opus-4-7", "felo-web/deepseek-v4-flash", "glm/glm-5.1"],
  strategyConfig: {
    fallbackStrategy: "smart-routing",
    smartRouting: { cookiePoolEnabled: true, intentDetection: { confidenceThreshold: 0.6 } },
  },
};

const post = (body) => POST({ json: async () => body });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/smart-routing/lab", () => {
  it("loads a run + combo and compares all strategies with the original prompt", async () => {
    getSmartRunById.mockResolvedValueOnce(RUN);
    getComboByName.mockResolvedValueOnce(COMBO);

    const res = await post({ runId: "r1" });
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.runId).toBe("r1");
    expect(data.originalReason).toBe("research_cookie_primary");
    expect(data.comboName).toBe("ai-researcher");
    expect(data.memberCount).toBe(3);
    expect(data.request.prompt).toContain("cite sources"); // full message, not the 200-char preview
    expect(data.request.hadTools).toBe(false); // inferred from reason
    expect(data.strategies.map((s) => s.strategy)).toEqual(["fallback", "smart-routing", "swarm"]);
    const sr = data.strategies.find((s) => s.strategy === "smart-routing");
    expect(sr.reason).toBe("research_cookie_primary");
    expect(sr.order[0]).toBe("felo-web/deepseek-v4-flash");

    // Prediction-vs-reality: the run's actual outcome is attached.
    expect(data.reality.servedModel).toBe("felo-web/deepseek-v4-flash");
    expect(data.reality.status).toBe("done");
    expect(data.reality.originalReason).toBe("research_cookie_primary");
    const srMatch = data.reality.strategies.find((e) => e.strategy === "smart-routing");
    expect(srMatch.match).toBe("served");
    expect(srMatch.reasonMatch).toBe(true);
  });

  it("attaches production reliability + at-risk flags from usage history (alias-resolved)", async () => {
    getSmartRunById.mockResolvedValueOnce(RUN);
    getComboByName.mockResolvedValueOnce(COMBO);
    getUsageHistory.mockResolvedValueOnce([
      { provider: "kiro", model: "claude-opus-4-7", status: "error", latencyTotalMs: 0 },
      { provider: "kiro", model: "claude-opus-4-7", status: "ok", latencyTotalMs: 0 },
      { provider: "kiro", model: "claude-opus-4-7", status: "error", latencyTotalMs: 0 },
      { provider: "felo-web", model: "deepseek-v4-flash", status: "ok", latencyTotalMs: 0 },
      { provider: "glm", model: "glm-5.1", status: "ok", latencyTotalMs: 0 },
    ]);

    const res = await post({ runId: "r1" });
    expect(res.status).toBe(200);
    const data = await res.json();

    // Pool ref "kr/claude-opus-4-7" finds usage recorded under canonical "kiro/…".
    expect(data.reliability["kr/claude-opus-4-7"]).toMatchObject({ total: 3, ok: 1 });
    expect(data.reliability["felo-web/deepseek-v4-flash"]).toMatchObject({ total: 1, ok: 1 });
    // 1/3 = 0.33 ≤ 0.5 with ≥ 2 samples → flagged; felo-web has 1 sample → not flagged.
    expect(data.atRiskModels).toEqual(["kr/claude-opus-4-7"]);
  });

  it("still compares when usage history is unavailable (reliability empty)", async () => {
    getSmartRunById.mockResolvedValueOnce(RUN);
    getComboByName.mockResolvedValueOnce(COMBO);
    getUsageHistory.mockRejectedValueOnce(new Error("db locked"));

    const res = await post({ runId: "r1" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.reliability).toEqual({});
    expect(data.atRiskModels).toEqual([]);
    expect(data.strategies.length).toBe(3);
  });

  it("returns 404 when the run does not exist", async () => {
    getSmartRunById.mockResolvedValueOnce(null);
    const res = await post({ runId: "missing" });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain("not found");
  });

  it("reconstructs the member pool from the run when the combo was deleted", async () => {
    getSmartRunById.mockResolvedValueOnce(RUN);
    getComboByName.mockResolvedValueOnce(null); // combo gone

    const res = await post({ runId: "r1" });
    expect(res.status).toBe(200);
    const data = await res.json();
    // order + cookiePool + normalPool union, deduped → 2 members
    expect(data.memberCount).toBe(2);
    expect(data.strategies[0].order).toHaveLength(2);
  });

  it("honors prompt + hadTools + strategy overrides from the caller", async () => {
    getSmartRunById.mockResolvedValueOnce(RUN);
    getComboByName.mockResolvedValueOnce(COMBO);

    const res = await post({
      runId: "r1",
      prompt: "hello there",
      hadTools: true,
      strategies: ["fallback", "smart-routing"],
      inputTokens: 500,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.request.prompt).toBe("hello there");
    expect(data.request.hadTools).toBe(true);
    expect(data.strategies.map((s) => s.strategy)).toEqual(["fallback", "smart-routing"]);
    expect(data.assumptions.inputTokens).toBe(500);
    const sr = data.strategies.find((s) => s.strategy === "smart-routing");
    expect(sr.reason).toBe("tool_calling"); // tools override wins
    expect(sr.order).not.toContain("felo-web/deepseek-v4-flash");
  });

  it("400 when no member pool exists (no run, no combo, no routing data)", async () => {
    getSmartRunById.mockResolvedValueOnce({ ...RUN, comboName: "gone", routing: null });
    getComboByName.mockResolvedValueOnce(null);
    const res = await post({ runId: "r1" });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("no member pool");
  });

  it("400 when no prompt can be derived (combo exists but no prompt given)", async () => {
    getComboByName.mockResolvedValueOnce(COMBO);
    const res = await post({ comboName: "ai-researcher" });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("prompt");
  });
});
