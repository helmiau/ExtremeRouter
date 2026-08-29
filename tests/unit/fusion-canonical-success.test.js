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

// ---- G2-E.3: Fusion must NOT own retry/fallback; policy is leaf-owned ----
describe("Fusion: policy ownership (G2-E.3)", () => {
  const failedLeg = (policy, overrides = {}) => ({
    success: false, status: 502, error: "boom",
    response: jsonRes({ error: { message: "boom" } }, 502),
    canonicalAttempt: { source: "provider", transportOk: true, completionState: "failure", logicalSuccess: false, classification: "provider_failure", reason: "provider_error", ...overrides, policy },
  });

  it("failed leg with fallbackEligible=true is dropped, NOT re-run inside fusion", async () => {
    // If Fusion wrongly owned fallback, it would call handleSingleModel again for
    // the failed panel. It must invoke each panel exactly once (fan-out) and drop
    // the failed leg; the judge still runs from survivors.
    const calls = [];
    const fake = vi.fn(async (b, m) => {
      calls.push(m);
      if (m === "judge") return { success: true, status: 200, response: jsonRes(textBody("final")), canonicalAttempt: attempt() };
      if (m === "a") return failedLeg({ fallbackEligible: true, stopProgression: false, retryable: false });
      return { success: true, status: 200, response: jsonRes(textBody("p-b")), canonicalAttempt: attempt() };
    });
    const out = await handleFusionChat({ body: { model: "f" }, models: ["a", "b"], handleSingleModel: fake, log, comboName: "f", judgeModel: "judge", tuning: {}, signal: undefined, runBudget: null });
    // "a" failed → dropped. "a" must NOT be called a second time (no per-leg fallback loop).
    expect(calls.filter((m) => m === "a")).toHaveLength(1);
    expect(out.status).toBe(200);
  });

  it("failed leg with retryable=true is NOT double-retried by fusion", async () => {
    const calls = [];
    const fake = vi.fn(async (b, m) => {
      calls.push(m);
      if (m === "judge") return { success: true, status: 200, response: jsonRes(textBody("final")), canonicalAttempt: attempt() };
      if (m === "a") return failedLeg({ fallbackEligible: false, stopProgression: false, retryable: true });
      return { success: true, status: 200, response: jsonRes(textBody("p-b")), canonicalAttempt: attempt() };
    });
    await handleFusionChat({ body: { model: "f" }, models: ["a", "b"], handleSingleModel: fake, log, comboName: "f", judgeModel: "judge", tuning: {}, signal: undefined, runBudget: null });
    // Retry stays at the leaf (handleSingleModelChat/executor); fusion fans out once.
    expect(calls.filter((m) => m === "a")).toHaveLength(1);
  });

  it("client_abort leg is dropped without triggering fusion fallback/retry", async () => {
    const calls = [];
    const fake = vi.fn(async (b, m) => {
      calls.push(m);
      if (m === "judge") return { success: true, status: 200, response: jsonRes(textBody("final")), canonicalAttempt: attempt() };
      if (m === "a") return failedLeg({ fallbackEligible: false, stopProgression: true, retryable: false }, { classification: "client_abort", reason: "client_abort" });
      return { success: true, status: 200, response: jsonRes(textBody("p-b")), canonicalAttempt: attempt() };
    });
    const out = await handleFusionChat({ body: { model: "f" }, models: ["a", "b"], handleSingleModel: fake, log, comboName: "f", judgeModel: "judge", tuning: {}, signal: undefined, runBudget: null });
    expect(calls.filter((m) => m === "a")).toHaveLength(1); // no retry
    expect(out.status).toBe(200);
  });

  it("user-error (400) leg with stopProgression=true does NOT cause panel fallback", async () => {
    const calls = [];
    const fake = vi.fn(async (b, m) => {
      calls.push(m);
      if (m === "judge") return { success: true, status: 200, response: jsonRes(textBody("final")), canonicalAttempt: attempt() };
      if (m === "a") return failedLeg({ fallbackEligible: false, stopProgression: true, retryable: false }, { classification: "transport_failure", reason: "http_400", completionState: "failure" });
      return { success: true, status: 200, response: jsonRes(textBody("p-b")), canonicalAttempt: attempt() };
    });
    await handleFusionChat({ body: { model: "f" }, models: ["a", "b"], handleSingleModel: fake, log, comboName: "f", judgeModel: "judge", tuning: {}, signal: undefined, runBudget: null });
    expect(calls.filter((m) => m === "a")).toHaveLength(1); // no fallback/re-run
  });
});
