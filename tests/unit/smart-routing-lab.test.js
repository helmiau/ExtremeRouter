// Guards the A/B Lab engine: it must compare strategies on the SAME request
// with the runtime's own ordering + cost model, and never call a model.
//   (a) fallback → plain member order, member 1 answers first
//   (b) smart-routing tool_calling → cookie providers excluded
//   (c) smart-routing research → cookie pool first
//   (d) smart-routing general → default chain
//   (e) swarm → manager/staff/audit roles + worker fan-out cost
import { describe, it, expect } from "vitest";
import {
  buildLabComparison,
  resolveLabMembers,
  analyzeReality,
  LAB_STRATEGIES,
  LAB_STRATEGY_META,
  AT_RISK_SUCCESS_RATE,
} from "open-sse/services/smartRoutingLab.js";

// felo-web = webCookie provider; kr/glm = normal API providers.
const MEMBERS = ["kr/claude-opus-4-7", "felo-web/deepseek-v4-flash", "glm/glm-5.1"];

const requestBody = (prompt, tools = false) => ({
  messages: [{ role: "user", content: prompt }],
  ...(tools ? { tools: [{ type: "function", function: { name: "probe" } }] } : {}),
});

describe("resolveLabMembers", () => {
  it("canonicalizes provider aliases and drops malformed refs", () => {
    const resolved = resolveLabMembers(["felo/deepseek-v4-flash", "kr/claude-opus-4-7", "nope"]);
    expect(resolved.map((m) => m.fullModel)).toEqual(["felo/deepseek-v4-flash", "kr/claude-opus-4-7"]);
    expect(resolved[0].provider).toBe("felo-web"); // alias felo → felo-web
    expect(resolved[1].provider).toBe("kiro"); // alias kr → kiro
  });
});

describe("buildLabComparison", () => {
  it("fallback: plain member order, member 1 answers first, min 1 call", async () => {
    const result = await buildLabComparison({
      comboName: "lab-1",
      members: MEMBERS,
      body: requestBody("hello there"),
      strategies: ["fallback"],
    });
    const fb = result.strategies[0];
    expect(fb.strategy).toBe("fallback");
    expect(fb.order).toEqual(MEMBERS);
    expect(fb.primaryModel).toBe(MEMBERS[0]);
    expect(fb.reason).toBeNull();
    expect(fb.calls).toEqual({ min: 1, max: MEMBERS.length });
    expect(fb.excludedCookies).toEqual([]);
  });

  it("smart-routing tool_calling: cookie providers excluded, API pool only", async () => {
    const result = await buildLabComparison({
      comboName: "lab-1",
      members: MEMBERS,
      body: requestBody("hello there", true),
      strategies: ["smart-routing"],
    });
    const sr = result.strategies[0];
    expect(sr.reason).toBe("tool_calling");
    expect(sr.order).toEqual(["kr/claude-opus-4-7", "glm/glm-5.1"]); // no felo-web
    expect(sr.excludedCookies).toEqual(["felo-web/deepseek-v4-flash"]);
    expect(sr.primaryModel).toBe("kr/claude-opus-4-7");
    expect(result.request.hadTools).toBe(true);
  });

  it("smart-routing research: cookie pool first, then normal pool", async () => {
    const result = await buildLabComparison({
      comboName: "lab-1",
      members: MEMBERS,
      body: requestBody("research the latest AI trends and cite sources"),
      strategies: ["smart-routing"],
    });
    const sr = result.strategies[0];
    expect(sr.reason).toBe("research_cookie_primary");
    expect(sr.order[0]).toBe("felo-web/deepseek-v4-flash"); // cookie first
    expect(sr.primaryModel).toBe("felo-web/deepseek-v4-flash");
    expect(sr.intent).toMatchObject({ intent: "research", signal: "keyword", confidence: 0.75 });
  });

  it("smart-routing research with cookie pool disabled → default order", async () => {
    const result = await buildLabComparison({
      comboName: "lab-1",
      members: MEMBERS,
      strategyConfig: { smartRouting: { cookiePoolEnabled: false } },
      body: requestBody("research this topic"),
      strategies: ["smart-routing"],
    });
    const sr = result.strategies[0];
    expect(sr.reason).toBe("research_cookie_pool_empty");
    expect(sr.order).toEqual(MEMBERS);
  });

  it("smart-routing general prompt → default chain, no exclusion", async () => {
    const result = await buildLabComparison({
      comboName: "lab-1",
      members: MEMBERS,
      body: requestBody("hello there"),
      strategies: ["smart-routing"],
    });
    const sr = result.strategies[0];
    expect(sr.reason).toBe("general");
    expect(sr.order).toEqual(MEMBERS);
    expect(sr.intent.signal).toBe("none");
  });

  it("tool_calling + research together → tool_calling wins (cookie still excluded)", async () => {
    const result = await buildLabComparison({
      comboName: "lab-1",
      members: MEMBERS,
      body: requestBody("research this and cite sources", true),
      strategies: ["smart-routing"],
    });
    const sr = result.strategies[0];
    expect(sr.reason).toBe("tool_calling");
    expect(sr.order).not.toContain("felo-web/deepseek-v4-flash");
  });

  it("swarm: manager/staff/audit roles cascade to member 1 + worker fan-out cost", async () => {
    const result = await buildLabComparison({
      comboName: "lab-1",
      members: MEMBERS,
      body: requestBody("hello there"),
      strategies: ["swarm"],
    });
    const sw = result.strategies[0];
    expect(sw.strategy).toBe("swarm");
    expect(sw.roleModels).toEqual({
      manager: MEMBERS[0],
      staff: MEMBERS[0],
      audit: MEMBERS[0],
    });
    expect(sw.primaryModel).toBe(MEMBERS[0]);
    // Gatekeeper(1) + manager(1) + workers(workerCount=4) + audit(1) + synthesis(1) = 8
    expect(sw.calls.max).toBe(8);
    // Role refs appear in the per-member rows (deduped leaves still counted once).
    const roleRows = sw.memberRows.filter((r) => r.roles.length > 0);
    expect(roleRows.length).toBeGreaterThan(0);
  });

  it("unknown strategies are filtered out; empty list yields no rows", async () => {
    const result = await buildLabComparison({
      members: MEMBERS,
      body: requestBody("hello there"),
      strategies: ["fallback", "bogus", ""],
    });
    expect(result.strategies.map((s) => s.strategy)).toEqual(["fallback"]);

    const empty = await buildLabComparison({
      members: MEMBERS,
      body: requestBody("hello there"),
      strategies: [],
    });
    expect(empty.strategies).toEqual([]);
  });

  it("defaults to all LAB_STRATEGIES and reports pool split + assumptions", async () => {
    const result = await buildLabComparison({
      comboName: "lab-1",
      members: MEMBERS,
      body: requestBody("hello there"),
    });
    expect(result.strategies.map((s) => s.strategy)).toEqual(LAB_STRATEGIES);
    expect(result.memberCount).toBe(3);
    expect(result.pool.cookie).toEqual(["felo-web/deepseek-v4-flash"]);
    expect(result.pool.normal).toEqual(["kr/claude-opus-4-7", "glm/glm-5.1"]);
    expect(result.request.prompt).toBe("hello there");
    expect(result.assumptions.inputTokens).toBe(1000);
  });

  it("empty member pool degrades gracefully (route guards, engine never throws)", async () => {
    const result = await buildLabComparison({
      comboName: "empty",
      members: [],
      body: requestBody("hello there"),
    });
    expect(result.memberCount).toBe(0);
    expect(result.strategies[0].primaryModel).toBeNull();
  });

  it("exposes per-strategy metadata for the UI picker", () => {
    for (const key of LAB_STRATEGIES) {
      expect(LAB_STRATEGY_META[key].label).toBeTruthy();
      expect(LAB_STRATEGY_META[key].description).toBeTruthy();
    }
  });
});

// ── Prediction vs reality (production outcomes) ────────────────────────────

describe("analyzeReality", () => {
  const rows = [
    { strategy: "fallback", primaryModel: "kr/claude-opus-4-7" },
    { strategy: "smart-routing", primaryModel: "felo-web/deepseek-v4-flash", reason: "research_cookie_primary" },
    { strategy: "swarm", primaryModel: "kr/claude-opus-4-7" },
  ];
  const run = (overrides = {}) => ({
    servedModel: "felo-web/deepseek-v4-flash",
    status: "done",
    error: null,
    routing: { reason: "research_cookie_primary", order: ["felo-web/deepseek-v4-flash", "kr/claude-opus-4-7"] },
    totalDurationMs: 1200,
    ...overrides,
  });

  it("marks the strategy that predicted the served model as matched", () => {
    const reality = analyzeReality(run(), rows);
    const byStrategy = Object.fromEntries(reality.strategies.map((e) => [e.strategy, e]));
    expect(byStrategy["smart-routing"].match).toBe("served");
    expect(byStrategy.fallback.match).toBe("different");
    expect(byStrategy.swarm.match).toBe("different");
    expect(reality.fellThrough).toBe(false);
    expect(reality.originalReason).toBe("research_cookie_primary");
    expect(byStrategy["smart-routing"].originalReason).toBe("research_cookie_primary");
    expect(byStrategy["smart-routing"].reasonMatch).toBe(true);
  });

  it("flags fellThrough when the served model is NOT the head of the pool", () => {
    // Cookie head failed (403) → chain fell to the normal pool. Smart-routing
    // predicted the cookie model but kr actually answered.
    const reality = analyzeReality(
      run({ servedModel: "kr/claude-opus-4-7" }),
      rows,
    );
    expect(reality.fellThrough).toBe(true);
    const sr = reality.strategies.find((e) => e.strategy === "smart-routing");
    expect(sr.match).toBe("different");
  });

  it("marks every strategy failed when the real run errored with no answer", () => {
    const reality = analyzeReality(
      run({ status: "error", error: "all models failed", servedModel: null }),
      rows,
    );
    expect(reality.strategies.every((e) => e.match === "failed")).toBe(true);
    expect(reality.status).toBe("error");
    expect(reality.error).toBe("all models failed");
  });

  it("no_data when there is no run (ad-hoc prompt comparison)", () => {
    const reality = analyzeReality(null, rows);
    expect(reality.strategies.every((e) => e.match === "no_data")).toBe(true);
    expect(reality.servedModel).toBeNull();
  });

  it("detects a reason mismatch (simulated decision differs from the real one)", () => {
    const reality = analyzeReality(
      run({ routing: { reason: "tool_calling", order: ["kr/claude-opus-4-7"] } }),
      rows,
    );
    const sr = reality.strategies.find((e) => e.strategy === "smart-routing");
    expect(sr.reasonMatch).toBe(false);
  });
});

describe("production reliability flags", () => {
  it("flags models with successRate <= threshold and >= 2 samples", async () => {
    const result = await buildLabComparison({
      comboName: "lab-1",
      members: MEMBERS,
      body: requestBody("hello there"),
      modelOutcomes: {
        // kiro is the canonical id that alias kr resolves to.
        "kiro/claude-opus-4-7": { ok: 3, total: 10, successRate: 0.3 },
        "felo-web/deepseek-v4-flash": { ok: 1, total: 1, successRate: 0 }, // <2 samples → not flagged
        "glm/glm-5.1": { ok: 9, total: 10, successRate: 0.9 },
      },
    });
    // Alias resolution: pool ref "kr/..." finds outcomes recorded as "kiro/...".
    expect(result.reliability["kr/claude-opus-4-7"].successRate).toBe(0.3);
    expect(result.reliability["glm/glm-5.1"].successRate).toBe(0.9);
    // felo-web has 1 sample → present in reliability but NOT at-risk (noise guard).
    expect(result.reliability["felo-web/deepseek-v4-flash"]).toBeTruthy();
    expect(result.atRiskModels).toEqual(["kr/claude-opus-4-7"]);
  });

  it("excludes unknown models and honors the threshold constant", () => {
    expect(AT_RISK_SUCCESS_RATE).toBe(0.5);
  });
});
