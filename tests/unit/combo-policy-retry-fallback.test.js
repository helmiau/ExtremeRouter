import { describe, it, expect, vi } from "vitest";

// G2-D: Combo candidate progression must consume the finalized
// canonicalAttempt.policy ({fallbackEligible, stopProgression}), not re-derive
// from HTTP status. Uses controlled ChatResult test doubles injected as
// handleSingleModel — no provider/network involved.

// The judge-role capability gate validates against the real provider registry;
// synthetic combo member names would 400 before reaching the strategy. That
// gate is orthogonal to policy consumption, so stub it out here.
vi.mock("../../open-sse/services/providerCapabilities.js", () => ({
  validateComboRoles: () => [],
}));

const { handleComboChat } = await import("../../open-sse/services/combo.js");
const { decideAttemptPolicy } = await import("../../open-sse/utils/canonicalPolicy.js");

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const okBody = () => ({ id: "chatcmpl-x", object: "chat.completion", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }] });

// A finalized failing candidate whose decision comes ONLY from its policy.
function failResult(status, { classification, reason, source = "provider", completionState = "failure" } = {}) {
  const policy = decideAttemptPolicy({ source, classification, reason });
  return {
    success: false,
    status,
    error: `fail-${status}`,
    response: jsonRes(status, { error: { message: `fail-${status}` } }),
    canonicalAttempt: { source, completionState, logicalSuccess: false, policy },
  };
}

const okResult = (status = 200) => ({ success: true, status, response: jsonRes(status, okBody()) });

function transportFail(status) {
  return failResult(status, { classification: "transport_failure", reason: status >= 500 ? "http_5xx" : `http_${status}` });
}

function run(models, fake) {
  return handleComboChat({ body: { model: "combo-a" }, models, handleSingleModel: fake, log, comboName: "c", comboStrategy: "fallback" });
}

describe("G2-D: Combo consumes canonical policy for candidate progression", () => {
  it("non-retryable client errors (400/405/406/413/415/422) stop progression — candidate 2 NOT invoked", async () => {
    for (const status of [400, 405, 406, 413, 415, 422]) {
      const fake = vi.fn(async () => transportFail(status));
      const out = await run(["a", "b"], fake);
      expect(fake).toHaveBeenCalledTimes(1);
      expect(out.status).toBe(status);
    }
  });

  it("auth/not-found/provider/malformed failures are fallback-eligible (no retry) — candidate 2 invoked", async () => {
    const cases = [
      transportFail(401),
      transportFail(403),
      transportFail(404),
      failResult(200, { classification: "provider_failure", reason: "provider_error" }),
      failResult(200, { classification: "provider_failure", reason: "malformed_json" }),
      failResult(200, { classification: "provider_failure", reason: "malformed_sse" }),
    ];
    for (const fail of cases) {
      const calls = [];
      const fake = vi.fn(async (_b, m) => {
        calls.push(m);
        return m === "a" ? fail : okResult();
      });
      const out = await run(["a", "b"], fake);
      expect(calls).toEqual(["a", "b"]);
      expect(out.status).toBe(200);
    }
  });

  it("transient/rate-limited/empty-output failures fall through — candidate 2 invoked", async () => {
    const cases = [
      transportFail(429),
      transportFail(500),
      transportFail(502),
      transportFail(503),
      transportFail(504),
      failResult(200, { classification: "empty_output", reason: "empty_response" }),
    ];
    for (const fail of cases) {
      const calls = [];
      const fake = vi.fn(async (_b, m) => {
        calls.push(m);
        return m === "a" ? fail : okResult();
      });
      const out = await run(["a", "b"], fake);
      expect(calls).toEqual(["a", "b"]);
      expect(out.status).toBe(200);
    }
  });

  it("client_abort stops progression — candidate 2 NOT invoked", async () => {
    const fake = vi.fn(async () => failResult(499, { classification: "cancelled", reason: "client_abort", completionState: "cancelled" }));
    const out = await run(["a", "b"], fake);
    expect(fake).toHaveBeenCalledTimes(1);
    expect(out.status).toBe(499);
  });

  it("cache/bypass synthetic policy stops progression — candidate 2 NOT invoked", async () => {
    for (const source of ["cache", "bypass"]) {
      const fake = vi.fn(async () => failResult(200, { source, classification: "transport_failure", reason: "http_500" }));
      const out = await run(["a", "b"], fake);
      expect(fake).toHaveBeenCalledTimes(1);
      expect(out.status).toBe(200);
    }
  });

  it("missing finalized policy falls back to legacy status rules (temporary compat)", async () => {
    // No canonicalAttempt → legacy nonRetryableClientError: 400 does not fallback.
    const noPolicy400 = vi.fn(async () => ({ success: false, status: 400, error: "bad request", response: jsonRes(400, { error: { message: "bad request" } }) }));
    const out400 = await run(["a", "b"], noPolicy400);
    expect(noPolicy400).toHaveBeenCalledTimes(1);
    expect(out400.status).toBe(400);

    // No canonicalAttempt → legacy checkFallbackError: 502 does fallback.
    const calls = [];
    const noPolicy502 = vi.fn(async (_b, m) => {
      calls.push(m);
      return m === "a" ? { success: false, status: 502, error: "down", response: jsonRes(502, { error: { message: "down" } }) } : okResult();
    });
    const out502 = await run(["a", "b"], noPolicy502);
    expect(calls).toEqual(["a", "b"]);
    expect(out502.status).toBe(200);
  });

  it("provisional streaming holder (completionState=unknown) is treated as no-policy, not finalized", async () => {
    // A provisional policy on a stream must never drive the buffered fallback
    // decision; legacy rules apply instead.
    const fake = vi.fn(async () => ({
      success: false,
      status: 400,
      error: "bad request",
      response: jsonRes(400, { error: { message: "bad request" } }),
      canonicalAttempt: { completionState: "unknown", logicalSuccess: false, policy: { fallbackEligible: true, stopProgression: false } },
    }));
    const out = await run(["a", "b"], fake);
    expect(fake).toHaveBeenCalledTimes(1);
  });

  // ---- G2-E.1: finalized policy precedence over legacy helpers (mandatory) ----

  it("NEGATIVE: finalized fallbackEligible=false overrides a status the legacy helper would fallback", async () => {
    // 502 normally falls back via checkFallbackError (legacy). With a FINALIZED
    // policy saying fallbackEligible=false, candidate 2 must NOT be invoked.
    const finalizedNoFallback = failResult(502, { classification: "provider_failure", reason: "provider_error" });
    // Force the policy field the test cares about, independent of the matrix.
    finalizedNoFallback.canonicalAttempt.policy = { fallbackEligible: false, stopProgression: false, retryable: false };
    const fake = vi.fn(async () => finalizedNoFallback);
    const out = await run(["a", "b"], fake);
    expect(fake).toHaveBeenCalledTimes(1);
    expect(out.status).toBe(502);
  });

  it("POSITIVE: finalized fallbackEligible=true overrides a status the legacy helper would stop", async () => {
    // 400 is a nonRetryableClientError → legacy stops progression. With a
    // FINALIZED policy saying fallbackEligible=true, candidate 2 must run.
    const finalizedFallback = failResult(400, { classification: "transport_failure", reason: "http_400" });
    finalizedFallback.canonicalAttempt.policy = { fallbackEligible: true, stopProgression: false, retryable: false };
    const calls = [];
    const fake = vi.fn(async (_b, m) => {
      calls.push(m);
      return m === "a" ? finalizedFallback : okResult();
    });
    const out = await run(["a", "b"], fake);
    expect(calls).toEqual(["a", "b"]);
    expect(out.status).toBe(200);
  });

  it("COOLDOWN separation: fallbackEligible=false with a status that yields cooldownMs still does NOT fallback", async () => {
    // 502 would yield a cooldown via checkFallbackError. The policy decides
    // WHETHER (no), the cooldown helper only decides HOW LONG. No fallback.
    const finalizedNoFallback = failResult(502, { classification: "provider_failure", reason: "provider_error" });
    finalizedNoFallback.canonicalAttempt.policy = { fallbackEligible: false, stopProgression: false, retryable: false };
    const fake = vi.fn(async () => finalizedNoFallback);
    const out = await run(["a", "b"], fake);
    expect(fake).toHaveBeenCalledTimes(1);
    expect(out.status).toBe(502);
  });
});