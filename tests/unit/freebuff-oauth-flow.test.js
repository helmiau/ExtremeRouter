import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Freebuff exchangeToken uses tlsFetch from open-sse/utils/tlsClient.js.
// Force it onto globalThis.fetch so the session check is testable.
vi.mock("../../open-sse/utils/tlsClient.js", () => ({
  tlsFetch: (url, options = {}) => globalThis.fetch(url, options),
}));

const { exchangeTokens, getProvider, requestDeviceCode, pollForToken } = await import("../../src/lib/oauth/providers.js");

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
  it("is registered with device_code flow and a token page URL", () => {
    const provider = getProvider("freebuff");
    expect(provider.flowType).toBe("device_code");
    expect(provider.config.baseUrl).toBe("https://codebuff.com");
    expect(provider.config.tokenPageUrl).toBe("https://freebuff.llm.pm");
  });

  it("requests a fingerprint-bound browser login URL from freebuff.llm.pm", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        fingerprintId: "freebuff-go-abc123",
        fingerprintHash: "hash-1",
        loginUrl: "https://freebuff.com/login?auth_code=xyz",
        expiresAt: 1786669488159,
        expiresInMs: 3600000,
      })
    );

    const device = await requestDeviceCode("freebuff");

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://freebuff.llm.pm/api/code");
    expect(opts.method).toBe("POST");
    // device_code carries the fingerprint; the login URL is the verification URI.
    expect(device.device_code).toBe("freebuff-go-abc123");
    expect(device.verification_uri).toBe("https://freebuff.com/login?auth_code=xyz");
    expect(device.verification_uri_complete).toBe("https://freebuff.com/login?auth_code=xyz");
    expect(device.fingerprintHash).toBe("hash-1");
    expect(device.expiresAt).toBe(1786669488159);
    expect(device.interval).toBeGreaterThan(0);
  });

  it("polls /api/status while pending, then validates the token against codebuff.com", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ pending: true }))
      .mockResolvedValueOnce(jsonResponse({ user: { id: "u1", name: "Me", email: "me@freebuff.test", authToken: "tok-123", fingerprintId: "freebuff-go-abc123" } }))
      .mockResolvedValueOnce(jsonResponse({ instanceId: "inst-1", expiresAt: new Date(Date.now() + 3600_000).toISOString(), email: "me@freebuff.test" }));

    const pending = await pollForToken("freebuff", "freebuff-go-abc123", null, { _fingerprintHash: "hash-1", _expiresAt: 123 });
    expect(pending.success).toBe(false);
    expect(pending.pending).toBe(true);

    const done = await pollForToken("freebuff", "freebuff-go-abc123", null, { _fingerprintHash: "hash-1", _expiresAt: 123 });
    expect(done.success).toBe(true);
    expect(done.tokens.accessToken).toBe("tok-123");
    expect(done.tokens.email).toBe("me@freebuff.test");
    expect(done.tokens.displayName).toBe("Me");
    expect(done.tokens.providerSpecificData.userId).toBe("u1");
    expect(done.tokens.providerSpecificData.fingerprintId).toBe("freebuff-go-abc123");
    // The connect-time session envelope is persisted for executor reuse.
    expect(done.tokens.providerSpecificData.instanceId).toBe("inst-1");
    expect(done.tokens.providerSpecificData.sessionExpiresAt).toEqual(expect.any(String));

    // Poll payload forwards the fingerprint + hash to freebuff.llm.pm.
    const [, opts] = fetchMock.mock.calls[1];
    const body = JSON.parse(opts.body);
    expect(body.fingerprintId).toBe("freebuff-go-abc123");
    expect(body.fingerprintHash).toBe("hash-1");

    // The token is validated against codebuff.com (with the CLI UA) before
    // the connection is created.
    const [checkUrl, checkOpts] = fetchMock.mock.calls[2];
    expect(checkUrl).toBe("https://codebuff.com/api/v1/freebuff/session");
    expect(checkOpts.headers.Authorization).toBe("Bearer tok-123");
    expect(checkOpts.headers["User-Agent"]).toBe("ai-sdk/openai-compatible/0.10.7/codebuff");
  });

  it("rejects a token that codebuff.com rejects during guided login", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user: { id: "u1", email: "me@freebuff.test", authToken: "tok-bad", fingerprintId: "fp" } }))
      .mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401));
    const result = await pollForToken("freebuff", "freebuff-go-abc123", null, { _fingerprintHash: "hash-1" });
    expect(result.success).toBe(false);
    expect(result.error).toBe("auth_failed");
    expect(result.errorDescription).toMatch(/re-copy from freebuff\.llm\.pm/);
  });

  it("surfaces upstream errors from /api/status", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "Fingerprint mismatch" }, 200));
    const result = await pollForToken("freebuff", "freebuff-go-abc123", null, {});
    expect(result.success).toBe(false);
    expect(result.error).toBe("auth_failed");
  });

  it("validates the authToken against the session endpoint", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ instanceId: "inst-1", expiresAt: new Date(Date.now() + 3600_000).toISOString(), email: "me@freebuff.test" })
    );

    const mapped = await exchangeTokens("freebuff", "tok-abc");

    // The validation POST carries the auth + default model + CLI UA headers.
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://codebuff.com/api/v1/freebuff/session");
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Bearer tok-abc");
    expect(opts.headers["User-Agent"]).toBe("ai-sdk/openai-compatible/0.10.7/codebuff");
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
