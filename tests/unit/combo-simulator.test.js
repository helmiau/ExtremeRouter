import { describe, it, expect } from "vitest";
import { simulateCombo, resolveRoleModels } from "open-sse/services/comboSimulator.js";
import { estimateLeafCostUsd } from "open-sse/services/comboBudget.js";

// Resolved member fixture — canonical provider/model pairs that exist in the
// capabilities + pricing registries.
const MEMBERS = [
  { provider: "openai", model: "gpt-5.3-codex", fullModel: "openai/gpt-5.3-codex" },
  { provider: "anthropic", model: "claude-opus-4-7", fullModel: "anthropic/claude-opus-4-7" },
];

describe("simulateCombo — calls & fanout", () => {
  it("fallback: calls {1, N}, fanout 1", () => {
    const s = simulateCombo({ members: MEMBERS, strategyConfig: { fallbackStrategy: "fallback" } });
    expect(s.strategy).toBe("fallback");
    expect(s.calls).toEqual({ min: 1, max: 2 });
    expect(s.maxProviderFanout).toBe(1);
  });

  it("round-robin: same call range as fallback", () => {
    const s = simulateCombo({ members: MEMBERS, strategyConfig: { fallbackStrategy: "round-robin" } });
    expect(s.calls).toEqual({ min: 1, max: 2 });
  });

  it("fusion: deterministic {N+1, N+1} and fanout = member count", () => {
    const s = simulateCombo({ members: MEMBERS, strategyConfig: { fallbackStrategy: "fusion" } });
    expect(s.calls).toEqual({ min: 3, max: 3 });
    expect(s.maxProviderFanout).toBe(2);
  });

  it("swarm: {1, workers+4}, fanout = workers", () => {
    const s = simulateCombo({ members: MEMBERS, strategyConfig: { fallbackStrategy: "swarm", workerCount: 4 } });
    expect(s.calls).toEqual({ min: 1, max: 8 });
    expect(s.maxProviderFanout).toBe(2); // 2 members, capped by member count
  });

  it("cascade: {1, min(members, maxStages)}", () => {
    const s = simulateCombo({ members: MEMBERS, strategyConfig: { fallbackStrategy: "cascade", cascade: { maxStages: 3 } } });
    expect(s.calls).toEqual({ min: 1, max: 2 });
  });
});

describe("simulateCombo — cost", () => {
  it("worst-case cost = sum of per-leaf costs × worst calls", () => {
    const inputTokens = 1000;
    const s = simulateCombo({ members: MEMBERS, strategyConfig: { fallbackStrategy: "fallback" }, inputTokens });
    const expectedPerCall = MEMBERS.reduce(
      (sum, m) => sum + estimateLeafCostUsd(m.provider, m.model, inputTokens),
      0,
    );
    expect(s.perCallCost).toBeCloseTo(expectedPerCall, 10);
    expect(s.estimatedCost.optimistic).toBeCloseTo(expectedPerCall, 10);
    expect(s.estimatedCost.worst).toBeCloseTo(expectedPerCall * 2, 10);
  });

  it("fusion cost includes the judge leaf (judge || panel[0])", () => {
    const s = simulateCombo({ members: MEMBERS, strategyConfig: { fallbackStrategy: "fusion" }, inputTokens: 1000 });
    // Leaves = panel(2) + judge(= panel[0]) → 3 calls × per-call sum. The judge
    // ref duplicates a member ref, so the per-call set stays 2 leaves (same
    // conservative dedupe createComboBudget applies — its `leaves` array also
    // contains each ref once). Worst cost = perCallCost × 3 calls.
    expect(s.calls.max).toBe(3);
    expect(s.estimatedCost.worst).toBeCloseTo(s.perCallCost * 3, 10);
  });

  it("swarm role cascade (staff→manager→panel[0]) is reflected in leaf set", () => {
    const s = simulateCombo({
      members: MEMBERS,
      strategyConfig: { fallbackStrategy: "swarm", managerModel: MEMBERS[1].fullModel },
    });
    // manager + staff + audit all resolve to panel[1] → deduped to one extra leaf.
    const roleRefs = Object.values(s.roleModels);
    expect(roleRefs.every((r) => r === MEMBERS[1].fullModel)).toBe(true);
    const panel0RoleCount = Object.values(s.roleModels).filter((r) => r === MEMBERS[0].fullModel).length;
    expect(panel0RoleCount).toBe(0);
  });
});

describe("simulateCombo — budget rejection risk", () => {
  it("flags rejection when worst-case cost exceeds an enabled budget limit", () => {
    const s = simulateCombo({
      members: MEMBERS,
      strategyConfig: {
        fallbackStrategy: "fusion",
        // normalizeComboStrategyConfig clamps maxEstimatedCostUsd to min 0.01.
        budgets: { enabled: true, maxEstimatedCostUsd: 0.01 },
      },
      inputTokens: 1000,
    });
    expect(s.budgetRisk.rejected).toBe(true);
    expect(s.budgetRisk.level).toBe("rejected");
    expect(s.budgetRisk.limit).toBe(0.01);
  });

  it("ok when within limit, and no risk when budgets are disabled", () => {
    const within = simulateCombo({
      members: MEMBERS,
      strategyConfig: { fallbackStrategy: "fallback", budgets: { enabled: true, maxEstimatedCostUsd: 100 } },
    });
    expect(within.budgetRisk.rejected).toBe(false);

    const off = simulateCombo({ members: MEMBERS, strategyConfig: { fallbackStrategy: "fallback" } });
    expect(off.budgetsEnabled).toBe(false);
    expect(off.budgetRisk.level).toBe("ok");
  });
});

describe("simulateCombo — capabilities & roles", () => {
  it("derives union capabilities from members (both reasoning → thinking true)", () => {
    const s = simulateCombo({ members: MEMBERS, strategyConfig: { fallbackStrategy: "fusion" } });
    expect(s.capabilities.thinking).toBe(true);
    expect(s.capabilities.vision.input).toBe(true); // claude-opus-4-7 + gpt-5.3-codex vision
    expect(s.capabilities.tools).toBe(true);
    expect(s.capabilities.source).toBe("combo");
  });

  it("thinking off disables member-derived thinking", () => {
    const s = simulateCombo({ members: MEMBERS, strategyConfig: { fallbackStrategy: "fallback", thinking: { type: "off" } } });
    expect(s.capabilities.thinking).toBe(false);
  });

  it("memberRows carry pricing + capability + latency per member", () => {
    const s = simulateCombo({
      members: MEMBERS,
      strategyConfig: { fallbackStrategy: "fusion" },
      latency: {
        "openai/gpt-5.3-codex": { p50: 900, p95: 1500, avgLatency: 1100, sampleCount: 40 },
      },
    });
    const gpt = s.memberRows.find((m) => m.fullModel === "openai/gpt-5.3-codex");
    expect(gpt.hasPricing).toBe(true);
    expect(gpt.latency).toEqual({ p50: 900, p95: 1500, avg: 1100, sampleCount: 40 });
    expect(gpt.capabilities.thinking).toBe(true);
    // fusion judge = panel[0]
    expect(gpt.roles).toContain("judge");
    const claude = s.memberRows.find((m) => m.fullModel === "anthropic/claude-opus-4-7");
    expect(claude.roles).toEqual([]);
    expect(claude.latency).toBeNull();
  });

  it("role violations surface for web-cookie control roles", () => {
    const s = simulateCombo({
      members: [
        { provider: "openai", model: "gpt-5.3-codex", fullModel: "openai/gpt-5.3-codex" },
        { provider: "web", model: "claude-sonnet", fullModel: "web/claude-sonnet" },
      ],
      strategyConfig: { fallbackStrategy: "fusion", judgeModel: "web/claude-sonnet" },
    });
    expect(s.roleViolations.length).toBeGreaterThan(0);
    expect(s.roleViolations[0].role).toBe("judge");
  });

  it("empty members → calls min 1, no cost, no fanout blowup", () => {
    const s = simulateCombo({ members: [], strategyConfig: { fallbackStrategy: "swarm", workerCount: 8 } });
    expect(s.calls.max).toBe(12); // workers(8) + 4
    expect(s.estimatedCost.worst).toBe(0);
    expect(s.capabilities.thinking).toBe(false);
  });
});

describe("resolveRoleModels", () => {
  it("mirrors buildComboExecutionGraph cascades", () => {
    const members = ["a/x", "b/y"];
    expect(resolveRoleModels({ fallbackStrategy: "fallback" }, members)).toEqual({});
    expect(resolveRoleModels({ fallbackStrategy: "fusion" }, members)).toEqual({ judge: "a/x" });
    expect(resolveRoleModels({ fallbackStrategy: "fusion", judgeModel: "b/y" }, members)).toEqual({ judge: "b/y" });
    expect(resolveRoleModels({ fallbackStrategy: "swarm" }, members)).toEqual({
      manager: "a/x", staff: "a/x", audit: "a/x",
    });
    expect(resolveRoleModels({ fallbackStrategy: "swarm", managerModel: "b/y" }, members)).toEqual({
      manager: "b/y", staff: "b/y", audit: "b/y",
    });
  });
});
