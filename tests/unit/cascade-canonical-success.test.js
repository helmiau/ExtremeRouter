import { describe, it, expect, vi } from "vitest";

// Commit F: Cascade stage gate migrated from ChatResult.success to candidateServed
// (finalized canonicalAttempt.logicalSuccess). Stage escalation preserved.

vi.mock("../../open-sse/services/providerCapabilities.js", () => ({
  validateComboRoles: () => [],
}));

const { handleCascadeChat } = await import("../../open-sse/services/combo.js");

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const jsonRes = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const attempt = (overrides = {}) => ({
  source: "provider", transportOk: true, streamStarted: null, hasText: true,
  completionState: "success", completionType: "http_2xx_json", terminalState: null,
  finishReason: "stop", eofSeen: null, errorSeen: false, abortSeen: false,
  usableOutput: true, logicalSuccess: true, outcome: "success", ...overrides,
});

// Cascade requires a CONFIDENCE marker to escalate; without it, escalation is
// "unknown" (-1) and the stage is treated as not-confidently-success → escalate.
const confident = (t) => ({ choices: [{ message: { role: "assistant", content: `${t}\nCONFIDENCE: 92` }, finish_reason: "stop" }] });
const uncertain = (t) => ({ choices: [{ message: { role: "assistant", content: `${t}\nCONFIDENCE: 10` }, finish_reason: "stop" }] });

describe("Cascade: stage escalation gated on finalized logicalSuccess", () => {
  it("stage 1 logically succeeds but low confidence → escalates to stage 2", async () => {
    const calls = [];
    const fake = vi.fn(async (b, m) => {
      calls.push(m);
      if (m === "cheap") {
        return { success: true, status: 200, response: jsonRes(uncertain("cheap answer")), canonicalAttempt: attempt({ completionState: "success", usableOutput: true }) };
      }
      return { success: true, status: 200, response: jsonRes(confident("good")), canonicalAttempt: attempt() };
    });
    const out = await handleCascadeChat({ body: { model: "c" }, models: ["cheap", "strong"], handleSingleModel: fake, log, comboName: "c", tuning: {}, signal: undefined, runBudget: null });
    expect(calls).toEqual(["cheap", "strong"]);
    expect(out.status).toBe(200);
  });

  it("stage 1 HTTP 200 but logicalSuccess=false (empty) → NOT accepted, escalates", async () => {
    const emptyAttempt = attempt({ hasText: false, completionState: "incomplete", usableOutput: false, logicalSuccess: false, outcome: "incomplete" });
    const calls = [];
    const fake = vi.fn(async (b, m) => {
      calls.push(m);
      if (m === "cheap") {
        return { success: true, status: 200, response: jsonRes({ choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }] }), canonicalAttempt: emptyAttempt };
      }
      return { success: true, status: 200, response: jsonRes(confident("good")), canonicalAttempt: attempt() };
    });
    const out = await handleCascadeChat({ body: { model: "c" }, models: ["cheap", "strong"], handleSingleModel: fake, log, comboName: "c", tuning: {}, signal: undefined, runBudget: null });
    expect(calls).toEqual(["cheap", "strong"]);
    expect(out.status).toBe(200);
  });
});

// ---- G2-E.3: Cascade must NOT own retry/fallback; policy is leaf-owned ----
describe("Cascade: policy ownership (G2-E.3)", () => {
  const failedStage = (policy, overrides = {}) => ({
    success: false, status: 502, error: "boom",
    response: jsonRes({ error: { message: "boom" } }, 502),
    canonicalAttempt: { source: "provider", transportOk: true, completionState: "failure", logicalSuccess: false, classification: "provider_failure", reason: "provider_error", ...overrides, policy },
  });

  it("failed stage with fallbackEligible=true advances, is NOT re-run by cascade", async () => {
    const calls = [];
    const fake = vi.fn(async (b, m) => {
      calls.push(m);
      if (m === "cheap") return failedStage({ fallbackEligible: true, stopProgression: false, retryable: false });
      return { success: true, status: 200, response: jsonRes(confident("good")), canonicalAttempt: attempt() };
    });
    const out = await handleCascadeChat({ body: { model: "c" }, models: ["cheap", "strong"], handleSingleModel: fake, log, comboName: "c", tuning: {}, signal: undefined, runBudget: null });
    expect(calls).toEqual(["cheap", "strong"]); // each stage once; no per-stage fallback loop
    expect(out.status).toBe(200);
  });

  it("retryable=true stage is NOT double-retried by cascade", async () => {
    const calls = [];
    const fake = vi.fn(async (b, m) => {
      calls.push(m);
      if (m === "cheap") return failedStage({ fallbackEligible: false, stopProgression: false, retryable: true });
      return { success: true, status: 200, response: jsonRes(confident("good")), canonicalAttempt: attempt() };
    });
    await handleCascadeChat({ body: { model: "c" }, models: ["cheap", "strong"], handleSingleModel: fake, log, comboName: "c", tuning: {}, signal: undefined, runBudget: null });
    expect(calls.filter((m) => m === "cheap")).toHaveLength(1); // no cascade-level retry
  });

  it("client_abort stage does NOT cause cascade fallback/retry", async () => {
    const calls = [];
    const fake = vi.fn(async (b, m) => {
      calls.push(m);
      if (m === "cheap") return failedStage({ fallbackEligible: false, stopProgression: true, retryable: false }, { classification: "client_abort", reason: "client_abort" });
      return { success: true, status: 200, response: jsonRes(confident("good")), canonicalAttempt: attempt() };
    });
    const out = await handleCascadeChat({ body: { model: "c" }, models: ["cheap", "strong"], handleSingleModel: fake, log, comboName: "c", tuning: {}, signal: undefined, runBudget: null });
    expect(calls.filter((m) => m === "cheap")).toHaveLength(1);
    expect(out.status).toBe(200);
  });

  it("user-error (400) stage with stopProgression=true does NOT fallback", async () => {
    const calls = [];
    const fake = vi.fn(async (b, m) => {
      calls.push(m);
      if (m === "cheap") return failedStage({ fallbackEligible: false, stopProgression: true, retryable: false }, { classification: "transport_failure", reason: "http_400", completionState: "failure" });
      return { success: true, status: 200, response: jsonRes(confident("good")), canonicalAttempt: attempt() };
    });
    await handleCascadeChat({ body: { model: "c" }, models: ["cheap", "strong"], handleSingleModel: fake, log, comboName: "c", tuning: {}, signal: undefined, runBudget: null });
    expect(calls.filter((m) => m === "cheap")).toHaveLength(1); // no re-run
  });
});
