import { describe, it, expect } from "vitest";
import { compareStrategies, probAtLeastK, LAB_STRATEGIES, DEFAULT_WEIGHTS } from "open-sse/services/comboLab.js";
import { estimateLeafCostUsd } from "open-sse/services/comboBudget.js";

// Same canonical fixture as combo-simulator.test.js.
const MEMBERS = [
  { provider: "openai", model: "gpt-5.3-codex", fullModel: "openai/gpt-5.3-codex" },
  { provider: "anthropic", model: "claude-opus-4-7", fullModel: "anthropic/claude-opus-4-7" },
];

const LATENCY = {
  "openai/gpt-5.3-codex": { p50: 900, p95: 1500, avgLatency: 1100, sampleCount: 40 },
  "anthropic/claude-opus-4-7": { p50: 2000, p95: 3000, avgLatency: 2500, sampleCount: 25 },
};

const RELIABILITY = {
  "openai/gpt-5.3-codex": 0.95,
  "anthropic/claude-opus-4-7": 0.9,
};

const run = (overrides = {}) =>
  compareStrategies({
    members: MEMBERS,
    inputTokens: 1000,
    latency: LATENCY,
    reliability: RELIABILITY,
    ...overrides,
  });

const byStrategy = (result, strategy) => result.strategies.find((s) => s.strategy === strategy);

describe("probAtLeastK (poisson-binomial survival)", () => {
  it("certain items satisfy the quorum outright", () => {
    expect(probAtLeastK([1, 1], 2)).toBe(1);
    expect(probAtLeastK([1, 0.5], 2)).toBe(0.5);
    expect(probAtLeastK([0, 0], 1)).toBe(0);
  });
  it("computes the survival probability for mixed rates", () => {
    expect(probAtLeastK([0.5, 0.5], 1)).toBe(0.75);
    expect(probAtLeastK([0.95, 0.9], 2)).toBeCloseTo(0.855, 10);
  });
});

describe("compareStrategies — per-strategy economics", () => {
  it("fallback: typical = first member cost/latency, reliability = failover union", () => {
    const r = run();
    const c0 = estimateLeafCostUsd("openai", "gpt-5.3-codex", 1000);
    const s = byStrategy(r, "fallback");
    expect(s.expectedCostUsd).toBeCloseTo(c0, 10);
    expect(s.wallClockP95Ms).toBe(1500);
    expect(s.reliability).toBeCloseTo(1 - 0.05 * 0.1, 10); // 0.995
  });

  it("round-robin: cost/latency = average of members, reliability = average", () => {
    const r = run();
    const c0 = estimateLeafCostUsd("openai", "gpt-5.3-codex", 1000);
    const c1 = estimateLeafCostUsd("anthropic", "claude-opus-4-7", 1000);
    const s = byStrategy(r, "round-robin");
    expect(s.expectedCostUsd).toBeCloseTo((c0 + c1) / 2, 10);
    expect(s.wallClockP95Ms).toBe(2250);
    expect(s.reliability).toBeCloseTo(0.925, 10);
  });

  it("fusion: deterministic Σ incl. judge ref, wall clock = slowest panel + judge", () => {
    const r = run();
    const c0 = estimateLeafCostUsd("openai", "gpt-5.3-codex", 1000);
    const c1 = estimateLeafCostUsd("anthropic", "claude-opus-4-7", 1000);
    const s = byStrategy(r, "fusion");
    // judge defaults to panel[0] → runtime Σ = 2c0 + c1 (no dedupe, like the budget guard)
    expect(s.expectedCostUsd).toBeCloseTo(2 * c0 + c1, 10);
    expect(s.wallClockP95Ms).toBe(3000 + 1500); // max(1500,3000) + judge 1500
    // minPanel(2) of panel + judge all succeed
    expect(s.reliability).toBeCloseTo(0.95 * 0.9 * 0.95, 10);
    expect(s.calls).toEqual({ min: 3, max: 3 });
  });

  it("swarm: workers × avg member + control refs; wall clock = 3 serial hops", () => {
    const r = run();
    const c0 = estimateLeafCostUsd("openai", "gpt-5.3-codex", 1000);
    const c1 = estimateLeafCostUsd("anthropic", "claude-opus-4-7", 1000);
    const s = byStrategy(r, "swarm");
    // workers = min(workerCount 4, members 2) = 2; control = manager+staff+audit → panel[0] ×3
    expect(s.expectedCostUsd).toBeCloseTo(2 * (c0 + c1) / 2 + 3 * c0, 10);
    expect(s.wallClockP95Ms).toBe(3000 + 1500 + 1500); // workers max + manager + audit
    expect(s.reliability).toBeCloseTo(0.95 * (0.95 * 0.9) * 0.95, 10);
  });

  it("cascade: typical = stage 1, escalate on failure", () => {
    const r = run();
    const c0 = estimateLeafCostUsd("openai", "gpt-5.3-codex", 1000);
    const s = byStrategy(r, "cascade");
    expect(s.expectedCostUsd).toBeCloseTo(c0, 10);
    expect(s.wallClockP95Ms).toBe(1500);
    expect(s.reliability).toBeCloseTo(0.95 + 0.05 * 0.9, 10);
  });
});

describe("compareStrategies — scoring & recommendation", () => {
  it("all three axes active with full data; fallback/cascade tie at top", () => {
    const r = run();
    expect(r.activeAxes.sort()).toEqual(["cost", "latency", "reliability"]);
    expect(r.recommendation).not.toBeNull();
    expect(["fallback", "cascade"]).toContain(r.recommendation.strategy);
    const top = byStrategy(r, r.recommendation.strategy);
    expect(top.score).toBeGreaterThan(byStrategy(r, "swarm").score);
  });

  it("weights flip the ranking: latency-only vs cost-only pick different winners", () => {
    // member[0] slow+cheap, member[1] fast+expensive → the single-call
    // strategies split: fallback/cascade win on cost (cheap first member),
    // round-robin wins on latency (fast average); fusion/swarm lose both
    // (panel + serial hops stack the slow leaf).
    const slowCheap = {
      latency: {
        "openai/gpt-5.3-codex": { p95: 10000, sampleCount: 20 },
        "anthropic/claude-opus-4-7": { p95: 500, sampleCount: 20 },
      },
      reliability: RELIABILITY,
    };
    const latencyOnly = run({ ...slowCheap, weights: { latency: 1, cost: 0, reliability: 0 } });
    expect(latencyOnly.recommendation.strategy).toBe("round-robin");
    expect(byStrategy(latencyOnly, "fusion").wallClockP95Ms).toBeGreaterThan(byStrategy(latencyOnly, "round-robin").wallClockP95Ms);

    const costOnly = run({ ...slowCheap, weights: { latency: 0, cost: 1, reliability: 0 } });
    expect(["fallback", "cascade"]).toContain(costOnly.recommendation.strategy);
    expect(costOnly.recommendation.strategy).not.toBe("round-robin");
  });

  it("drops axes with no data and renormalizes weights", () => {
    const r = compareStrategies({ members: MEMBERS, inputTokens: 1000, reliability: RELIABILITY });
    expect(r.activeAxes).not.toContain("latency");
    expect(r.activeAxes).toContain("cost");
    expect(r.activeAxes).toContain("reliability");
    // 0.4 : 0.2 renormalized
    expect(r.normalizedWeights.cost).toBeCloseTo(2 / 3, 10);
    expect(r.normalizedWeights.reliability).toBeCloseTo(1 / 3, 10);
    expect(Object.values(r.normalizedWeights).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it("flags invalid strategies (web-cookie control role) and excludes them from the recommendation", () => {
    const r = compareStrategies({
      members: [
        { provider: "web", model: "claude-sonnet", fullModel: "web/claude-sonnet" },
        { provider: "openai", model: "gpt-5.3-codex", fullModel: "openai/gpt-5.3-codex" },
      ],
      latency: LATENCY,
      reliability: RELIABILITY,
    });
    const fusion = byStrategy(r, "fusion");
    expect(fusion.invalid).toBe(true);
    expect(fusion.invalidReasons.length).toBeGreaterThan(0);
    expect(r.recommendation.strategy).not.toBe("fusion");
  });

  it("reports data coverage per axis", () => {
    const r = run();
    expect(r.dataCoverage.latency).toEqual({ known: 2, total: 2 });
    expect(r.dataCoverage.reliability).toEqual({ known: 2, total: 2 });
    expect(r.dataCoverage.cost.known).toBe(2);
  });

  it("empty members → empty comparison, no recommendation", () => {
    const r = compareStrategies({ members: [] });
    expect(r.strategies).toEqual([]);
    expect(r.recommendation).toBeNull();
  });

  it("surfaces live provider risk", () => {
    const r = run({
      providerHealth: { anthropic: { locked: true, breakerOpen: false } },
    });
    expect(r.atRiskProviders).toContain("anthropic");
    expect(byStrategy(r, "round-robin").atRiskProviders).toContain("anthropic");
  });

  it("defaults are exported for the UI", () => {
    expect(LAB_STRATEGIES).toEqual(["fallback", "round-robin", "fusion", "swarm", "cascade"]);
    expect(DEFAULT_WEIGHTS).toEqual({ latency: 0.4, cost: 0.4, reliability: 0.2 });
  });
});
