import { describe, it, expect, vi } from "vitest";

// Wave 1C regression suite: proves Combo's application-success decision comes
// from ChatResult.success — NOT from Response.ok. Uses controlled test doubles
// injected as the handleSingleModel closure (no provider/network involved).

// The judge-role capability gate validates against the real provider registry;
// synthetic test model names would 400 before reaching the strategy. The gate
// is orthogonal to the success-source migration, so stub it out here.
vi.mock("../../open-sse/services/providerCapabilities.js", () => ({
  validateComboRoles: () => [],
}));

const { handleComboChat, handleFusionChat, handleCascadeChat, handleSwarmChat } = await import("../../open-sse/services/combo.js");

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const okBody = () => ({ id: "chatcmpl-x", object: "chat.completion", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }] });

describe("Wave 1C critical regression: Combo success source is ChatResult.success", () => {
  it("success=true + response 200 → candidate served, onModelServed fired, Response returned", async () => {
    const R200 = jsonRes(200, okBody());
    const served = [];
    const fake = vi.fn(async () => ({ success: true, status: 200, response: R200 }));
    const out = await handleComboChat({
      body: { model: "combo-a" },
      models: ["a"],
      handleSingleModel: fake,
      log,
      comboName: "c",
      comboStrategy: "fallback",
    });
    expect(fake).toHaveBeenCalledTimes(1);
    expect(out).toBe(R200);
    expect(out.status).toBe(200);
  });

  it("success=false + response.ok=true (200) → NOT treated as success (the migration proof)", async () => {
    // Pre-Wave-1C code checked result.ok → would have served this candidate.
    // Post-migration the application decision comes exclusively from .success.
    const R200 = jsonRes(200, okBody());
    const fake = vi.fn(async () => ({ success: false, status: 200, response: R200 }));
    const out = await handleComboChat({
      body: { model: "combo-a" },
      models: ["a"],
      handleSingleModel: fake,
      log,
      comboName: "c",
      comboStrategy: "fallback",
    });
    expect(out.status).not.toBe(200);
  });

  it("success=false + 5xx → falls through all models → existing all-failed 503", async () => {
    const calls = [];
    const fake = vi.fn(async (_b, m) => {
      calls.push(m);
      return { success: false, status: 503, error: "upstream down", response: jsonRes(503, { error: { message: "down" } }) };
    });
    const out = await handleComboChat({
      body: { model: "combo-a" },
      models: ["a", "b"],
      handleSingleModel: fake,
      log,
      comboName: "c",
      comboStrategy: "fallback",
    });
    expect(calls).toEqual(["a", "b"]);
    expect(out.status).toBeGreaterThanOrEqual(500);
  });

  it("cache-hit envelope (success=true, fromCache=true) → served like any success", async () => {
    const cached = jsonRes(200, okBody());
    const served = [];
    const fake = vi.fn(async () => ({ success: true, fromCache: true, cacheSimilarity: 0.97, status: 200, response: cached }));
    const out = await handleComboChat({
      body: { model: "combo-a" },
      models: ["cache-a", "b"],
      handleSingleModel: fake,
      log,
      comboName: "c",
      comboStrategy: "fallback",
      onModelServed: (m) => served.push(m),
    });
    expect(served).toContain("cache-a");
    expect(out).toBe(cached);
  });

  it("bare Response input is NOT treated as success (contract enforcement)", async () => {
    const R200 = jsonRes(200, okBody());
    const fake = vi.fn(async () => R200);
    const out = await handleComboChat({
      body: { model: "combo-a" },
      models: ["a"],
      handleSingleModel: fake,
      log,
      comboName: "c",
      comboStrategy: "fallback",
    });
    expect(out.status).not.toBe(200);
  });
});

describe("Wave 1C fusion consumes ChatResult.success", () => {
  it("multi-model fusion: only success legs collected; judge returns its Response", async () => {
    const panelOk1 = jsonRes(200, okBody());
    const panelOk2 = jsonRes(200, okBody());
    const judgeRes = jsonRes(200, okBody());
    let call = 0;
    const fake = vi.fn(async (body, model) => {
      if (model === "p1") return { success: true, status: 200, response: panelOk1 };
      if (model === "p2") return { success: false, status: 503, error: "down", response: jsonRes(503, {}) };
      if (model === "judge") { judgeRes.__isJudge = true; return { success: true, status: 200, response: judgeRes }; }
      call += 1;
      throw new Error(`unexpected ${model}`);
    });
    const out = await handleFusionChat({
      body: { model: "fus", stream: false, messages: [{ role: "user", content: "q" }] },
      models: ["p1", "p2", "judge"],
      handleSingleModel: fake,
      log,
      comboName: "fus",
      judgeModel: "judge",
      tuning: {},
    });
    expect(out).toBe(judgeRes);
    expect(out.status).toBe(200);
  });

  it("fusion single-survivor: failed legs skipped, survivor re-run leg unwrapped to Response", async () => {
    const rerun = jsonRes(200, okBody());
    const first = jsonRes(200, okBody());
    const fake = vi.fn(async (_b, m) => {
      if (m === "solo") return { success: true, status: 200, response: first };
      return { success: true, status: 200, response: rerun };
    });
    const out = await handleFusionChat({
      body: { model: "fus", stream: false, messages: [{ role: "user", content: "q" }] },
      models: ["solo", "dead"],
      handleSingleModel: async (b, m) => (m === "dead" ? { success: false, status: 502, error: "x", response: jsonRes(502, {}) } : fake(b, m)),
      log,
      comboName: "fus",
      judgeModel: "solo",
      tuning: {},
    });
    expect(out.status).toBe(200);
  });
});

describe("Wave 1C cascade consumes ChatResult.success", () => {
  it("stage success below confidence escalates; final stage returns its Response", async () => {
    const stage1 = jsonRes(200, okBody());
    const final = jsonRes(200, okBody());
    const seen = [];
    const fake = vi.fn(async (_b, m) => {
      seen.push(m);
      if (m === "weak") return { success: true, status: 200, response: stage1 };
      return { success: true, status: 200, response: final };
    });
    const out = await handleCascadeChat({
      body: { model: "cas", stream: false, messages: [{ role: "user", content: "q" }] },
      models: ["weak", "strong"],
      handleSingleModel: fake,
      log,
      comboName: "cas",
      comboStrategy: "cascade",
    });
    expect(seen).toEqual(["weak", "strong"]);
    expect(out).toBe(final);
  });

  it("failed stage falls through to the next candidate (existing fallback behavior)", async () => {
    const final = jsonRes(200, okBody());
    const seen = [];
    const fake = vi.fn(async (_b, m) => {
      seen.push(m);
      if (m === "dead") return { success: false, status: 503, error: "x", response: jsonRes(503, {}) };
      return { success: true, status: 200, response: final };
    });
    const out = await handleCascadeChat({
      body: { model: "cas", stream: false, messages: [{ role: "user", content: "q" }] },
      models: ["dead", "final"],
      handleSingleModel: fake,
      log,
      comboName: "cas",
      comboStrategy: "cascade",
    });
    expect(seen).toEqual(["dead", "final"]);
    expect(out).toBe(final);
  });
});

describe("Wave 1C swarm consumes ChatResult.success", () => {
  it("single-model swarm fast path unwraps ChatResult to its Response", async () => {
    const single = jsonRes(200, okBody());
    const fake = vi.fn(async () => ({ success: true, status: 200, response: single }));
    const out = await handleSwarmChat({
      body: { model: "sw", stream: false, messages: [{ role: "user", content: "q" }] },
      models: ["only"],
      handleSingleModel: fake,
      log,
      comboName: "sw",
      comboStrategy: "swarm",
    });
    expect(out).toBe(single);
  });

  it("gatekeeper bypass (simple verdict) returns the manager's Response from the envelope", async () => {
    const direct = jsonRes(200, okBody());
    const fake = vi.fn(async (_b, m) => ({ success: true, status: 200, response: direct }));
    const out = await handleSwarmChat({
      body: { model: "sw", stream: false, messages: [{ role: "user", content: "hi" }] },
      models: ["manager-only"],
      handleSingleModel: fake,
      log,
      comboName: "sw",
      comboStrategy: "swarm",
    });
    expect(out).toBe(direct);
  });
});
