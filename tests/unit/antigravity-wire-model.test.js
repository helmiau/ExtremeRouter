// Locks the Antigravity 404 fix: the outbound envelope `model` must be the
// real upstream CodeAssist id, not the router alias. Sending the alias
// (e.g. "gemini-3.7-flash-high") or a parenthesized tier id
// ("gemini-3.7-flash-tiered(high)") returns HTTP 404 NOT_FOUND "Requested
// entity was not found." The wire always uses the plain tiered id. See
// open-sse/executors/antigravity.js + providers/registry/antigravity.js.
import { describe, it, expect, vi } from "vitest";

// Mock proxyFetch to bypass the known vitest `@` alias load gap in open-sse/utils/proxyFetch.js.
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { getModelUpstreamId } from "../../open-sse/config/providerModels.js";

const creds = { projectId: "proj-1", connectionId: "conn-1" };

function baseBody(overrides = {}) {
  return {
    request: {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      ...overrides,
    },
  };
}

describe("antigravity wire model — resolves the plain upstream id", () => {
  const ag = new AntigravityExecutor();

  it.each([
    ["gemini-3.7-flash-high", "gemini-3.7-flash-tiered"],
    ["gemini-3.7-flash-medium", "gemini-3.7-flash-tiered"],
    ["gemini-3.7-flash-low", "gemini-3.7-flash-tiered"],
    ["gemini-3.8-flash-high", "gemini-3.8-flash-tiered"],
    ["gemini-3.8-flash-medium", "gemini-3.8-flash-tiered"],
    ["gemini-3.8-flash-low", "gemini-3.8-flash-tiered"],
    ["gemini-3.6-flash-high", "gemini-3.6-flash-tiered"],
    ["gemini-3.6-flash-medium", "gemini-3.6-flash-tiered"],
    ["gemini-3.6-flash-low", "gemini-3.6-flash-tiered"],
    // Router ids that ARE the live upstream ids pass through unchanged.
    ["claude-sonnet-4-6", "claude-sonnet-4-6"],
    ["claude-opus-4-6-thinking", "claude-opus-4-6-thinking"],
    ["gpt-oss-120b-medium", "gpt-oss-120b-medium"],
    ["gemini-pro-agent", "gemini-pro-agent"],
  ])("sends %s as the plain upstream id %s", (model, expected) => {
    const out = ag.transformRequest(model, baseBody(), true, creds);
    expect(out.model).toBe(expected);
    // model is a top-level envelope field, not nested inside request
    expect(out.request.model).toBeUndefined();
  });

  it("matches the upstream resolver used elsewhere in the router", () => {
    expect(getModelUpstreamId("ag", "gemini-3.7-flash-high")).toBe("gemini-3.7-flash-tiered");
    expect(getModelUpstreamId("ag", "gemini-3.8-flash-high")).toBe("gemini-3.8-flash-tiered");
  });

  it("does not leak a parenthesized tier id onto the wire", () => {
    const out = ag.transformRequest("gemini-3.7-flash-high", baseBody(), true, creds);
    expect(out.model).not.toContain("(");
    expect(out.model).not.toContain("-high");
    expect(out.model).not.toContain("(high)");
  });
});

describe("antigravity URL keeps the model out of the path", () => {
  it("builds the same streaming URL regardless of model", () => {
    const ag = new AntigravityExecutor();
    expect(ag.buildUrl("gemini-3.7-flash-high", true)).toBe(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"
    );
    expect(ag.buildUrl("gemini-3.7-flash-high", true)).toBe(ag.buildUrl("claude-sonnet-4-6", true));
  });
});