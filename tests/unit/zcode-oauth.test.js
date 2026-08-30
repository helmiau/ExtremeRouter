import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// proxyFetch transitively imports @/shared/utils/ssrfGuard.js which the vitest
// alias map doesn't resolve — mock it like the other gateway unit suites do.
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));
vi.mock("@/shared/utils/ssrfGuard.js", () => ({ assertPublicUrl: vi.fn() }));

import { ZcodeService, ZCODE_DEFAULTS, zcodeEnvelopeOk } from "../../src/lib/oauth/services/zcode.js";
import REGISTRY from "open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_OAUTH, PROVIDER_MODELS } from "open-sse/providers/index.js";
import { getExecutor, GlmExecutor } from "open-sse/executors/index.js";
import { parseGlmEffortTier } from "../../open-sse/executors/glm.js";

// ── fetch mock plumbing ────────────────────────────────────────────────────
let fetchCalls;
let fetchResponses; // url matcher → payload
const envelope = (data, code = 0, msg = "ok") => ({ code, msg, data });

function mockFetch() {
  fetchCalls = [];
  return vi.fn(async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });
    // Longest matcher first so "/api_keys/copy/..." wins over "/api_keys".
    for (const [matcher, payload] of [...fetchResponses.entries()].sort((a, b) => b[0].length - a[0].length)) {
      if (String(url).includes(matcher)) {
        return {
          ok: true,
          status: 200,
          json: async () => typeof payload === "function" ? payload(url, options) : payload,
        };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

beforeEach(() => {
  fetchResponses = new Map();
  vi.stubGlobal("fetch", mockFetch());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("zcode registry entry", () => {
  const entry = REGISTRY.find((p) => p.id === "zcode");

  it("registers as an OAuth provider with dual auth modes", () => {
    expect(entry).toBeTruthy();
    expect(entry.category).toBe("oauth");
    expect(entry.hasOAuth).toBe(true);
    expect(entry.authModes).toEqual(["oauth", "apikey"]);
  });

  it("builds PROVIDERS + PROVIDER_OAUTH from the entry", () => {
    expect(PROVIDERS.zcode.baseUrl).toBe("https://api.z.ai/api/coding/paas/v4/chat/completions");
    expect(PROVIDER_OAUTH.zcode.baseUrl).toBe("https://zcode.z.ai/api/v1");
    expect(PROVIDER_OAUTH.zcode.provider).toBe("zai");
  });

  it("mirrors the GLM Coding endpoint contract (cross-transport)", () => {
    const openai = entry.transports.find((t) => t.format === "openai");
    const claude = entry.transports.find((t) => t.format === "claude");
    expect(openai.baseUrl).toBe("https://api.z.ai/api/coding/paas/v4/chat/completions");
    expect(openai.auth).toEqual({ combined: true, header: "Authorization", scheme: "bearer" });
    expect(claude.baseUrl).toBe("https://api.z.ai/api/anthropic/v1/messages");
    expect(claude.auth).toEqual({ combined: true, header: "x-api-key", scheme: "raw" });
  });

  it("exposes the GLM catalog with 5.3 effort tiers resolved to the base id", () => {
    const models = PROVIDER_MODELS.zcode;
    const ids = models.map((m) => m.id);
    expect(ids).toContain("glm-5.3");
    expect(ids).toContain("glm-5.3-high");
    expect(ids).toContain("glm-5.2");
    const tier = models.find((m) => m.id === "glm-5.3-high");
    expect(tier.upstreamModelId).toBe("glm-5.3");
  });
});

describe("zcode executor", () => {
  it("maps zcode to the GLM executor (shared effort-tier handling)", () => {
    const executor = getExecutor("zcode");
    expect(executor).toBeInstanceOf(GlmExecutor);
  });

  it("resolves glm-5.3 effort tiers", () => {
    expect(parseGlmEffortTier("glm-5.3-high")).toEqual({ baseModel: "glm-5.3", effort: "high" });
    expect(parseGlmEffortTier("glm-5.3-low")).toEqual({ baseModel: "glm-5.3", effort: "low" });
    expect(parseGlmEffortTier("glm-5.3")).toBeNull();
  });
});

describe("zcodeEnvelopeOk", () => {
  it("accepts the Z.ai business success codes", () => {
    for (const code of [0, 200, "0", "200"]) expect(zcodeEnvelopeOk(code)).toBe(true);
    for (const code of [1, 400, 500, "404", null, undefined]) expect(zcodeEnvelopeOk(code)).toBe(false);
  });
});

describe("ZcodeService.initiateDeviceFlow", () => {
  it("POSTs init with a 32-byte hex pollToken and the zai provider", async () => {
    fetchResponses.set("/oauth/cli/init", envelope({
      flow_id: "flow-123",
      poll_token: "server-token",
      authorize_url: "https://zcode.z.ai/oauth/authorize?flow=flow-123",
      expires_at: Math.floor(Date.now() / 1000) + 300,
      poll_interval_sec: 5,
    }));
    const svc = new ZcodeService();
    const flow = await svc.initiateDeviceFlow();

    expect(flow.flowId).toBe("flow-123");
    expect(flow.authorizeUrl).toContain("flow=flow-123");
    expect(flow.pollIntervalSec).toBe(5);
    // Locally generated pollToken: 64 hex chars (32 bytes)
    expect(flow.pollToken).toMatch(/^[0-9a-f]{64}$/);

    const call = fetchCalls[0];
    expect(call.url).toBe(`${ZCODE_DEFAULTS.baseUrl}/oauth/cli/init`);
    expect(call.options.method).toBe("POST");
    expect(call.options.headers.Authorization).toBe(`Bearer ${flow.pollToken}`);
    expect(JSON.parse(call.options.body)).toEqual({ provider: "zai" });
  });

  it("throws on business error envelopes", async () => {
    fetchResponses.set("/oauth/cli/init", envelope(null, 500, "org quota exhausted"));
    const svc = new ZcodeService();
    await expect(svc.initiateDeviceFlow()).rejects.toThrow(/org quota exhausted/);
  });
});

describe("ZcodeService.pollDeviceFlow", () => {
  it("returns pending without touching api.z.ai", async () => {
    fetchResponses.set("/oauth/cli/poll", envelope({ status: "pending" }));
    const svc = new ZcodeService();
    const result = await svc.pollDeviceFlow({ flowId: "flow-1", pollToken: "tok" });
    expect(result).toEqual({ status: "pending" });
    expect(fetchCalls).toHaveLength(1);
  });

  it("returns failed status verbatim", async () => {
    fetchResponses.set("/oauth/cli/poll", envelope({ status: "failed" }));
    const svc = new ZcodeService();
    const result = await svc.pollDeviceFlow({ flowId: "flow-1", pollToken: "tok" });
    expect(result).toEqual({ status: "failed" });
  });

  it("returns ready with the zai access token + user profile", async () => {
    fetchResponses.set("/oauth/cli/poll", envelope({
      status: "ready",
      token: "zcode-jwt",
      user: { user_id: "u-1", email: "dev@example.com", name: "Dev" },
      zai: { access_token: "zai-oauth-token" },
    }));
    const svc = new ZcodeService();
    const result = await svc.pollDeviceFlow({ flowId: "flow-1", pollToken: "tok" });
    expect(result.status).toBe("ready");
    expect(result.zaiAccessToken).toBe("zai-oauth-token");
    expect(result.user).toEqual({ userId: "u-1", email: "dev@example.com", name: "Dev" });
    // poll authenticates with the locally generated pollToken, not the JWT
    expect(fetchCalls[0].options.headers.Authorization).toBe("Bearer tok");
  });

  it("rejects a ready response without a zai access token", async () => {
    fetchResponses.set("/oauth/cli/poll", envelope({ status: "ready", token: "jwt" }));
    const svc = new ZcodeService();
    await expect(svc.pollDeviceFlow({ flowId: "flow-1", pollToken: "tok" })).rejects.toThrow(/Invalid ZCode poll response/);
  });

  it("requires flowId and pollToken", async () => {
    const svc = new ZcodeService();
    await expect(svc.pollDeviceFlow({ flowId: "", pollToken: "tok" })).rejects.toThrow(/Missing/);
  });
});

describe("ZcodeService.resolveCodingPlanApiKey", () => {
  function mockHappyPath({ existingKey = false } = {}) {
    fetchResponses.set("/api/auth/z/login", envelope({ access_token: "biz-token" }));
    fetchResponses.set("/api/biz/customer/getCustomerInfo", envelope({
      organizations: [
        { organizationId: "org-2", organizationName: "Other Org", projects: [{ projectId: "proj-2", projectName: "P2" }] },
        { organizationId: "org-1", organizationName: "默认机构", projects: [{ projectId: "proj-1", projectName: "默认项目" }] },
      ],
    }));
    if (existingKey) {
      fetchResponses.set("/api_keys", envelope([{ name: "zcode-api-key", apiKey: "key-1" }]));
    } else {
      fetchResponses.set("/api_keys", (url, options) => {
        if (options?.method === "POST") return envelope({ name: "zcode-api-key", apiKey: "key-9" });
        return envelope([]);
      });
    }
    fetchResponses.set("/api_keys/copy", envelope({ secretKey: "secret-1" }));
  }

  it("derives '<id>.<secret>' through the 4-step exchange chain", async () => {
    mockHappyPath({ existingKey: true });
    const svc = new ZcodeService();
    const apiKey = await svc.resolveCodingPlanApiKey("zai-oauth-token");

    expect(apiKey).toBe("key-1.secret-1");

    const urls = fetchCalls.map((c) => c.url);
    expect(urls[0]).toBe("https://api.z.ai/api/auth/z/login");
    expect(JSON.parse(fetchCalls[0].options.body)).toEqual({ token: "zai-oauth-token" });
    expect(urls[1]).toBe("https://api.z.ai/api/biz/customer/getCustomerInfo");
    expect(urls[2]).toContain("/api/biz/v1/organization/org-1/projects/proj-1/api_keys");
    // Uses the pre-existing named key (no POST create)
    expect(fetchCalls.filter((c) => c.options?.method === "POST" && c.url.includes("/api_keys")).filter((c) => !c.url.includes("z/login"))).toHaveLength(0);
    expect(urls[urls.length - 1]).toBe("https://api.z.ai/api/biz/v1/organization/org-1/projects/proj-1/api_keys/copy/key-1");
    // Chain calls after login authenticate with the biz token
    expect(fetchCalls[1].options.headers.Authorization).toBe("Bearer biz-token");
  });

  it("creates the zcode-api-key when the account has none", async () => {
    mockHappyPath({ existingKey: false });
    const svc = new ZcodeService();
    const apiKey = await svc.resolveCodingPlanApiKey("zai-oauth-token");
    expect(apiKey).toBe("key-9.secret-1");
    const createCall = fetchCalls.find((c) => c.options?.method === "POST" && c.url.includes("/api_keys") && !c.url.includes("z/login"));
    expect(createCall).toBeTruthy();
    expect(JSON.parse(createCall.options.body)).toEqual({ name: "zcode-api-key" });
  });

  it("throws when the login envelope lacks access_token", async () => {
    fetchResponses.set("/api/auth/z/login", envelope({}));
    const svc = new ZcodeService();
    await expect(svc.resolveCodingPlanApiKey("tok")).rejects.toThrow(/missing access_token/);
  });

  it("throws when org/project cannot be resolved", async () => {
    fetchResponses.set("/api/auth/z/login", envelope({ access_token: "biz" }));
    fetchResponses.set("/api/biz/customer/getCustomerInfo", envelope({ organizations: [] }));
    const svc = new ZcodeService();
    await expect(svc.resolveCodingPlanApiKey("tok")).rejects.toThrow(/organization and project/);
  });

  it("throws when the copy response lacks secretKey", async () => {
    fetchResponses.set("/api/auth/z/login", envelope({ access_token: "biz" }));
    fetchResponses.set("/api/biz/customer/getCustomerInfo", envelope({
      organizations: [{ organizationId: "o", organizationName: "x", projects: [{ projectId: "p", projectName: "y" }] }],
    }));
    fetchResponses.set("/api_keys", envelope([{ name: "zcode-api-key", apiKey: "k" }]));
    fetchResponses.set("/api_keys/copy", envelope({}));
    const svc = new ZcodeService();
    await expect(svc.resolveCodingPlanApiKey("tok")).rejects.toThrow(/missing secretKey/);
  });
});

describe("zcode oauth provider entry (providers.js)", () => {
  it("is registered with the device_code flow", async () => {
    const { getProvider, getProviderNames } = await import("../../src/lib/oauth/providers.js");
    expect(getProviderNames()).toContain("zcode");
    const provider = getProvider("zcode");
    expect(provider.flowType).toBe("device_code");
    expect(typeof provider.requestDeviceCode).toBe("function");
    expect(typeof provider.pollToken).toBe("function");
    expect(typeof provider.mapTokens).toBe("function");
  });

  it("pollToken maps a ready flow to connection tokens with the derived apiKey", async () => {
    fetchResponses.set("/oauth/cli/poll", envelope({
      status: "ready",
      token: "zcode-jwt",
      user: { user_id: "u-1", email: "dev@example.com", name: "Dev" },
      zai: { access_token: "zai-oauth-token" },
    }));
    fetchResponses.set("/api/auth/z/login", envelope({ access_token: "biz-token" }));
    fetchResponses.set("/api/biz/customer/getCustomerInfo", envelope({
      organizations: [{ organizationId: "org-1", organizationName: "默认机构", projects: [{ projectId: "proj-1", projectName: "默认项目" }] }],
    }));
    fetchResponses.set("/api_keys", envelope([{ name: "zcode-api-key", apiKey: "key-1" }]));
    fetchResponses.set("/api_keys/copy", envelope({ secretKey: "secret-1" }));

    const { getProvider } = await import("../../src/lib/oauth/providers.js");
    const provider = getProvider("zcode");
    const result = await provider.pollToken(
      PROVIDER_OAUTH.zcode,
      "flow-1",
      null,
      { _zcodePollToken: "poll-token" },
    );
    expect(result.ok).toBe(true);
    expect(result.data.access_token).toBe("zai-oauth-token");
    expect(result.data._zcodeApiKey).toBe("key-1.secret-1");

    const tokens = provider.mapTokens(result.data);
    expect(tokens).toMatchObject({
      accessToken: "zai-oauth-token",
      apiKey: "key-1.secret-1",
      refreshToken: null,
      email: "dev@example.com",
      displayName: "Dev",
    });
    expect(tokens.providerSpecificData).toEqual({ authMethod: "device", userId: "u-1" });
  });

  it("pollToken reports pending without creating tokens", async () => {
    fetchResponses.set("/oauth/cli/poll", envelope({ status: "pending" }));
    const { getProvider } = await import("../../src/lib/oauth/providers.js");
    const provider = getProvider("zcode");
    const result = await provider.pollToken(PROVIDER_OAUTH.zcode, "flow-1", null, { _zcodePollToken: "poll-token" });
    expect(result).toEqual({ ok: true, data: { error: "authorization_pending" } });
  });

  it("pollToken fails cleanly without the poll token", async () => {
    const { getProvider } = await import("../../src/lib/oauth/providers.js");
    const provider = getProvider("zcode");
    const result = await provider.pollToken(PROVIDER_OAUTH.zcode, "flow-1", null, {});
    expect(result.ok).toBe(false);
    expect(result.data.error).toBe("invalid_request");
  });
});
