import { describe, it, expect } from "vitest";
import { createErrorResultFromError, createErrorResult } from "../../open-sse/utils/error.js";

const makeAbort = () => {
  const err = new Error("This operation was aborted");
  err.name = "AbortError";
  return err;
};

describe("createErrorResultFromError", () => {
  it("maps AbortError → 499 'Request aborted' (client cancel, not provider failure)", () => {
    const r = createErrorResultFromError(makeAbort(), 502, "some upstream context");
    expect(r.success).toBe(false);
    expect(r.status).toBe(499);
    expect(r.error).toBe("Request aborted");
  });

  it("keeps the default status (502) + formatted message for real failures", () => {
    const r = createErrorResultFromError(new Error("socket hang up"), undefined, "[502]: socket hang up");
    expect(r.status).toBe(502);
    expect(r.error).toBe("[502]: socket hang up");
  });

  it("preserves a caller-chosen non-abort status", () => {
    const r = createErrorResultFromError(new Error("boom"), 504);
    expect(r.status).toBe(504);
    expect(r.error).toBe("boom");
  });

  it("falls back to error.message when no message is passed", () => {
    const r = createErrorResultFromError(new Error("ECONNRESET"));
    expect(r.status).toBe(502);
    expect(r.error).toBe("ECONNRESET");
  });

  it("produces the same response shape as createErrorResult (499 is a no-op downstream)", () => {
    const viaHelper = createErrorResultFromError(makeAbort());
    const direct = createErrorResult(499, "Request aborted");
    expect(viaHelper.status).toBe(direct.status);
    expect(viaHelper.error).toBe(direct.error);
    expect(viaHelper.response.status).toBe(499);
  });
});
