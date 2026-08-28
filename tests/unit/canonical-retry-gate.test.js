import { describe, it, expect, vi, beforeEach } from "vitest";

// G2-D.1: canonicalAttempt.policy.retryable is the authoritative eligibility
// gate for same-provider retry. retryable=false forbids retry even with a
// status-based retry budget; retryable=true only permits (budget still decides).

import { decideAttemptPolicy } from "../../open-sse/utils/canonicalPolicy.js";
import { isCanonicalRetryEligible, retryEligibilityForTransport } from "../../open-sse/utils/canonicalRetry.js";

const fetchMock = vi.fn();
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: (...args) => fetchMock(...args),
}));
const { BaseExecutor } = await import("../../open-sse/executors/base.js");

const final = (policy) => ({ source: "provider", completionState: "failure", policy });
const mk = (classification, reason, source = "provider") => decideAttemptPolicy({ source, classification, reason });

const res = (status) => ({ status, headers: { get: () => "" } });
const creds = { apiKey: "k" };

beforeEach(() => fetchMock.mockReset());

describe("isCanonicalRetryEligible — policy-driven matrix", () => {
  it("retryable=false reasons are forbidden", () => {
    const cases = [
      mk("transport_failure", "http_400"),
      mk("transport_failure", "http_401"),
      mk("transport_failure", "http_403"),
      mk("transport_failure", "http_404"),
      mk("transport_failure", "http_405"),
      mk("transport_failure", "http_406"),
      mk("transport_failure", "http_413"),
      mk("transport_failure", "http_415"),
      mk("transport_failure", "http_422"),
      mk("provider_failure", "provider_error"),
      mk("provider_failure", "malformed_json"),
      mk("provider_failure", "malformed_sse"),
      mk("incomplete", "finish_reason_length"),
      mk("cancelled", "provider_cancelled"),
      mk("cancelled", "client_abort"),
      decideAttemptPolicy({ source: "cache", classification: "transport_failure", reason: "http_500" }),
      decideAttemptPolicy({ source: "bypass", classification: "transport_failure", reason: "http_500" }),
    ];
    for (const policy of cases) {
      expect(isCanonicalRetryEligible(final(policy))).toBe(false);
    }
  });

  it("retryable=true reasons are permitted (budget still decides)", () => {
    const cases = [
      mk("transport_failure", "http_429"),
      mk("transport_failure", "http_5xx"),
      mk("empty_output", "usage_only"),
      mk("empty_output", "empty_response"),
      mk("incomplete", "no_successful_terminal"),
    ];
    for (const policy of cases) {
      expect(isCanonicalRetryEligible(final(policy))).toBe(true);
    }
  });

  it("missing/unfinalized policy returns null (legacy compatibility)", () => {
    expect(isCanonicalRetryEligible(null)).toBe(null);
    expect(isCanonicalRetryEligible(undefined)).toBe(null);
    expect(isCanonicalRetryEligible({ completionState: "unknown", policy: { retryable: true } })).toBe(null);
    expect(isCanonicalRetryEligible({ completionState: "failure" })).toBe(null);
    expect(isCanonicalRetryEligible({ completionState: "failure", policy: {} })).toBe(null);
  });
});

describe("retryEligibilityForTransport — executor boundary", () => {
  it("transport statuses map to the same policy retryable value", () => {
    for (const status of [400, 401, 403, 404, 405, 406, 413, 415, 422]) {
      expect(retryEligibilityForTransport(status)).toBe(false);
    }
    for (const status of [429, 500, 502, 503, 504]) {
      expect(retryEligibilityForTransport(status)).toBe(true);
    }
  });
});

describe("BaseExecutor.execute — policy gate overrides status retry config", () => {
  it("OVERRIDE: retryable=false (404) with retry budget → NO retry", async () => {
    // A hypothetical provider config that would otherwise retry a 404.
    const ex = new BaseExecutor("test", { baseUrl: "https://x/api", retry: { 404: { attempts: 3, delayMs: 0 } } });
    fetchMock.mockResolvedValue(res(404));
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1); // gate blocked the retry
  });

  it("ALLOW: retryable=true (503) with retry budget → retry occurs", async () => {
    const ex = new BaseExecutor("test", { baseUrl: "https://x/api", retry: { 503: { attempts: 2, delayMs: 0 } } });
    fetchMock
      .mockResolvedValueOnce(res(503))
      .mockResolvedValueOnce(res(200));
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("BUDGET EXHAUSTION: retryable=true but attempts exhausted → NO extra retry", async () => {
    const ex = new BaseExecutor("test", { baseUrl: "https://x/api", retry: { 503: { attempts: 1, delayMs: 0 } } });
    fetchMock.mockResolvedValue(res(503));
    const out = await ex.execute({ model: "m", body: {}, stream: false, credentials: creds });
    expect(out.response.status).toBe(503);
    // 1 initial + 1 retry (attempts=1), then budget exhausted.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});