import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    })),
  },
}));

const exchangeTokensMock = vi.fn();
const createProviderConnectionMock = vi.fn();
vi.mock("../../src/lib/oauth/providers.js", () => ({
  exchangeTokens: (...args) => exchangeTokensMock(...args),
  extractCodexAccountInfo: vi.fn(() => ({})),
}));
vi.mock("../../src/models/index.js", () => ({
  createProviderConnection: (...args) => createProviderConnectionMock(...args),
}));

let POST;
beforeEach(async () => {
  vi.clearAllMocks();
  exchangeTokensMock.mockResolvedValue({
    accessToken: "tok-fb",
    refreshToken: null,
    expiresIn: null,
    providerSpecificData: { authMethod: "auth_token" },
  });
  createProviderConnectionMock.mockResolvedValue({ id: "c1", provider: "freebuff", email: null });
  const mod = await import("../../src/app/api/oauth/[provider]/[action]/route.js");
  POST = mod.POST;
});

describe("POST /api/oauth/freebuff/exchange", () => {
  it("exchanges a raw token without requiring PKCE (browser_token flow)", async () => {
    const res = await POST(
      { json: async () => ({ code: "tok-raw", redirectUri: "http://localhost:3000/callback" }) },
      { params: Promise.resolve({ provider: "freebuff", action: "exchange" }) }
    );
    expect(res.body.success).toBe(true);
    // No codeVerifier required for freebuff.
    expect(exchangeTokensMock).toHaveBeenCalledWith("freebuff", "tok-raw", "http://localhost:3000/callback", undefined, undefined, undefined);
    expect(createProviderConnectionMock).toHaveBeenCalledWith(expect.objectContaining({
      provider: "freebuff",
      authType: "oauth",
      accessToken: "tok-fb",
    }));
  });

  it("does NOT run the Codex JWT-decode branch even when the token looks like a JWT", async () => {
    const fakeJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sig";
    const res = await POST(
      { json: async () => ({ code: fakeJwt, redirectUri: "http://localhost:3000/callback" }) },
      { params: Promise.resolve({ provider: "freebuff", action: "exchange" }) }
    );
    expect(res.body.success).toBe(true);
    // Went through the normal exchange path, not the JWT branch.
    expect(exchangeTokensMock).toHaveBeenCalledWith("freebuff", fakeJwt, "http://localhost:3000/callback", undefined, undefined, undefined);
    // authType stays "oauth", not "access_token".
    expect(createProviderConnectionMock).toHaveBeenCalledWith(expect.objectContaining({ authType: "oauth" }));
  });

  it("400 when code is missing", async () => {
    const res = await POST(
      { json: async () => ({ redirectUri: "http://localhost:3000/callback" }) },
      { params: Promise.resolve({ provider: "freebuff", action: "exchange" }) }
    );
    expect(res.status).toBe(400);
    expect(exchangeTokensMock).not.toHaveBeenCalled();
  });
});
