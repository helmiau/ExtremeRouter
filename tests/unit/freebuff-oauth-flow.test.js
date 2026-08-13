import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Freebuff exchangeToken uses tlsFetch from open-sse/utils/tlsClient.js.
// Force it onto globalThis.fetch so the session check is testable.
vi.mock("../../open-sse/utils/tlsClient.js", () => ({
  tlsFetch: (url, options = {}) => globalThis.fetch(url, options),
}));

const { exchangeTokens, getProvider } = await import("../../src/lib/oauth/providers.js");

function jsonResponse(body, status = 200) {
  return {
    status,
    ok: status < 400,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
    body: null,
  };
}

let fetchMock;
beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock;
});
afterEach(() => {
  delete globalThis.fetch;
  vi.clearAllMocks();
});

describe("freebuff OAuth flow", () => {
  it("is registered with browser_token flow and a token page URL", () => {
    const provider = getProvider("freebuff");
    expect(provider.flowType).toBe("browser_token");
    expect(provider.config.baseUrl).toBe("https://codebuff.com");
    expect(provider.config.tokenPageUrl).toBe("https://freebuff.llm.pm");
  });

  it("validates the authToken against the session endpoint", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ instanceId: "inst-1", expiresAt: new Date(Date.now() + 3600_000).toISOString(), email: "me@freebuff.test" })
    );

    const mapped = await exchangeTokens("freebuff", "tok-abc");

    // The validation POST carries the auth + default model header.
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://codebuff.com/api/v1/freebuff/session");
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Bearer tok-abc");
    expect(opts.headers["x-freebuff-model"]).toBe("deepseek/deepseek-v4-flash");

    // mapTokens maps the session envelope onto connection fields.
    expect(mapped.accessToken).toBe("tok-abc");
    expect(mapped.refreshToken).toBeNull();
    expect(mapped.expiresIn).toBeGreaterThan(3500);
    expect(mapped.email).toBe("me@freebuff.test");
    expect(mapped.providerSpecificData).toEqual({
      authMethod: "auth_token",
      instanceId: "inst-1",
      sessionExpiresAt: expect.any(String),
    });
  });

  it("rejects an invalid token with a re-login message", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "unauthorized" }, 401));
    await expect(exchangeTokens("freebuff", "bad-token")).rejects.toThrow(/re-copy from freebuff\.llm\.pm/);
  });

  it("rejects an empty token", async () => {
    await expect(exchangeTokens("freebuff", "   ")).rejects.toThrow(/Missing Freebuff authToken/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a missing expiry to expiresIn null (long-lived session)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ instanceId: "inst-2" }));
    const mapped = await exchangeTokens("freebuff", "tok-2");
    expect(mapped.expiresIn).toBeNull();
    expect(mapped.providerSpecificData.instanceId).toBe("inst-2");
  });
});
