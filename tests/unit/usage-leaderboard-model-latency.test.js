import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getUsageStats: vi.fn(),
  getUsageHistory: vi.fn(),
  getProviderNodes: vi.fn(),
}));

vi.mock("@/lib/usageDb", () => ({
  getUsageStats: mocks.getUsageStats,
  getUsageHistory: mocks.getUsageHistory,
}));

vi.mock("@/lib/db/repos/nodesRepo", () => ({
  getProviderNodes: mocks.getProviderNodes,
}));

const { GET } = await import("../../src/app/api/usage/leaderboard/route.js");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProviderNodes.mockResolvedValue([]);
  mocks.getUsageStats.mockResolvedValue({
    byProvider: {
      openai: { requests: 200, promptTokens: 0, completionTokens: 0, cost: 0 },
    },
  });
});

describe("GET /api/usage/leaderboard per-model latency", () => {
  it("aggregates latency per model with avg/p50/p95 and sampleCount", async () => {
    // 100 rows for openai/gpt-5.3 with latencies 1..100
    // 10 rows for openai/gpt-4o with latencies 1000..1009
    const history = [];
    for (let i = 1; i <= 100; i++) history.push({ provider: "openai", model: "gpt-5.3", latencyTtftMs: i, latencyTotalMs: i, status: "ok" });
    for (let i = 1000; i <= 1009; i++) history.push({ provider: "openai", model: "gpt-4o", latencyTtftMs: i, latencyTotalMs: i, status: "ok" });
    mocks.getUsageHistory.mockResolvedValue(history);

    const res = await GET(new Request("http://localhost/api/usage/leaderboard?period=7d"));
    const data = await res.json();

    expect(data.leaderboard).toBeDefined(); // backward compatible
    const gpt53 = data.modelLatency.find((m) => m.fullModel === "openai/gpt-5.3");
    const gpt4o = data.modelLatency.find((m) => m.fullModel === "openai/gpt-4o");

    expect(gpt53).toEqual({
      provider: "openai",
      model: "gpt-5.3",
      fullModel: "openai/gpt-5.3",
      sampleCount: 100,
      avgTtft: 51,
      avgLatency: 51,
      p50: 51,
      p95: 96, // floor(0.95*100)=95 → index 95 → value 96 (existing convention)
    });
    expect(gpt4o.sampleCount).toBe(10);
    expect(gpt4o.avgLatency).toBe(1005); // round(10045/10)
    expect(gpt4o.p95).toBe(1009); // floor(0.95*10)=9 → last
    expect(gpt4o.p50).toBe(1005); // floor(5)=5 → index 5 → 1005
  });

  it("excludes rows with zero latency and merges providers into fullModel keys", async () => {
    mocks.getUsageHistory.mockResolvedValue([
      { provider: "openai", model: "gpt-5.3", latencyTtftMs: 100, latencyTotalMs: 200, status: "ok" },
      { provider: "openai", model: "gpt-5.3", latencyTtftMs: 0, latencyTotalMs: 0, status: "error" },
      { provider: "openai", model: "gpt-5.3", latencyTtftMs: 150, latencyTotalMs: 300, status: "ok" },
    ]);

    const res = await GET(new Request("http://localhost/api/usage/leaderboard?period=7d"));
    const data = await res.json();
    const entry = data.modelLatency.find((m) => m.fullModel === "openai/gpt-5.3");
    expect(entry.sampleCount).toBe(2); // zero-latency error row excluded
    expect(entry.avgLatency).toBe(250);
    // nearest-rank floor convention: floor(0.5*2) = 1 → sorted[1] = 300
    expect(entry.p50).toBe(300);
    expect(entry.p95).toBe(300);
  });

  it("keeps provider rows intact and adds p50Latency additively", async () => {
    mocks.getUsageHistory.mockResolvedValue([
      { provider: "openai", model: "gpt-5.3", latencyTtftMs: 100, latencyTotalMs: 200, status: "ok" },
      { provider: "openai", model: "gpt-5.3", latencyTtftMs: 200, latencyTotalMs: 400, status: "ok" },
    ]);

    const res = await GET(new Request("http://localhost/api/usage/leaderboard?period=7d"));
    const data = await res.json();
    const row = data.leaderboard.find((r) => r.provider === "openai");
    expect(row.requests).toBe(200);
    expect(row.avgLatency).toBe(300);
    expect(row.p50Latency).toBe(400); // floor(0.5*2)=1 → sorted[1]=400
    expect(row.p95Latency).toBe(400);
    // sample count exposed so the UI can guard p95 with insufficient-data
    expect(row.latencySampleCount).toBe(2);
    expect(row.successRate).toBe(100);
  });
});
