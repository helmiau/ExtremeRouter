// G2-D.1: canonical retry ELIGIBILITY gate.
//
// `canonicalAttempt.policy.retryable` is the authoritative gate for
// same-provider/account retry. This module is a PURE, O(1) reader — it does not
// implement retry mechanics, budgets, delays, or any I/O. It never triggers a
// retry; it only answers whether canonical policy PERMITS one.
//
// Two gates live here, for the two retry timing paths:
//   - retryEligibilityForTransport (G2-D.1) — inside BaseExecutor, where only
//     the transport status exists (no finalized canonical attempt yet).
//   - isSemanticRetryEligible / shouldSemanticRetry (G2-D.2) — after
//     handleChatCore finalizes, where the full canonicalAttempt.policy exists
//     (HTTP 200 semantic failures like usage_only / empty_response /
//     no_successful_terminal).
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

/**
 * Semantic retry eligibility (G2-D.2): may a FINALIZED transport-success
 * semantic failure (HTTP 200 + usage_only / empty_response /
 * no_successful_terminal) be re-run once through the normal pipeline?
 *
 * Pure, O(1), read-only. It never schedules a retry, never touches
 * retryConfig/retry budgets (the caller owns those), and never executes
 * health/fallback/mutation. All conditions must hold:
 *   - finalized canonical attempt exists (never provisional streaming state);
 *   - transportOk === true (scope gap: HTTP-200 semantic failures only —
 *     429/5xx remain the transport retry engine's domain);
 *   - policy.retryable === true and stopProgression !== true;
 *   - NOT logically successful: never rerun a served/happy attempt. We check
 *     canonicalAttempt.logicalSuccess (the semantic truth) rather than
 *     result.success, because the envelope's `success` is true for empty_output
 *     while canonical logicalSuccess is false — that is exactly the case that
 *     SHOULD retry. result.success !== true (transport statuses, malformed
 *     bodies) is also excluded, since those are not transport-success attempts;
 *   - response is not a live SSE admission (streaming output already committed
 *     to the client — candidate admission takes precedence).
 */
export function isSemanticRetryEligible(result) {
  if (!result) return false;
  const attempt = result.canonicalAttempt;
  if (!attempt || attempt.completionState === "unknown") return false;
  if (attempt.transportOk !== true) return false;
  const policy = attempt.policy;
  if (!policy || policy.retryable !== true) return false;
  if (policy.stopProgression === true) return false;
  // logicalSuccess is the canonical truth; result.success is not equivalent
  // (empty_output yields success=true but logicalSuccess=false).
  if (attempt.logicalSuccess === true) return false;
  // result.success guards out transport/parse failures (status set, body
  // malformed) which are not in the semantic-200 scope.
  if (result.success !== true) return false;
  if (/^text\/event-stream/.test(result.response?.headers?.get?.("content-type") || "")) return false;
  return true;
}

/**
 * G2-D.2 decision helper: semantic retry is allowed only when the finalized
 * policy says retryable AND the shared retry budget has not been consumed
 * (executor transport retries plus any prior semantic retry).
 */
export function shouldSemanticRetry(result) {
  return isSemanticRetryEligible(result) && (result.retryCount ?? 0) < 1;
}