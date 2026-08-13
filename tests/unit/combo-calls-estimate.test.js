import { describe, it, expect } from "vitest";
import { estimateLogicalCalls, estimateCallsRange } from "../../open-sse/services/comboConfig.js";

describe("estimateLogicalCalls (worst case for runtime budget cap)", () => {
  it("fallback tries every member until one succeeds", () => {
    expect(estimateLogicalCalls({ fallbackStrategy: "fallback" }, 3)).toBe(3);
  });

  it("round-robin has the same worst case as fallback (failover loop)", () => {
    expect(estimateLogicalCalls({ fallbackStrategy: "round-robin" }, 3)).toBe(3);
  });

  it("fusion = all panel members + judge", () => {
    expect(estimateLogicalCalls({ fallbackStrategy: "fusion" }, 3)).toBe(4);
  });

  it("swarm = gatekeeper + manager + workers + audit + synthesis (workers + 4)", () => {
    // default workerCount is 4 → 4 + 4 = 8 (a full complex pipeline).
    expect(estimateLogicalCalls({ fallbackStrategy: "swarm" }, 2)).toBe(8);
    expect(estimateLogicalCalls({ fallbackStrategy: "swarm", workerCount: 6 }, 2)).toBe(10);
  });

  it("swarm workerCount is capped at maxWorkers (8)", () => {
    expect(estimateLogicalCalls({ fallbackStrategy: "swarm", workerCount: 99 }, 2)).toBe(12);
  });

  it("cascade = stages tried, capped by maxStages", () => {
    expect(estimateLogicalCalls({ fallbackStrategy: "cascade", cascade: { maxStages: 3 } }, 5)).toBe(3);
    expect(estimateLogicalCalls({ fallbackStrategy: "cascade" }, 2)).toBe(2);
  });

  it("never returns less than 1", () => {
    expect(estimateLogicalCalls({ fallbackStrategy: "fallback" }, 0)).toBe(1);
  });
});

describe("estimateCallsRange (nominal..worst for pre-save simulation)", () => {
  it("fallback ranges 1..memberCount (first model usually succeeds)", () => {
    expect(estimateCallsRange({ fallbackStrategy: "fallback" }, 3)).toEqual({ min: 1, max: 3 });
  });

  it("round-robin ranges 1..memberCount", () => {
    expect(estimateCallsRange({ fallbackStrategy: "round-robin" }, 3)).toEqual({ min: 1, max: 3 });
  });

  it("fusion is deterministic (min === max = members + 1)", () => {
    expect(estimateCallsRange({ fallbackStrategy: "fusion" }, 3)).toEqual({ min: 4, max: 4 });
  });

  it("swarm ranges 1..workers+4 (gatekeeper short-circuits simple requests)", () => {
    // A 4-worker swarm: 1 call for a simple request, 8 for a full complex
    // pipeline (gatekeeper + manager + 4 workers + audit + synthesis).
    expect(estimateCallsRange({ fallbackStrategy: "swarm", workerCount: 4 }, 2)).toEqual({ min: 1, max: 8 });
  });

  it("cascade ranges 1..min(members, maxStages)", () => {
    expect(estimateCallsRange({ fallbackStrategy: "cascade", cascade: { maxStages: 3 } }, 5)).toEqual({ min: 1, max: 3 });
  });

  it("worst bound always matches estimateLogicalCalls (no drift)", () => {
    for (const cfg of [
      { fallbackStrategy: "fallback" },
      { fallbackStrategy: "round-robin" },
      { fallbackStrategy: "fusion" },
      { fallbackStrategy: "swarm", workerCount: 6 },
      { fallbackStrategy: "cascade", cascade: { maxStages: 2 } },
    ]) {
      expect(estimateCallsRange(cfg, 4).max).toBe(estimateLogicalCalls(cfg, 4));
    }
  });
});
