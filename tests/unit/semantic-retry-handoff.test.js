import { describe, it, expect, vi, beforeEach } from "vitest";

// G2-D.2: finalized HTTP-200 semantic failures (usage_only / empty_response /
// no_successful_terminal) with policy.retryable=true may re-run the SAME
// provider pipeline exactly once, bounded by the shared retry accounting. All
// other policies never semantic-retry. Uses the real handleSingleModelChat
// with a scripted executor (no network).

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
  // gemini is NOT forceStream, so handleChatCore honors body.stream:false and
  // takes the non-streaming path (required to exercise the semantic-retry gate;
  // forceStream providers always stream and never reach the canonical-200 gate).
  getModelInfo: async () => ({ provider: "deepseek", model: "deepseek-chat" }),
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
  saveRequestUsage: vi.fn(async () => {}),
}));
vi.mock("@/lib/dataDir.js", () => ({ DATA_DIR: "/tmp/test-data" }));
vi.mock("@/shared/utils/ssrfGuard.js", () => ({ assertPublicUrl: vi.fn() }));

const { handleSingleModelChat } = await import("../../src/sse/handlers/chat.js");
const { shouldSemanticRetry } = await import("../../open-sse/utils/canonicalRetry.js");
const { decideAttemptPolicy } = await import("../../open-sse/utils/canonicalPolicy.js");

// NOTE: handleSingleModelChat takes the request BODY as its first positional
// argument (see callers at chat.js:281/342), NOT a { body } wrapper. stream:false
// must reach chatCore so deepseek (non-forceStream) takes the non-streaming path.
const baseChat = (overrides = {}) =>
  handleSingleModelChat(
    {
      model: "openai/gpt-4o", stream: false, messages: [{ role: "user", content: "hello world" }],
      ...overrides,
    },
    "openai/gpt-4o",
    null,
    null,
    "test-key",
    {},
  );

const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const usageOnlyBody = () => ({ id: "chatcmpl-u", object: "chat.completion", choices: [], usage: { prompt_tokens: 5, completion_tokens: 0 } });
const okBody = () => ({ id: "chatcmpl-x", object: "chat.completion", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }] });

beforeEach(async () => {
  vi.clearAllMocks();
  const cacheMod = await import("../../open-sse/services/semanticCache.js");
  cacheMod.cacheLookup.mockReset();
  cacheMod.cacheLookup.mockImplementation(() => null);
  executeMock.mockResolvedValue({ response: jsonRes(okBody()), url: "https://api.openai.com/v1/chat/completions", headers: {}, transformedBody: null });
  credentialsMock.mockImplementation(async (_provider, excludeConnectionIds) => {
    if (excludeConnectionIds?.has?.("conn-1")) return null;
    return { connectionId: "conn-1", connectionName: "Test Account", apiKey: "sk-test", providerSpecificData: {} };
  });
});

describe("shouldSemanticRetry — pure gate", () => {
  const finalResult = (attempt, retryCount = 0, success = true) => ({
    success,
    response: jsonRes({}),
    retryCount,
    canonicalAttempt: { ...attempt, policy: decideAttemptPolicy(attempt) },
  });

  it("allows exactly the retryable semantic-200 cases", () => {
    for (const [classification, reason] of [
      ["empty_output", "usage_only"],
      ["empty_output", "empty_response"],
      ["incomplete", "no_successful_terminal"],
    ]) {
      const r = finalResult({ source: "provider", transportOk: true, completionState: "incomplete", classification, reason, logicalSuccess: false });
      expect(shouldSemanticRetry(r), `${classification}:${reason}`).toBe(true);
    }
  });

  it("rejects every retryable=false semantic policy", () => {
    for (const [classification, reason] of [
      ["provider_failure", "malformed_json"],
      ["provider_failure", "malformed_sse"],
      ["incomplete", "finish_reason_length"],
      ["cancelled", "provider_cancelled"],
      ["cancelled", "client_abort"],
    ]) {
      const r = finalResult({ source: "provider", transportOk: true, completionState: "failure", classification, reason, logicalSuccess: false });
      expect(shouldSemanticRetry(r), `${classification}:${reason}`).toBe(false);
    }
  });

  it("rejects cache/bypass synthetic and success", () => {
    for (const source of ["cache", "bypass"]) {
      const r = finalResult({ source, transportOk: true, completionState: "success", classification: "success", reason: null, logicalSuccess: true });
      expect(shouldSemanticRetry(r)).toBe(false);
    }
    expect(shouldSemanticRetry(finalResult({ source: "provider", transportOk: true, completionState: "success", classification: "success", reason: null, logicalSuccess: true }))).toBe(false);
  });

  it("rejects missing/provisional policy, transport failures, retry budget consumed, and SSE admission", () => {
    expect(shouldSemanticRetry(null)).toBe(false);
    expect(shouldSemanticRetry({ success: false, response: jsonRes({}) })).toBe(false);
    expect(shouldSemanticRetry(finalResult({ completionState: "unknown", classification: "empty_output", reason: "usage_only" }))).toBe(false);
    expect(shouldSemanticRetry(finalResult({ source: "provider", transportOk: false, completionState: "failure", classification: "transport_failure", reason: "http_429", logicalSuccess: false }))).toBe(false);
    expect(shouldSemanticRetry(finalResult({ source: "provider", transportOk: true, completionState: "incomplete", classification: "empty_output", reason: "usage_only", logicalSuccess: false }, 1))).toBe(false);
    const sse = finalResult({ source: "provider", transportOk: true, completionState: "incomplete", classification: "empty_output", reason: "usage_only", logicalSuccess: false });
    sse.response = new Response("data: [DONE]", { status: 200, headers: { "content-type": "text/event-stream" } });
    expect(shouldSemanticRetry(sse)).toBe(false);
  });
});

describe("handleSingleModelChat — semantic retry handoff (integration)", () => {
  it("Case A/B: usage_only → semantic retry once → attempt 2 success returned", async () => {
    executeMock
      .mockResolvedValueOnce({ response: jsonRes(usageOnlyBody()), url: "u", headers: {}, transformedBody: null })
      .mockResolvedValueOnce({ response: jsonRes(okBody()), url: "ok", headers: {}, transformedBody: null });
    const res = await baseChat();
    expect(executeMock).toHaveBeenCalledTimes(2); // attempt 1 + exactly one retry
    expect(res.success).toBe(true);
    expect(res.response.status).toBe(200);
    // attempt 2's own health lifecycle ran exactly once (attempt 1 empty_output has HEALTH_NONE).
    expect(recordHealthMock).toHaveBeenCalledTimes(1);
  });

  it("Case C: empty_response twice — no third attempt, second result returned", async () => {
    const empty = () => ({ id: "chatcmpl-e", object: "chat.completion", choices: [] });
    executeMock
      .mockResolvedValueOnce({ response: jsonRes(empty()), url: "e1", headers: {}, transformedBody: null })
      .mockResolvedValueOnce({ response: jsonRes(empty()), url: "e2", headers: {}, transformedBody: null });
    const res = await baseChat();
    expect(executeMock).toHaveBeenCalledTimes(2); // exactly-once retry bound
    expect(res.canvas).not.toBeDefined();
    expect(res.retryCount).toBe(1); // semantic retry visible in shared accounting
  });

  it("Case D: malformed JSON — NO semantic retry", async () => {
    executeMock.mockResolvedValueOnce({
      response: new Response("not json", { status: 200, headers: { "content-type": "application/json" } }),
      url: "m", headers: {}, transformedBody: null,
    });
    const res = await baseChat();
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(res.success).toBe(false);
  });

  it("Case E: streaming admission — NO semantic retry", async () => {
    executeMock.mockResolvedValueOnce({
      response: new Response("data: {\"id\":\"x\",\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
      url: "s", headers: {}, transformedBody: null,
    });
    const res = await baseChat({ model: "openai/gpt-4o", stream: true, messages: [{ role: "user", content: "hello" }] });
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(res.success).toBe(true);
  });

  it("Case 15: success is never retried", async () => {
    executeMock.mockResolvedValueOnce({ response: jsonRes(okBody()), url: "ok", headers: {}, transformedBody: null });
    const res = await baseChat();
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(res.success).toBe(true);
  });

  it("forensic: semantic retry keeps requestId stable, gives each execution a distinct attemptId", async () => {
    const saveRequestDetailMock = (await import("../../src/lib/usageDb.js")).saveRequestDetail;
    executeMock
      .mockResolvedValueOnce({ response: jsonRes(usageOnlyBody()), url: "u1", headers: {}, transformedBody: null })
      .mockResolvedValueOnce({ response: jsonRes(okBody()), url: "ok", headers: {}, transformedBody: null });
    const res = await baseChat();
    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(res.success).toBe(true);

    const saved = saveRequestDetailMock.mock.calls;
    const attempts = saved.flatMap(([detail]) => detail.correlation ? [detail.correlation] : []);
    // Attempt 1 + attempt 2 non-streaming successes both persist a correlation.
    const requestIds = new Set(attempts.map((c) => c.requestId));
    const attemptIds = new Set(attempts.map((c) => c.attemptId));
    expect(requestIds.size).toBe(1); // one logical requestId across both executions
    expect(attemptIds.size).toBe(2); // distinct attemptId per physical execution
    // The persisted details themselves (the real production forensic objects)
    // confirm the retry carried a DIFFERENT attemptId than the first execution.
    const persistedCorrelations = saved.map(([detail]) => detail.correlation).filter(Boolean);
    expect(persistedCorrelations.length).toBeGreaterThanOrEqual(2);
    expect(persistedCorrelations[0].attemptId).not.toBe(persistedCorrelations[1].attemptId);
    expect(persistedCorrelations[0].requestId).toBe(persistedCorrelations[1].requestId);
  });
});