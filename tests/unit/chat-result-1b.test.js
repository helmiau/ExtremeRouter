import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  executeMock,
  credentialsMock,
  markAccountUnavailableMock,
  recordHealthMock,
  recordBreakerSuccessMock,
  recordBreakerFailureMock,
} = vi.hoisted(() => ({
  executeMock: vi.fn(),
  credentialsMock: vi.fn(),
  markAccountUnavailableMock: vi.fn(async () => ({ shouldFallback: false })),
  recordHealthMock: vi.fn(),
  recordBreakerSuccessMock: vi.fn(),
  recordBreakerFailureMock: vi.fn(),
}));

// ---- chat.js dependency graph (mocked where it pulls the @/shared aliases
// that fail to resolve in this environment, or where a localDb/file import
// would otherwise blow up the transform pass). The modules under test
// (handleSingleModelChat / handleChatCore) stay REAL.
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ semanticCacheEnabled: true, semanticCacheThreshold: 0.85 }),
  getApiKeyByKey: async () => null,
  getComboByName: async () => null,
}));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "http://localhost:9999/v1" }));
vi.mock("@/lib/pxpipe/manager.js", () => ({ getPxpipeDir: () => null }));
vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: credentialsMock,
  markAccountUnavailable: markAccountUnavailableMock,
  clearAccountError: vi.fn(async () => {}),
  extractApiKey: () => null,
  isValidApiKey: async () => true,
}));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: async () => ({ provider: "openai", model: "gpt-4o" }),
}));
vi.mock("../../src/sse/utils/modelAccess.js", () => ({ assertModelAllowed: () => null }));
vi.mock("../../src/sse/utils/rateLimiter.js", () => ({
  checkRateLimit: () => ({ allowed: true }),
  evictExpiredBuckets: () => {},
  DEFAULT_BURST: 60,
}));
vi.mock("../../src/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_provider, creds) => creds,
  updateProviderCredentials: vi.fn(async () => {}),
}));
vi.mock("../../src/sse/services/comboExecutionPolicy.js", () => ({
  buildComboExecutionGraph: vi.fn(),
  authorizeComboExecution: vi.fn(),
  resolveComboStrategyConfig: vi.fn(),
}));
vi.mock("../../src/sse/services/comboAdmission.js", () => ({
  acquireComboAdmission: vi.fn(),
  wrapResponseWithAdmission: (r) => r,
}));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("open-sse/utils/claudeHeaderCache.js", () => ({ cacheClaudeHeaders: vi.fn() }));
vi.mock("open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: () => null }));
vi.mock("open-sse/utils/openCodeIdentity.js", () => ({ resolveOpenCodeIdentity: () => null }));
vi.mock("open-sse/services/combo.js", () => ({
  handleComboChat: vi.fn(),
  handleFusionChat: vi.fn(),
  handleSwarmChat: vi.fn(),
  handleCascadeChat: vi.fn(),
  handleSmartRoutingChat: vi.fn(),
  detectRequiredCapabilities: () => new Set(),
  applyCapabilityAdapter: (x) => x,
  DEFAULT_CAPABILITY_FALLBACK_MODEL: "openai/gpt-4o-mini",
}));
vi.mock("open-sse/services/comboBudget.js", () => ({
  createComboBudget: () => ({ ok: true, code: "ok" }),
}));
vi.mock("open-sse/services/projectId.js", () => ({ getProjectIdForConnection: async () => "proj" }));
vi.mock("open-sse/services/circuitBreaker.js", () => ({
  recordBreakerSuccess: recordBreakerSuccessMock,
  recordBreakerFailure: recordBreakerFailureMock,
  isRetryableFailure: (s) => [429, 500, 502, 503, 504].includes(s),
  releaseBreakerProbe: vi.fn(),
  breakerKey: () => "breaker-test",
}));
vi.mock("open-sse/services/healthMonitor.js", () => ({ recordHealthSample: recordHealthMock }));

// ---- chatCore graph (mirrors cache-hit-result.test.js)

vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: true, execute: executeMock }),
}));
vi.mock("open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));
vi.mock("open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
}));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn(), default: vi.fn() }));

// chatCore imports its peers via relative paths (`../executors/index.js`, …).
// Register the `../../open-sse/…` (from tests/unit) form too so both resolve to
// the same mocked module id in this alias-broken environment.
vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: true, execute: executeMock }),
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));
vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
}));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn(), default: vi.fn() }));
vi.mock("../../open-sse/services/semanticCache.js", () => ({
  isCacheable: vi.fn(() => true),
  cacheLookup: vi.fn(() => null),
  cacheStore: vi.fn(),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));
vi.mock("@/lib/dataDir.js", () => ({ DATA_DIR: "/tmp/test-data" }));
vi.mock("@/shared/utils/ssrfGuard.js", () => ({ assertPublicUrl: vi.fn() }));

const { handleSingleModelChat } = await import("../../src/sse/handlers/chat.js");

const baseChat = (overrides = {}) =>
  handleSingleModelChat(
    {
      body: { model: "openai/gpt-4o", stream: false, messages: [{ role: "user", content: "hello world" }] },
      ...overrides,
    },
    "openai/gpt-4o",
    null,
    null,
    "test-key",
    {},
  );

beforeEach(async () => {
  vi.clearAllMocks();
  const cacheMod = await import("../../open-sse/services/semanticCache.js");
  cacheMod.cacheLookup.mockReset();
  cacheMod.cacheLookup.mockImplementation(() => null);
  executeMock.mockResolvedValue({
    response: new Response(JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
    url: "https://api.openai.com/v1/chat/completions",
    headers: {},
    transformedBody: null,
  });
  credentialsMock.mockResolvedValue({
    connectionId: "conn-1",
    connectionName: "Test Account",
    apiKey: "sk-test",
    providerSpecificData: {},
  });
});

describe("handleSingleModelChat → ChatResult (Wave 1B)", () => {
  it("contract invariant: every outcome returns { success: boolean, response: Response }", async () => {
    const ok = await baseChat();
    expect(typeof ok.success).toBe("boolean");
    expect(ok.response).toBeInstanceOf(Response);

    executeMock.mockResolvedValue({
      response: new Response(JSON.stringify({ error: { message: "boom" } }), { status: 503, headers: { "content-type": "application/json" } }),
      url: "https://api.openai.com/v1/chat/completions",
      headers: {},
      transformedBody: null,
    });
    const failed = await baseChat();
    expect(typeof failed.success).toBe("boolean");
    expect(failed.response).toBeInstanceOf(Response);
  });

  it("provider success: success=true, response preserved, health success recorded", async () => {
    const res = await baseChat();
    expect(res.success).toBe(true);
    expect(res.response.status).toBe(200);
    expect(recordHealthMock).toHaveBeenCalledWith(
      "openai",
      expect.objectContaining({ success: true }),
      expect.anything()
    );
    expect(recordBreakerSuccessMock).toHaveBeenCalled();
  });

  it("provider failure: success=false, status+error preserved, health failure recorded", async () => {
    executeMock.mockResolvedValue({
      response: new Response(JSON.stringify({ error: { message: "boom" } }), { status: 503, headers: { "content-type": "application/json" } }),
      url: "https://api.openai.com/v1/chat/completions",
      headers: {},
      transformedBody: null,
    });
    const res = await baseChat();
    expect(res.success).toBe(false);
    expect(res.status).toBe(503);
    expect(res.response.status).toBe(503);
    expect(recordHealthMock).toHaveBeenCalledWith(
      "openai",
      expect.objectContaining({ success: false, status: 503 }),
      expect.anything()
    );
    expect(markAccountUnavailableMock).toHaveBeenCalled();
    expect(recordBreakerFailureMock).toHaveBeenCalled();
  });

  it("cache hit: success=true, fromCache=true preserved through the envelope", async () => {
    const mod = await import("../../open-sse/services/semanticCache.js");
    mod.cacheLookup.mockReturnValueOnce({
      response: new Response(JSON.stringify({
        id: "chatcmpl-cached",
        object: "chat.completion",
        model: "gpt-4o",
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        choices: [{ message: { role: "assistant", content: "cached reply" }, finish_reason: "stop", index: 0 }],
      }), { status: 200, headers: { "content-type": "application/json" } }),
      similarity: 0.99,
      exact: true,
    });

    const res = await baseChat();
    expect(res.success).toBe(true);
    expect(res.fromCache).toBe(true);
    expect(res.cacheSimilarity).toBe(0.99);
    expect(res.response.status).toBe(200);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("streaming: response body is a growth streaming Response and is not consumed by this function", async () => {
    // Ensure this request is NOT served from cache (the cache test above left
    // cacheLookup returning a hit; reset it to null so the executor runs).
    const cacheMod = await import("../../open-sse/services/semanticCache.js");
    cacheMod.cacheLookup.mockReturnValue(null);
    executeMock.mockResolvedValue({
      response: new Response(
        "data: {\"id\":\"x\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hi\"},\"finish_reason\":null}]}\n\ndata: [DONE]\n\n",
        { status: 200, headers: { "content-type": "text/event-stream" } }
      ),
      url: "https://api.openai.com/v1/chat/completions",
      headers: {},
      transformedBody: null,
    });
    const res = await baseChat({ body: { model: "openai/gpt-4o", stream: true, messages: [{ role: "user", content: "hello world" }] } });
    console.log("STREAM RESULT:", JSON.stringify({ success: res.success, status: res.status, error: res.error }));
    expect(res.success).toBe(true);
    expect(res.response.body).toBeInstanceOf(ReadableStream);
    // handleSingleModelChat must not consume the body: the returned stream is
    // still readable/undrained. Pump and drain it to prove no upstream write
    // was awaited by the handler.
    const collected = [];
    const reader = res.response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      collected.push(value);
    }
    // The stream is still live when handleSingleModelChat returns (it never
    // consumed or closed the body) — draining it now still yields the
    // provider's translated chunks. ([DONE] synthesis lives in the real
    // passthrough flush, which this suite mocks out.)
    expect(collected.length).toBeGreaterThanOrEqual(1);
    const text = collected.map((c) => new TextDecoder().decode(c)).join("");
    expect(text).toContain("\"id\":\"x\"");
  });
});