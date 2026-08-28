// G2-D.1: canonical retry ELIGIBILITY gate.
//
// `canonicalAttempt.policy.retryable` is the authoritative gate for
// same-provider/account retry. This module is a PURE, O(1) reader — it does not
// implement retry mechanics, budgets, delays, or any I/O. It never triggers a
// retry; it only answers whether canonical policy PERMITS one.
//
// Contract:
//   true  → retryable (the existing retry engine decides whether a retry slot
//           is actually available via retryConfig / budget / backoff).
//   false → NOT retryable (authoritative — must not retry, even if a
//           status-based retry config exists).
//   null  → no finalized canonical policy → legacy compatibility (caller keeps
//           its existing status-based behavior; do NOT fabricate policy).

import { classifyCanonicalAttempt } from "./canonicalClassification.js";
import { decideAttemptPolicy } from "./canonicalPolicy.js";

/**
 * Read retry eligibility from an already-finalized canonical attempt.
 * Only `.policy.retryable` is consulted — never re-derived.
 */
export function isCanonicalRetryEligible(canonicalAttempt) {
  if (!canonicalAttempt || canonicalAttempt.completionState === "unknown") return null;
  const policy = canonicalAttempt.policy;
  if (!policy || typeof policy.retryable !== "boolean") return null;
  return policy.retryable;
}

/**
 * Executor retry boundary: a failed transport sub-attempt has no downstream
 * canonical attempt yet (the finalized attempt is built only after execute()
 * returns). Classify it EXACTLY as the downstream transport attempt would be —
 * transportOk=false, completionType="http_error", responseStatus=status — and
 * read the SAME frozen policy matrix. This is a single boundary consultation,
 * not a second retry policy and not a status if/else branch.
 */
export function retryEligibilityForTransport(status) {
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
  const classified = classifyCanonicalAttempt(attempt);
  const policy = decideAttemptPolicy({ ...attempt, ...classified });
  return policy?.retryable === true;
}