// Pure semantic derivation layer over the Wave 2 commit-1 stream state.
//
// Converts the OBSERVED stream evidence (createStreamState in streamState.js)
// into deterministic semantic results: usableOutput, logicalSuccess, outcome.
//
// IMPORTANT: these results are OBSERVATIONAL ONLY in this commit. Nothing in
// production reads them for behavior decisions — ChatResult.success, combo
// fallback, health, routing and HTTP/SSE output all continue to use the
// existing contracts. This module exists so the next phase can consume a
// trustworthy canonical attempt result.
//
// Ground rules (forensic Cline lessons):
//   - emitted/recvLines/dataLines = telemetry, NOT semantic evidence.
//   - usage = metadata, NOT model output.
//   - [DONE] = transport marker; a neutral terminal never grants success.
//   - text / reasoning / tool calls are the only output categories.
//   - output without a successful terminal is not logical success.
//   - a failure terminal overrides any partial output.
//   - abort/cancel is distinct from provider failure.

const ACTIVITY_CLASS = Object.freeze({
  SUCCESS: "success",
  FAILURE: "failure",
  INCOMPLETE: "incomplete",
  CANCELLED: "cancelled",
});

/**
 * Was semantically meaningful model output observed on the wire?
 * text OR reasoning OR tool-call — never usage, terminal markers, or
 * telemetry counters.
 */
export function deriveUsableOutput(state) {
  if (!state) return false;
  return !!(state.hasText || state.hasReasoning || state.hasToolCall);
}

/**
 * Did the attempt complete logically successfully?
 *
 * Requires ALL of:
 *   usable output observed (text/reasoning/tool-call)
 *   AND a successful terminal (finish_reason=stop|tool_calls|…, message_stop,
 *       response.completed/done, Ollama done-with-payload)
 *   AND no stream-level error
 *   AND no abort/cancel.
 *
 * A neutral terminal ([DONE] alone) is NOT success. An empty stream is NOT
 * success even with hasUsage or a success terminal. Output + failure/abort is
 * NOT success.
 */
export function deriveLogicalSuccess(state) {
  if (!state) return false;
  if (!deriveUsableOutput(state)) return false;
  if (state.terminalState !== "success") return false;
  if (state.errorSeen) return false;
  if (state.abortSeen) return false;
  return true;
}

/**
 * Canonical outcome classification (small controlled enum):
 *
 * success    — usableOutput + terminalState=success + no error + no abort.
 * failure    — provider-declared failure terminal OR errorSeen (overrides
 *              partial output).
 * cancelled  — abortSeen with no provider-declared failure (client/provider
 *              cancellation is distinct from provider failure).
 * incomplete — anything else: no successful terminal reached, no provider
 *              failure, no abort — the stream ended without completing (EOF
 *              with no terminal, or a neutral terminal, or an incomplete
 *              terminal like finish_reason=length).
 *
 * Order of checks is deliberate: failure evidence beats abort evidence beats
 * incompleteness.
 */
export function deriveAttemptOutcome(state) {
  if (!state) return ACTIVITY_CLASS.INCOMPLETE;

  // Failure evidence always wins.
  if (state.terminalState === "failure" || state.errorSeen) return ACTIVITY_CLASS.FAILURE;

  // Abort/cancel wins over incompleteness: a client/provider cancellation is
  // semantically distinct from a stream that merely ended without a terminal.
  if (state.abortSeen && !deriveLogicalSuccess(state)) return ACTIVITY_CLASS.CANCELLED;

  if (state.terminalState === "incomplete") return ACTIVITY_CLASS.INCOMPLETE;

  if (deriveLogicalSuccess(state)) return ACTIVITY_CLASS.SUCCESS;

  return ACTIVITY_CLASS.INCOMPLETE;
}

/**
 * Canonical attempt result — the single immutable-after-completion view of
 * one provider attempt. Composes the pure derivations with the raw observed
 * state and (where available) transport metadata. Purely informational in
 * this commit.
 *
 * @param {object} state          - createStreamState() instance
 * @param {{status?: number}} [transport] - optional HTTP status from the
 *        provider response (populated at the integration boundary — the state
 *        machine itself does not own HTTP status; never clones/consumes body)
 */
export function createCanonicalAttempt(state, transport = {}) {
  const transportOk = transport == null || transport.status == null
    ? null
    : transport.status >= 200 && transport.status < 300;
  return {
    transportOk,
    streamStarted: state?.streamStarted ?? false,
    hasText: state?.hasText ?? false,
    hasReasoning: state?.hasReasoning ?? false,
    hasToolCall: state?.hasToolCall ?? false,
    hasUsage: state?.hasUsage ?? false,
    terminalState: state?.terminalState ?? null,
    terminalType: state?.terminalType ?? null,
    finishReason: state?.finishReason ?? null,
    eofSeen: state?.eofSeen ?? false,
    errorSeen: state?.errorSeen ?? false,
    abortSeen: state?.abortSeen ?? false,
    usableOutput: deriveUsableOutput(state),
    logicalSuccess: deriveLogicalSuccess(state),
    outcome: deriveAttemptOutcome(state),
  };
}