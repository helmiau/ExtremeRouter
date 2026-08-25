import { describe, it, expect, vi } from "vitest";

// Commit F: Fusion panel legs are stream:false and consumed via .json(); the
// panel success gate migrated from ChatResult.success to candidateServed →
// finalized canonicalAttempt.logicalSuccess. Aggregate semantics (fanout/judge/
// quorum/rerun) are preserved. No provider/network; injected closures.

vi.mock("../../open-sse/services/providerCapabilities.js", () => ({
  validateComboRoles: () => [],
}));

const { handleFusionChat } = await import("../../open-sse/services/combo.js");

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const jsonRes = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Finalized non-streaming attempt.
const attempt = (overrides = {}) => ({
  source: "provider",
  transportOk: true,
  streamStarted: null,
  hasText: true,
  completionState: "success",
  completionType: "http_2xx_json",
  terminalState: null,
  finishReason: "stop",
  eofSeen: null,
  errorSeen: false,
  abortSeen: false,
  usableOutput: true,
  logicalSuccess: true,
  outcome: "success",
  ...overrides,
});

const textBody = (t) => ({ id: "x", choices: [{ message: { role: "assistant", content: t }, finish_reason: "stop" }] });

describe("Fusion: panel leg gated on finalized logicalSuccess", () => {
  it("all panels logically succeed → fused answer returned (200)", async () => {
    const fake = vi.fn(async (b, m) => {
      if (m === "judge") return { success: true, status: 200, response: jsonRes(textBody("final answer")) };
      return { success: true, status: 200, response: jsonRes(textBody(`p-${m}`)), canonicalAttempt: attempt() };
    });
    const out = await handleFusionChat({ body: { model: "f", stream: false }, models: ["a", "b"], handleSingleModel: fake, log, comboName: "f", judgeModel: "judge", tuning: {}, signal: undefined, runBudget: null });
    expect(fake.mock.calls.filter(([, m]) => m !== "judge").length).toBe(2);
    expect(out.status).toBe(200);
  });

  it("one panel logically fails (usage-only) → dropped from panel, others fuse", async () => {
    const usageAttempt = attempt({ hasText: false, completionState: "incomplete", usableOutput: false, logicalSuccess: false, outcome: "incomplete" });
    const calls = [];
    const fake = vi.fn(async (b, m) => {
      calls.push(m);
      if (m === "judge") return { success: true, status: 200, response: jsonRes(textBody("final")) };
      if (m === "b") return { success: true, status: 200, response: jsonRes(textBody("")), canonicalAttempt: usageAttempt };
      return { success: true, status: 200, response: jsonRes(textBody("ok")), canonicalAttempt: attempt() };
    });
    const out = await handleFusionChat({ body: { model: "f", stream: false }, models: ["a", "b"], handleSingleModel: fake, log, comboName: "f", judgeModel: "judge", tuning: {}, signal: undefined, runBudget: null });
    expect(out.status).toBe(200);
    // b was still invoked (fusion fans out all panels) but its empty/usage-only
    // output was excluded from the fused answer — no crash, no all-fail 503.
  });

  it("single-survivor re-run path honors stream:true when client requested streaming", async () => {
    const fake = vi.fn(async (b, m) => {
      if (m === "judge") return { success: true, status: 200, response: jsonRes(textBody("final")) };
      return { success: true, status: 200, response: jsonRes(textBody("only")), canonicalAttempt: attempt() };
    });
    const out = await handleFusionChat({ body: { model: "f", stream: true }, models: ["a"], handleSingleModel: fake, log, comboName: "f", judgeModel: "judge", tuning: {}, signal: undefined, runBudget: null });
    // Only one panel succeeded → single-survivor re-run with client's stream flag.
    expect(out.status).toBe(200);
    // The survivor was re-invoked honoring the client's stream:true body.
    expect(fake.mock.calls.some(([b, m]) => m === "a" && b?.stream === true)).toBe(true);
  });
});
