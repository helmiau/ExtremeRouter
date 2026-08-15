import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: vi.fn((body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    })),
  },
}));

const browserDebug = {
  CDP_PORT: 9222,
  CDP_ENDPOINT: "http://127.0.0.1:9222",
  findInstalledBrowser: vi.fn(),
  isCdpReachable: vi.fn(),
};
vi.mock("../../src/lib/browserDebug.js", () => browserDebug);

const connectOverCDPMock = vi.fn();
vi.mock("playwright-core", () => ({
  chromium: { connectOverCDP: (...args) => connectOverCDPMock(...args) },
}));

let POST;

function makeContext({ cookies = [], evaluateResult = null }) {
  const closePage = vi.fn().mockResolvedValue();
  const closeBrowser = vi.fn().mockResolvedValue();
  const page = {
    on: vi.fn(),
    goto: vi.fn().mockResolvedValue(),
    waitForTimeout: vi.fn().mockResolvedValue(),
    evaluate: vi.fn().mockResolvedValue(evaluateResult),
    close: closePage,
  };
  const context = {
    cookies: vi.fn().mockResolvedValue(cookies),
    newPage: async () => page,
  };
  connectOverCDPMock.mockResolvedValue({
    contexts: () => [context],
    close: closeBrowser,
  });
  return { closePage, closeBrowser, context, page };
}

beforeEach(async () => {
  vi.clearAllMocks();
  browserDebug.isCdpReachable.mockResolvedValue(true);
  const mod = await import("../../src/app/api/providers/capture/route.js");
  POST = mod.POST;
});

afterEach(() => {
  vi.restoreAllMocks();
});

const post = (provider) => POST({ json: async () => ({ provider }) });

describe("POST /api/providers/capture", () => {
  it("400 for an unknown provider", async () => {
    const res = await post("does-not-exist");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unknown_provider");
    expect(connectOverCDPMock).not.toHaveBeenCalled();
  });

  it("409 with guidance when no browser is reachable", async () => {
    browserDebug.isCdpReachable.mockResolvedValue(false);
    browserDebug.findInstalledBrowser.mockResolvedValue({ id: "chrome", name: "Google Chrome", path: "x" });
    const res = await post("chatgpt-web");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("browser_not_reachable");
    expect(connectOverCDPMock).not.toHaveBeenCalled();
  });

  it("captures a named cookie for chatgpt-web", async () => {
    makeContext({ cookies: [{ name: "__Secure-next-auth.session-token", value: "tok-abc" }] });
    const res = await post("chatgpt-web");
    expect(res.status).toBe(200);
    expect(res.body.credential).toBe("__Secure-next-auth.session-token=tok-abc");
    expect(res.body.captured).toContain("__Secure-next-auth.session-token");
    expect(res.body.provider).toBe("chatgpt-web");
  });

  it("401 when the required cookie is missing", async () => {
    makeContext({ cookies: [{ name: "_ga", value: "analytics" }] });
    const res = await post("chatgpt-web");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("not_logged_in");
    expect(res.body.missing).toContain("__Secure-next-auth.session-token");
  });

  it("captures multiple cookies for claude-web", async () => {
    makeContext({
      cookies: [
        { name: "sessionKey", value: "sk-1" },
        { name: "cf_clearance", value: "cf-2" },
      ],
    });
    const res = await post("claude-web");
    expect(res.status).toBe(200);
    expect(res.body.credential).toBe("sessionKey=sk-1; cf_clearance=cf-2");
  });

  it("emits the full cookie jar for fullCookieHeader providers", async () => {
    makeContext({
      cookies: [
        { name: "token", value: "t1" },
        { name: "cna", value: "c2" },
      ],
    });
    const res = await post("qwen-web");
    expect(res.status).toBe(200);
    expect(res.body.credential).toBe("token=t1; cna=c2");
  });

  it("reads localStorage for deepseek-web (bare value)", async () => {
    makeContext({ evaluateResult: { userToken: "ds-token" } });
    const res = await post("deepseek-web");
    expect(res.status).toBe(200);
    expect(res.body.credential).toBe("ds-token");
    expect(res.body.captured).toContain("userToken");
  });

  it("treats a JSON placeholder localStorage value as missing (deepseek not logged in)", async () => {
    makeContext({ evaluateResult: { userToken: '{"value":null,"__version":"0"}' } });
    const res = await post("deepseek-web");
    expect(res.status).toBe(401);
    expect(res.body.missing).toContain("userToken");
  });

  it("401 when only part of the required cookies is present (claude missing sessionKey)", async () => {
    makeContext({ cookies: [{ name: "cf_clearance", value: "cf-2" }] });
    const res = await post("claude-web");
    expect(res.status).toBe(401);
    expect(res.body.missing).toContain("sessionKey");
  });
});
