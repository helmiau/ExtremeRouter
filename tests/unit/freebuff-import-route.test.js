import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock next/server
vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    })),
  },
}));

// Mock os + fs (readFileSync reads the CLI credentials file)
vi.mock("os", () => ({
  default: { homedir: vi.fn(() => "/mock/home") },
  homedir: vi.fn(() => "/mock/home"),
}));

const readFileSyncMock = vi.fn();
vi.mock("fs", () => ({
  default: { readFileSync: (...args) => readFileSyncMock(...args) },
  readFileSync: (...args) => readFileSyncMock(...args),
}));

// Mock exchangeTokens + createProviderConnection
const exchangeTokensMock = vi.fn();
const createProviderConnectionMock = vi.fn();
vi.mock("../../src/lib/oauth/providers.js", () => ({
  exchangeTokens: (...args) => exchangeTokensMock(...args),
}));
vi.mock("../../src/models/index.js", () => ({
  createProviderConnection: (...args) => createProviderConnectionMock(...args),
}));

let GET, POST;
beforeEach(async () => {
  vi.clearAllMocks();
  readFileSyncMock.mockReset();
  const mod = await import("../../src/app/api/oauth/freebuff/import/route.js");
  GET = mod.GET;
  POST = mod.POST;
});

describe("GET /api/oauth/freebuff/import", () => {
  it("returns the token when credentials.json has authToken", async () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({ authToken: "  cli-token-123  " }));
    const res = await GET();
    expect(res.body.provider).toBe("freebuff");
    expect(res.body.tokenFound).toBe(true);
    expect(res.body.token).toBe("cli-token-123");
  });

  it("reports missing authToken field", async () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({ other: 1 }));
    const res = await GET();
    expect(res.body.tokenFound).toBe(false);
    expect(res.body.error).toContain("no authToken field");
  });

  it("reports missing credentials file with install hint", async () => {
    const err = new Error("ENOENT");
    err.code = "ENOENT";
    readFileSyncMock.mockImplementation(() => { throw err; });
    const res = await GET();
    expect(res.body.tokenFound).toBe(false);
    expect(res.body.error).toContain("Install the CLI");
  });
});

describe("POST /api/oauth/freebuff/import", () => {
  it("validates + persists a pasted authToken", async () => {
    exchangeTokensMock.mockResolvedValue({
      accessToken: "tok-x",
      refreshToken: null,
      expiresIn: 3600,
      providerSpecificData: { authMethod: "auth_token", instanceId: "i1" },
    });
    createProviderConnectionMock.mockResolvedValue({ id: "conn-1", provider: "freebuff", email: "a@b.c" });

    const res = await POST({ json: async () => ({ authToken: "tok-x" }) });
    expect(res.body.success).toBe(true);
    expect(res.body.connection.provider).toBe("freebuff");
    expect(exchangeTokensMock).toHaveBeenCalledWith("freebuff", "tok-x");
    expect(createProviderConnectionMock).toHaveBeenCalledWith(expect.objectContaining({
      provider: "freebuff",
      authType: "oauth",
      accessToken: "tok-x",
      testStatus: "active",
    }));
  });

  it("400 when authToken is missing", async () => {
    const res = await POST({ json: async () => ({}) });
    expect(res.status).toBe(400);
    expect(exchangeTokensMock).not.toHaveBeenCalled();
  });

  it("400 on unparseable body", async () => {
    const res = await POST({ json: async () => { throw new Error("bad json"); } });
    expect(res.status).toBe(400);
  });

  it("500 with message when validation fails upstream", async () => {
    exchangeTokensMock.mockRejectedValue(new Error("Invalid or expired Freebuff authToken"));
    const res = await POST({ json: async () => ({ authToken: "bad" }) });
    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Invalid or expired");
  });
});
