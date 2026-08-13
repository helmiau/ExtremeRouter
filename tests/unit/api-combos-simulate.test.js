import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "@/app/api/combos/simulate/route";

// Mock the DB-backed deps so the route is pure over fixtures.
vi.mock("@/lib/usageDb", () => ({
  getUsageHistory: vi.fn(async () => [
    { provider: "openai", model: "gpt-5.3-codex", latencyTtftMs: 500, latencyTotalMs: 1200, status: "ok" },
    { provider: "openai", model: "gpt-5.3-codex", latencyTtftMs: 600, latencyTotalMs: 1500, status: "ok" },
  ]),
}));

// getModelInfo: resolve built-in refs; unknown provider prefix → null (route
// treats it as unresolved instead of hitting the real node DB).
vi.mock("@/sse/services/model", () => ({
  getModelInfo: vi.fn(async (ref) => {
    const slash = ref.indexOf("/");
    const provider = slash > 0 ? ref.slice(0, slash) : "";
    const model = slash > 0 ? ref.slice(slash + 1) : ref;
    if (provider === "no-such-provider-xyz") return null;
    return { provider, model };
  }),
}));

const jsonReq = (body) => ({ json: async () => body });

describe("POST /api/combos/simulate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects empty models", async () => {
    const res = await POST(jsonReq({ models: [] }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/non-empty/i);
  });

  it("simulates a fusion combo with judge role and cost range", async () => {
    const res = await POST(jsonReq({
      models: ["openai/gpt-5.3-codex", "anthropic/claude-opus-4-7"],
      strategyConfig: { fallbackStrategy: "fusion" },
      inputTokens: 1000,
    }));
    expect(res.status).toBe(200);
    const { simulation, unresolved } = await res.json();
    expect(unresolved).toEqual([]);
    expect(simulation.strategy).toBe("fusion");
    expect(simulation.calls).toEqual({ min: 3, max: 3 });
    expect(simulation.maxProviderFanout).toBe(2);
    expect(simulation.capabilities.thinking).toBe(true);
    expect(simulation.estimatedCost.worst).toBeGreaterThan(0);
    // judge = panel[0]
    const gpt = simulation.memberRows.find((m) => m.fullModel === "openai/gpt-5.3-codex");
    expect(gpt.roles).toContain("judge");
  });

  it("includes per-member latency from usage history by default", async () => {
    const res = await POST(jsonReq({
      models: ["openai/gpt-5.3-codex"],
      strategyConfig: { fallbackStrategy: "fallback" },
    }));
    const { simulation } = await res.json();
    const row = simulation.memberRows[0];
    expect(row.latency).not.toBeNull();
    expect(row.latency.sampleCount).toBe(2);
    expect(row.latency.p95).toBe(1500);
  });

  it("skips latency fetch when includeLatency is false", async () => {
    const { getUsageHistory } = await import("@/lib/usageDb");
    const res = await POST(jsonReq({
      models: ["openai/gpt-5.3-codex"],
      includeLatency: false,
    }));
    expect(getUsageHistory).not.toHaveBeenCalled();
    const { simulation } = await res.json();
    expect(simulation.memberRows[0].latency).toBeNull();
  });

  it("reports unresolved refs but still simulates resolvable members", async () => {
    const res = await POST(jsonReq({
      models: ["openai/gpt-5.3-codex", "no-such-provider-xyz/foo"],
      strategyConfig: { fallbackStrategy: "fallback" },
      includeLatency: false,
    }));
    expect(res.status).toBe(200);
    const { simulation, unresolved } = await res.json();
    expect(unresolved).toContain("no-such-provider-xyz/foo");
    expect(simulation.memberRows).toHaveLength(1);
  });

  it("latency is optional — a failing usage fetch degrades to no latency, not 500", async () => {
    const { getUsageHistory } = await import("@/lib/usageDb");
    getUsageHistory.mockRejectedValueOnce(new Error("db down"));
    const res = await POST(jsonReq({ models: ["openai/gpt-5.3-codex"] }));
    expect(res.status).toBe(200);
    const { simulation } = await res.json();
    expect(simulation.memberRows[0].latency).toBeNull();
  });
});
