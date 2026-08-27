// Universal Canonical Attempt — contract + pure semantics (Phase 2 / Commit A).
import { classifyCanonicalAttempt } from "./canonicalClassification.js";
import { decideAttemptPolicy } from "./canonicalPolicy.js";

// One provider-agnostic internal result that can represent ANY provider
// execution path — streaming, forced SSE→JSON, non-streaming JSON, transport
// failure, cache, bypass — WITHOUT treating transport success, stream
// completion, usage, or HTTP 200 as model success.

const COMPLETION_STATES = new Set(["success", "failure", "incomplete", "cancelled", "unknown"]);
const SOURCES = new Set(["provider", "cache", "bypass"]);

function transportFromStatus(status) {
  if (status == null || Number.isNaN(Number(status))) return null;
  return Number(status) >= 200 && Number(status) < 300;
}

export function deriveCompletionState(state) {
  if (!state) return "unknown";
  if (state.abortSeen) return "cancelled";
  if (state.terminalState === "cancelled") return "cancelled";
  if (state.terminalState === "failure" || state.errorSeen) return "failure";
  if (state.terminalState === "incomplete") return "incomplete";
  if (state.terminalState === "success") return "success";
  if (state.eofSeen) return deriveUsableOutput(state) ? "incomplete" : "incomplete";
  return "unknown";
}

export function deriveUsableOutput(state) {
  return !!(state?.hasText || state?.hasReasoning || state?.hasToolCall || state?.hasStructuredOutput);
}

export function deriveLogicalSuccess(state) {
  if (!state) return false;
  const completionState = state.completionState || deriveCompletionState(state);
  const usableOutput = state.usableOutput ?? deriveUsableOutput(state);
  return usableOutput && completionState === "success" && !state.errorSeen && !state.abortSeen;
}

export function deriveOutcome(state) {
  if (!state) return "failure";
  const completionState = state.completionState || deriveCompletionState(state);
  if (completionState === "cancelled") return "cancelled";
  if (completionState === "failure" || state.errorSeen) return "failure";
  if (deriveLogicalSuccess({ ...state, completionState })) return "success";
  return "incomplete";
}

export function createCanonicalAttempt(state, { status, source = "provider" } = {}) {
  const safeSource = SOURCES.has(source) ? source : "provider";
  const transportOk = status === undefined ? (safeSource === "provider" ? null : transportFromStatus(status)) : transportFromStatus(status);
  const completionState = safeSource === "cache" || safeSource === "bypass"
    ? (transportOk === false ? "failure" : "success")
    : deriveCompletionState(state);
  const usableOutput = safeSource === "cache" || safeSource === "bypass"
    ? transportOk !== false
    : deriveUsableOutput(state);
  const logicalSuccess = safeSource === "cache" || safeSource === "bypass"
    ? transportOk !== false
    : deriveLogicalSuccess({ ...state, completionState, usableOutput });
  const errorSeen = state?.errorSeen ?? false;
  const abortSeen = state?.abortSeen ?? false;
  const completionType = state?.terminalType ?? (safeSource === "cache" ? "cache" : safeSource === "bypass" ? "bypass" : null);
  const terminalState = state?.terminalState ?? null;
  const classification = classifyCanonicalAttempt({
    completionState, transportOk, abortSeen, errorSeen, completionType,
    usableOutput, logicalSuccess, responseStatus: status ?? null,
  });
  const attempt = {
    source: safeSource,
    transportOk,
    streamStarted: state ? !!state.streamStarted : null,
    hasText: state?.hasText ?? false,
    hasReasoning: state?.hasReasoning ?? false,
    hasToolCall: state?.hasToolCall ?? false,
    hasStructuredOutput: state?.hasStructuredOutput ?? false,
    hasUsage: state?.hasUsage ?? false,
    completionState,
    completionType,
    terminalState,
    terminalType: state?.terminalType ?? null,
    finishReason: state?.finishReason ?? null,
    eofSeen: state ? !!state.eofSeen : null,
    errorSeen,
    abortSeen,
    usableOutput,
    logicalSuccess,
    outcome: deriveOutcome({ ...state, completionState, usableOutput, errorSeen, abortSeen }),
    ...(classification || {}),
  };
  return { ...attempt, policy: decideAttemptPolicy(attempt) };
}

export { COMPLETION_STATES, SOURCES };
