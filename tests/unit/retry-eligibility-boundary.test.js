import { describe, it, expect } from "vitest";

// G2-D retry-eligibility boundary: the executor's DEFAULT_RETRY_CONFIG is the
// only same-provider retry vector. Its keys must be a subset of statuses that
// canonicalPolicy marks `retryable:true`; every `retryable:false` status must
// resolve to attempts=0 (so no retry ever fires, even with other budgets).

import { DEFAULT_RETRY_CONFIG, resolveRetryEntry } from "../../open-sse/config/runtimeConfig.js";
import { classifyCanonicalAttempt } from "../../open-sse/utils/canonicalClassification.js";
import { decideAttemptPolicy } from "../../open-sse/utils/canonicalPolicy.js";

// Mirror buildTransportAttempt()'s actual evidence shape (completionType is
// "http_error"; responseStatus carries the real code, so classification derives
// http_5xx / http_<n> from it — never from completionType alone).
function policyForTransportStatus(status) {
  const attempt = {
    source: "provider",
    transportOk: false,
    completionState: "failure",
    completionType: "http_error",
    errorSeen: true,
    abortSeen: false,
    usableOutput: false,
    logicalSuccess: false,
    responseStatus: status,
  };
  const classification = classifyCanonicalAttempt(attempt);
  return decideAttemptPolicy({ ...attempt, ...classification });
}

describe("G2-D retry-eligibility boundary (executor budget vs canonical policy)", () => {
  it("every DEFAULT_RETRY_CONFIG status maps to policy.retryable === true", () => {
    for (const statusKeyStr of Object.keys(DEFAULT_RETRY_CONFIG)) {
      const status = Number(statusKeyStr);
      const policy = policyForTransportStatus(status);
      expect(policy.retryable, `status ${status} should be retryable:true`).toBe(true);
    }
  });

  it("retryable:false transport statuses have no retry budget (attempts=0)", () => {
    for (const status of [400, 401, 403, 404, 405, 406, 413, 415, 422]) {
      const policy = policyForTransportStatus(status);
      expect(policy.retryable, `status ${status} should be retryable:false`).toBe(false);
      // No entry in DEFAULT_RETRY_CONFIG → resolveRetryEntry returns attempts 0.
      expect(resolveRetryEntry(DEFAULT_RETRY_CONFIG[status]).attempts).toBe(0);
    }
  });

  it("non-HTTP retryable:false reasons (provider_error/malformed) have no retry budget", () => {
    for (const reason of ["provider_error", "malformed_json", "malformed_sse"]) {
      const attempt = { source: "provider" };
      const classification = { classification: "provider_failure", reason };
      const policy = decideAttemptPolicy({ ...attempt, ...classification });
      expect(policy.retryable).toBe(false);
      // retryConfig is status-keyed; a provider_failure has no HTTP retry key.
      expect(resolveRetryEntry(undefined).attempts).toBe(0);
    }
  });

  it("rate-limited 429 is policy-retryable but budget-gated to attempts=0 (executor unchanged)", () => {
    const policy = policyForTransportStatus(429);
    expect(policy.retryable).toBe(true);
    // The executor's DEFAULT_RETRY_CONFIG currently gives 429 no attempts;
    // this asserts we do NOT silently add a retry loop for it in G2-D.
    expect(resolveRetryEntry(DEFAULT_RETRY_CONFIG[429]).attempts).toBe(0);
  });
});