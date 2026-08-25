import { describe, it, expect, vi } from "vitest";

// Commit F: unit-test the candidateServed decision boundary directly.
//   - Streaming 2xx Response → admitted on admission (logicalSuccess NOT read).
//   - Buffered attempt → finalized canonicalAttempt.logicalSuccess.
//   - Null attempt → legacy result.success (cache/bypass/pre-provider).

vi.mock("../../open-sse/services/providerCapabilities.js", () => ({
  validateComboRoles: () => [],
}));

const { candidateServed } = await import("../../open-sse/services/combo.js");

const jsonRes = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sseRes = (status = 200) =>
  new Response("", { status, headers: { "content-type": "text/event-stream; charset=utf-8" } });

const attempt = (overrides = {}) => ({
  source: "provider", transportOk: true, streamStarted: null, hasText: true,
  completionState: "success", completionType: "http_2xx_json",
  terminalState: null, finishReason: "stop", eofSeen: null, errorSeen: false,
  abortSeen: false, usableOutput: true, logicalSuccess: true, outcome: "success",
  ...overrides,
});

describe("candidateServed boundary", () => {
  it("streaming 2xx Response → admitted (success=true), logicalSuccess NOT consulted", () => {
    const res = { success: true, status: 200, response: sseRes(200),
      canonicalAttempt: { logicalSuccess: false, streamStarted: false, completionState: "incomplete" } };
    expect(candidateServed(res)).toBe(true); // admission, NOT logicalSuccess=false
  });

  it("streaming 2xx but result.success=false (pre-admission transport) → not admitted", () => {
    const res = { success: false, status: 502, response: sseRes(502), canonicalAttempt: null };
    expect(candidateServed(res)).toBe(false);
  });

  it("buffered success: logicalSuccess=true → served (Example A)", () => {
    const res = { success: true, status: 200, response: jsonRes({ choices: [{ message: { content: "ok" } }] }), canonicalAttempt: attempt() };
    expect(candidateServed(res)).toBe(true);
  });

  it("buffered success: HTTP 200 but logicalSuccess=false (empty) → NOT served (Example G) — divergence", () => {
    const empty = attempt({ hasText: false, completionState: "incomplete", usableOutput: false, logicalSuccess: false, outcome: "incomplete" });
    const res = { success: true, status: 200, response: jsonRes({ choices: [{ message: { content: "" } }] }), canonicalAttempt: empty };
    expect(candidateServed(res)).toBe(false);
    // success diverges from logicalSuccess — intentional §20
  });

  it("null-attempt (cache/bypass/pre-provider): success=true → served (§12/Case 3)", () => {
    const res = { success: true, status: 200, fromCache: true, response: jsonRes({ choices: [{ message: { content: "cached" } }] }), canonicalAttempt: null };
    expect(candidateServed(res)).toBe(true);
  });

  it("null-attempt + success=false → not served", () => {
    const res = { success: false, status: 400, response: jsonRes({ error: {} }, 400), canonicalAttempt: null };
    expect(candidateServed(res)).toBe(false);
  });

  it("no response → false", () => {
    expect(candidateServed(null)).toBe(false);
    expect(candidateServed({ success: true })).toBe(false);
  });
});
