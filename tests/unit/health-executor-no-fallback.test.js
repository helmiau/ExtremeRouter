import { describe, it, expect, vi, beforeEach } from "vitest";

// Commit G2-C.1: prove executeHealthAction is a PURE health executor.
// It MUST NOT return or leak any fallback/candidate-progression signal
// (shouldFallback / fallbackEligible / retryable / stopProgression /
// nextCandidate / nextAccount). It only:
//   - records health samples when healthAction.sample != none
//   - mutates breaker state under existing guards (isRetryableFailure/skipBreaker)
//
// Spec §18: "executeHealthAction() returns no fallback signal" AND the post-core
// failure block must not cause candidate progression because of health.

const { healthMock, breakerSuccessMock, breakerFailureMock, releaseProbeMock, accountUnavailableMock } = vi.hoisted(() => ({
  healthMock: vi.fn(),
  breakerSuccessMock: vi.fn(),
  breakerFailureMock: vi.fn(),
  releaseProbeMock: vi.fn(),
  accountUnavailableMock: vi.fn(async () => ({ shouldFallback: true })),
}));

vi.mock("open-sse/services/healthMonitor.js", () => ({ recordHealthSample: healthMock }));
vi.mock("open-sse/services/circuitBreaker.js", () => ({
  recordBreakerSuccess: breakerSuccessMock,
  recordBreakerFailure: breakerFailureMock,
  releaseBreakerProbe: releaseProbeMock,
  isRetryableFailure: (status) => [0, 429, 500, 502, 503, 504].includes(Number(status)),
  breakerKey: () => "breaker-test",
}));
vi.mock("../../src/sse/services/auth.js", () => ({
  markAccountUnavailable: accountUnavailableMock,
  getProviderCredentials: vi.fn(async () => null),
  clearAccountError: vi.fn(async () => {}),
  extractApiKey: () => null,
  isValidApiKey: async () => true,
}));

vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({}), getApiKeyByKey: async () => null, getComboByName: async () => null }));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "http://localhost:9999/v1" }));
vi.mock("@/lib/pxpipe/manager.js", () => ({ getPxpipeDir: () => null }));
vi.mock("../../src/sse/services/model.js", () => ({ getModelInfo: async () => ({}) }));
vi.mock("../../src/sse/utils/modelAccess.js", () => ({ assertModelAllowed: () => null }));
vi.mock("../../src/sse/utils/rateLimiter.js", () => ({ checkRateLimit: () => ({ allowed: true }), evictExpiredBuckets: () => {} }));
vi.mock("../../src/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({ checkAndRefreshToken: async (_p, c) => c, updateProviderCredentials: vi.fn(async () => {}) }));
vi.mock("../../src/sse/services/comboExecutionPolicy.js", () => ({
  buildComboExecutionGraph: vi.fn(),
  authorizeComboExecution: vi.fn(),
  resolveComboStrategyConfig: vi.fn(),
}));
vi.mock("../../src/sse/services/comboAdmission.js", () => ({ acquireComboAdmission: vi.fn(), wrapResponseWithAdmission: (r) => r }));
vi.mock("open-sse/index.js", () => ({}));
vi.mock("open-sse/utils/claudeHeaderCache.js", () => ({ cacheClaudeHeaders: vi.fn() }));
vi.mock("open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: () => null }));
vi.mock("open-sse/utils/openCodeIdentity.js", () => ({ resolveOpenCodeIdentity: () => null }));
vi.mock("open-sse/services/combo.js", () => ({
  handleComboChat: vi.fn(), handleFusionChat: vi.fn(), handleSwarmChat: vi.fn(),
  handleCascadeChat: vi.fn(), handleSmartRoutingChat: vi.fn(),
  detectRequiredCapabilities: () => new Set(), applyCapabilityAdapter: (x) => x,
  DEFAULT_CAPABILITY_FALLBACK_MODEL: "openai/gpt-4o-mini",
}));
vi.mock("open-sse/services/comboBudget.js", () => ({ createComboBudget: () => ({ ok: true, code: "ok" }) }));
vi.mock("open-sse/services/projectId.js", () => ({ getProjectIdForConnection: async () => "proj" }));
vi.mock("@/lib/usageDb.js", () => ({ trackPendingRequest: vi.fn(), appendRequestLog: vi.fn(async () => {}), saveRequestDetail: vi.fn(async () => {}) }));
vi.mock("@/shared/utils/ssrfGuard.js", () => ({ assertPublicUrl: vi.fn() }));

const { executeHealthAction } = await import("../../src/sse/handlers/chat.js");

beforeEach(() => {
  vi.clearAllMocks();
});

const ctx = {
  provider: "openai",
  latencyMs: 10,
  status: 500,
  error: "boom",
  connectionId: "conn-1",
  model: "gpt-4o",
  resetsAtMs: null,
  vaultKey: null,
  skipBreaker: false,
  breakerKeyVal: "breaker-test",
  chatSettings: {},
};

describe("executeHealthAction — no fallback signal (G2-C.1)", () => {
  it("returns nothing (undefined) — no shouldFallback / fallbackEligible / stopProgression", async () => {
    const policy = { fallbackEligible: true, retryable: true, stopProgression: false, healthAction: { sample: "failure", availability: "unavailable", reason: "transient" } };
    const res = await executeHealthAction(policy.healthAction, ctx);
    expect(res).toBeUndefined();
  });

  it("availability=unavailable does NOT mark account unavailable from the executor", async () => {
    await executeHealthAction({ sample: "failure", availability: "unavailable", reason: "transient" }, ctx);
    expect(accountUnavailableMock).not.toHaveBeenCalled();
  });

  it("success sample → recordHealthSample(success) + breaker success (exactly once)", async () => {
    await executeHealthAction({ sample: "success", availability: "none", reason: null }, ctx);
    expect(healthMock).toHaveBeenCalledWith("openai", expect.objectContaining({ success: true }), expect.anything());
    expect(breakerSuccessMock).toHaveBeenCalled();
    expect(healthMock.mock.calls.length).toBe(1);
  });

  it("failure sample (retryable 5xx) → failure sample + breaker failure exactly once", async () => {
    await executeHealthAction({ sample: "failure", availability: "unavailable", reason: "transient" }, ctx);
    expect(healthMock).toHaveBeenCalledWith("openai", expect.objectContaining({ success: false, status: 500 }), expect.anything());
    expect(breakerFailureMock).toHaveBeenCalled();
    expect(healthMock.mock.calls.length).toBe(1);
  });

  it("401/403 → failure sample + breaker NOT failed (isRetryableFailure=false)", async () => {
    await executeHealthAction({ sample: "failure", availability: "unavailable", reason: "auth" }, { ...ctx, status: 401 });
    expect(healthMock).toHaveBeenCalled();
    expect(breakerFailureMock).not.toHaveBeenCalled();
  });

  it("skipBreaker=true → no breaker mutation, sample still recorded", async () => {
    await executeHealthAction({ sample: "failure", availability: "none", reason: null }, { ...ctx, skipBreaker: true });
    expect(healthMock).toHaveBeenCalled();
    expect(breakerSuccessMock).not.toHaveBeenCalled();
    expect(breakerFailureMock).not.toHaveBeenCalled();
  });

  it("client_abort (sample none) → zero health mutation", async () => {
    await executeHealthAction({ sample: "none", availability: "none", reason: null }, { ...ctx, skipBreaker: false });
    expect(healthMock).not.toHaveBeenCalled();
    expect(breakerFailureMock).not.toHaveBeenCalled();
  });
});