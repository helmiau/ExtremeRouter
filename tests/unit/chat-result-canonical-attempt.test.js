import { describe, it, expect } from "vitest";

// Commit D: integrate the universal canonical attempt into the internal
// ChatResult envelope, ADDITIVELY, across all currently-supported provider
// execution paths. This suite proves the CONTRACT seam only (buildChatResult /
// createErrorResult) — the lowest-risk, network-free surface — so the
// integration cannot silently change ChatResult.success, fabricate attempts,
// or leak canonicalAttempt into the public HTTP Response.
//
// Scope guards (hard constraints for this commit):
//  - ChatResult.success MUST stay unchanged.
//  - canonicalAttempt.logicalSuccess MUST NOT replace success.
//  - Combo / fallback MUST NOT consume canonicalAttempt yet.
//  - canonicalAttempt MUST NOT appear in the public Response body/headers.

import { buildChatResult, createErrorResult, chatResultFromErrorResponse } from "../../open-sse/utils/error.js";

const jsonRes = (status, body) =>
  new Response(JSON.stringify(body ?? { ok: true }), {
    status,
    headers: { "content-type": "application/json" },
  });

const fakeAttempt = () => ({
  source: "provider",
  transportOk: true,
  completionState: "success",
  logicalSuccess: true,
  outcome: "ok",
});

describe("ChatResult envelope gains additive canonicalAttempt (Commit D)", () => {
  it("buildChatResult defaults canonicalAttempt to null when omitted", () => {
    const r = buildChatResult({ success: true, response: jsonRes(200) });
    expect(r.success).toBe(true);
    expect(r.canonicalAttempt).toBeNull();
    expect(Object.keys(r)).toContain("canonicalAttempt");
  });

  it("buildChatResult preserves a provided canonicalAttempt untouched", () => {
    const attempt = fakeAttempt();
    const r = buildChatResult({ success: true, response: jsonRes(200), canonicalAttempt: attempt });
    expect(r.canonicalAttempt).toBe(attempt);
    expect(r.success).toBe(true);
  });

  it("createErrorResult defaults canonicalAttempt to null (no fabricated attempt)", () => {
    const r = createErrorResult(502, "upstream down");
    expect(r.success).toBe(false);
    expect(r.status).toBe(502);
    expect(r.error).toBe("upstream down");
    expect(r.canonicalAttempt).toBeNull();
  });

  it("createErrorResult carries a provided canonicalAttempt via options", () => {
    const attempt = fakeAttempt();
    const r = createErrorResult(502, "malformed SSE", undefined, { canonicalAttempt: attempt });
    expect(r.success).toBe(false);
    expect(r.canonicalAttempt).toBe(attempt);
  });

  it("chatResultFromErrorResponse (Wave 1B boundary) defaults canonicalAttempt to null", () => {
    const r = chatResultFromErrorResponse(jsonRes(500), 500);
    expect(r.success).toBe(false);
    expect(r.canonicalAttempt).toBeNull();
  });
});

describe("Commit D: success field is invariant (no logicalSuccess substitution)", () => {
  it("success=true is honored even when no canonicalAttempt exists", () => {
    const r = buildChatResult({ success: true, response: jsonRes(200), canonicalAttempt: null });
    expect(r.success).toBe(true);
    expect(r.canonicalAttempt).toBeNull();
  });

  it("success=false is honored even when a canonicalAttempt exists", () => {
    // A pre-provider failure can still carry an attempt (e.g. malformed SSE
    // 502). The application decision remains success=false regardless.
    const attempt = fakeAttempt();
    const r = createErrorResult(502, "bad", undefined, { canonicalAttempt: attempt });
    expect(r.success).toBe(false);
    expect(attempt.logicalSuccess).toBe(true);
  });
});

describe("Commit D: canonicalAttempt is internal only — not in public HTTP Response", () => {
  it("the public Response body does not contain canonicalAttempt", async () => {
    const attempt = fakeAttempt();
    const r = buildChatResult({ success: true, response: jsonRes(200, { choices: [] }), canonicalAttempt: attempt });
    const body = await r.response.json();
    expect(body).not.toHaveProperty("canonicalAttempt");
    expect(body).not.toHaveProperty("logicalSuccess");
  });

  it("the public Response headers do not expose canonicalAttempt", () => {
    const attempt = fakeAttempt();
    const r = buildChatResult({ success: true, response: jsonRes(200), canonicalAttempt: attempt });
    for (const key of r.response.headers.keys()) {
      expect(key.toLowerCase()).not.toContain("canonical");
      expect(key.toLowerCase()).not.toContain("logical");
    }
  });
});
