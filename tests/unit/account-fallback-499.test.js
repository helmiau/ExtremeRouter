import { describe, it, expect, vi, beforeEach } from "vitest";

// Client aborts (499) must be a no-op for account health — never lock the
// account, rate-limit vault keys, or trigger fallback/cooldown. The combo
// fusion path aborts straggler panel leaves once quorum is reached, and the
// forced-SSE→JSON path reports client cancellation as 499; neither should
// mark a healthy account unavailable.

const { updateProviderConnectionMock, getProviderConnectionsMock } = vi.hoisted(() => ({
  updateProviderConnectionMock: vi.fn(),
  getProviderConnectionsMock: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: getProviderConnectionsMock,
  validateApiKey: vi.fn(),
  updateProviderConnection: updateProviderConnectionMock,
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
}));

const { checkFallbackError } = await import("../../open-sse/services/accountFallback.js");
const { markAccountUnavailable } = await import("../../src/sse/services/auth.js");

describe("checkFallbackError — client aborts (499)", () => {
  it("returns no-fallback for 499 regardless of error text", () => {
    const result = checkFallbackError(499, "Request aborted", 3);
    expect(result).toEqual({ shouldFallback: false, cooldownMs: 0 });
  });

  it("still falls back for real errors (regression guard)", () => {
    expect(checkFallbackError(429, "rate limit exceeded").shouldFallback).toBe(true);
    expect(checkFallbackError(502, "bad gateway").shouldFallback).toBe(true);
    expect(checkFallbackError(401, "invalid key").shouldFallback).toBe(true);
  });
});

describe("markAccountUnavailable — client aborts (499)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProviderConnectionsMock.mockResolvedValue([]);
    updateProviderConnectionMock.mockResolvedValue(undefined);
  });

  it("is a no-op: no fallback, no cooldown, no account lock, no vault rate-limit", async () => {
    const result = await markAccountUnavailable("conn-1", 499, "Request aborted", "workbuddy", "model-x");

    expect(result).toEqual({ shouldFallback: false, cooldownMs: 0 });
    // Neither connections lookup nor the lock update should run for a 499.
    expect(getProviderConnectionsMock).not.toHaveBeenCalled();
    expect(updateProviderConnectionMock).not.toHaveBeenCalled();
  });

  it("still locks the account for real errors (regression guard)", async () => {
    await markAccountUnavailable("conn-1", 502, "bad gateway", "workbuddy", "model-x");

    expect(getProviderConnectionsMock).toHaveBeenCalled();
    expect(updateProviderConnectionMock).toHaveBeenCalled();
  });
});
