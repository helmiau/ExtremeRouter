import { describe, it, expect } from "vitest";

// Commit G2-A: canonical attempt policy engine — pure-function test matrix.
// Every classification/reason pair defined by the G2-A spec gets an explicit
// row. Plus contradiction guards, determinism, and field-bound assertions.
// No production code is executed by this suite — `decideAttemptPolicy` is pure.

import { decideAttemptPolicy, ATTEMPT_POLICY_FIELDS } from "../../open-sse/utils/canonicalPolicy.js";
import { createCanonicalAttemptFromNonStreaming } from "../../open-sse/utils/nonStreamingAttempt.js";

// Minimal finalized canonicalAttempt shape — policy reads only source/classification/reason.
const attempt = (classification, reason, source = "provider") => ({
  source,
  classification,
  reason,
  transportOk: classification === "transport_failure" ? false : true,
  completionState: classification === "cancelled" ? "cancelled" : classification === "success" ? "success" : "incomplete",
  errorSeen: classification === "provider_failure" || classification === "transport_failure",
  abortSeen: classification === "cancelled" && reason === "client_abort",
  usableOutput: classification === "success" || (classification === "incomplete"),
  logicalSuccess: classification === "success",
  hasUsage: false,
  finishReason: reason === "finish_reason_length" ? "length" : null,
  completionType: null,
  // responseStatus used by the classifier for transport reason derivation; policy reads reason directly.
});

const H = (sample, availability, reason) => ({ sample, availability, reason });

describe("Policy matrix — explicit rows", () => {
  const rows = [
    // [name, classification, reason, expected]
    ["success", "success", null, { fallbackEligible: false, retryable: false, healthAction: H("success", "none", null), stopProgression: true }],

    ["http_400", "transport_failure", "http_400", { fallbackEligible: false, retryable: false, healthAction: H("none", "none", null), stopProgression: true }],
    ["http_422", "transport_failure", "http_422", { fallbackEligible: false, retryable: false, healthAction: H("none", "none", null), stopProgression: true }],
    ["http_401", "transport_failure", "http_401", { fallbackEligible: true, retryable: false, healthAction: H("failure", "unavailable", "auth"), stopProgression: false }],
    ["http_403", "transport_failure", "http_403", { fallbackEligible: true, retryable: false, healthAction: H("failure", "unavailable", "auth"), stopProgression: false }],
    ["http_404", "transport_failure", "http_404", { fallbackEligible: true, retryable: false, healthAction: H("failure", "none", null), stopProgression: false }],
    ["http_429", "transport_failure", "http_429", { fallbackEligible: true, retryable: true, healthAction: H("failure", "unavailable", "cooldown"), stopProgression: false }],
    ["http_5xx", "transport_failure", "http_5xx", { fallbackEligible: true, retryable: true, healthAction: H("failure", "unavailable", "transient"), stopProgression: false }],

    ["provider_error", "provider_failure", "provider_error", { fallbackEligible: true, retryable: false, healthAction: H("failure", "none", null), stopProgression: false }],
    ["malformed_json", "provider_failure", "malformed_json", { fallbackEligible: true, retryable: false, healthAction: H("failure", "none", "malformed"), stopProgression: false }],
    ["malformed_sse", "provider_failure", "malformed_sse", { fallbackEligible: true, retryable: false, healthAction: H("failure", "none", "malformed"), stopProgression: false }],
    ["response.failed", "provider_failure", "response.failed", { fallbackEligible: true, retryable: false, healthAction: H("failure", "none", null), stopProgression: false }],

    ["usage_only", "empty_output", "usage_only", { fallbackEligible: true, retryable: true, healthAction: H("none", "none", null), stopProgression: false }],
    ["empty_response", "empty_output", "empty_response", { fallbackEligible: true, retryable: true, healthAction: H("none", "none", null), stopProgression: false }],

    ["finish_reason_length", "incomplete", "finish_reason_length", { fallbackEligible: true, retryable: false, healthAction: H("none", "none", null), stopProgression: false }],
    ["no_successful_terminal", "incomplete", "no_successful_terminal", { fallbackEligible: true, retryable: true, healthAction: H("failure", "none", null), stopProgression: false }],

    ["client_abort", "cancelled", "client_abort", { fallbackEligible: false, retryable: false, healthAction: H("none", "none", null), stopProgression: true }],
    ["provider_cancelled", "cancelled", "provider_cancelled", { fallbackEligible: true, retryable: false, healthAction: H("none", "none", null), stopProgression: false }],

    ["cache", "success", null, { fallbackEligible: false, retryable: false, healthAction: H("none", "none", null), stopProgression: true }],
    ["bypass", "success", null, { fallbackEligible: false, retryable: false, healthAction: H("none", "none", null), stopProgression: true }],
  ];

  for (const [name, cls, reason, expected] of rows) {
    const src = name === "cache" ? "cache" : name === "bypass" ? "bypass" : "provider";
    it(`row: ${name}`, () => {
      const p = decideAttemptPolicy(attempt(cls, reason, src));
      expect(p).toEqual(expected);
    });
  }
});

describe("Contradiction guards", () => {
  it("401 — availability:unavailable + reason:auth + retryable:false (no breaker encoded)", () => {
    const p = decideAttemptPolicy(attempt("transport_failure", "http_401"));
    expect(p.healthAction.availability).toBe("unavailable");
    expect(p.healthAction.reason).toBe("auth");
    expect(p.retryable).toBe(false);
    expect(p.fallbackEligible).toBe(true);
  });

  it("400 — fallbackEligible:false + stopProgression:true", () => {
    const p = decideAttemptPolicy(attempt("transport_failure", "http_400"));
    expect(p.fallbackEligible).toBe(false);
    expect(p.stopProgression).toBe(true);
  });

  it("client_abort — fallbackEligible:false + stopProgression:true + sample:none", () => {
    const p = decideAttemptPolicy(attempt("cancelled", "client_abort"));
    expect(p.fallbackEligible).toBe(false);
    expect(p.stopProgression).toBe(true);
    expect(p.healthAction.sample).toBe("none");
  });

  it("cache — healthAction.sample:none + availability:none + stopProgression:true", () => {
    const p = decideAttemptPolicy(attempt("success", null, "cache"));
    expect(p.healthAction.sample).toBe("none");
    expect(p.healthAction.availability).toBe("none");
    expect(p.stopProgression).toBe(true);
  });

  it("bypass — same as cache", () => {
    const p = decideAttemptPolicy(attempt("success", null, "bypass"));
    expect(p.healthAction.sample).toBe("none");
    expect(p.healthAction.availability).toBe("none");
    expect(p.stopProgression).toBe(true);
  });

  it("empty_output — sample:none + availability:none (not provider health)", () => {
    const p = decideAttemptPolicy(attempt("empty_output", "usage_only"));
    expect(p.healthAction.sample).toBe("none");
    expect(p.healthAction.availability).toBe("none");
  });

  it("success — stopProgression:true + fallbackEligible:false", () => {
    const p = decideAttemptPolicy(attempt("success", null));
    expect(p.stopProgression).toBe(true);
    expect(p.fallbackEligible).toBe(false);
  });

  it("malformed — reason:malformed + availability:none (no account lock)", () => {
    const p = decideAttemptPolicy(attempt("provider_failure", "malformed_sse"));
    expect(p.healthAction.reason).toBe("malformed");
    expect(p.healthAction.availability).toBe("none");
  });
});

describe("Determinism", () => {
  const reps = [
    attempt("success", null),
    attempt("transport_failure", "http_429"),
    attempt("provider_failure", "malformed_json"),
    attempt("empty_output", "empty_response"),
    attempt("cancelled", "client_abort"),
    attempt("incomplete", "finish_reason_length"),
  ];
  for (const input of reps) {
    it(`${input.classification}/${input.reason} → identical output across calls`, () => {
      const a = decideAttemptPolicy(input);
      const b = decideAttemptPolicy(input);
      expect(a).toEqual(b);
      expect(a).toBe(b); // frozen identity → structural determinism
    });
  }
});

describe("Null + defensive", () => {
  it("null attempt → null policy (no fabrication)", () => {
    expect(decideAttemptPolicy(null)).toBeNull();
  });
  it("unknown classification on provider — safe default (no lock)", () => {
    const p = decideAttemptPolicy({ source: "provider", classification: "totally_unknown", reason: null });
    expect(p.healthAction.availability).toBe("none");
    expect(p.fallbackEligible).toBe(true);
    expect(p.stopProgression).toBe(false);
  });
  it("cache with provider-failure classification → still synthetic (source precedence)", () => {
    const p = decideAttemptPolicy({ source: "cache", classification: "provider_failure", reason: "malformed_sse" });
    expect(p.healthAction.sample).toBe("none");
    expect(p.fallbackEligible).toBe(false);
  });
});

describe("Field bound", () => {
  it("result contains ONLY the 4 policy fields (no providerHealth/cooldownMs/etc.)", () => {
    const p = decideAttemptPolicy(attempt("transport_failure", "http_500"));
    expect(Object.keys(p).sort()).toEqual([...ATTEMPT_POLICY_FIELDS].sort());
    // Explicitly forbidden:
    expect(p).not.toHaveProperty("providerHealth");
    expect(p).not.toHaveProperty("routingScore");
    expect(p).not.toHaveProperty("cooldownMs");
    expect(p).not.toHaveProperty("retryCount");
    expect(p).not.toHaveProperty("accountId");
    expect(p).not.toHaveProperty("model");
    expect(p).not.toHaveProperty("responseFinal");
    expect(p).not.toHaveProperty("fallbackReason");
  });
});

describe("G1 reason correction: malformed_json", () => {
  it("non-streaming malformed JSON → classification=provider_failure, reason=malformed_json", () => {
    const ca = createCanonicalAttemptFromNonStreaming({ status: 200, parsed: { choices: [] }, usage: null, malformed: true });
    expect(ca.classification).toBe("provider_failure");
    expect(ca.reason).toBe("malformed_json");
  });
  it("policy for malformed_json → fallbackEligible, retryable:false, reason:malformed, stop:false", () => {
    const ca = createCanonicalAttemptFromNonStreaming({ status: 200, parsed: { choices: [] }, usage: null, malformed: true });
    const p = decideAttemptPolicy(ca);
    expect(p.fallbackEligible).toBe(true);
    expect(p.retryable).toBe(false);
    expect(p.healthAction.reason).toBe("malformed");
    expect(p.stopProgression).toBe(false);
  });
});
