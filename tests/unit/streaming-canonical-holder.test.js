import { describe, it, expect, vi } from "vitest";

// Commit D: streaming path keeps a LIVE canonical-attempt holder on the
// ChatResult. The holder is created up front (so ChatResult.canonicalAttempt is
// always present) and filled at stream completion via Object.assign — the
// stream body is never consumed/blocked/buffered to obtain it. This proves the
// holder identity is stable and that completion-overwrite is a mutation, not a
// replacement of the reference.

import { createStreamState, observeParsedEvent } from "../../open-sse/utils/streamState.js";
import { createCanonicalAttempt, deriveUsableOutput } from "../../open-sse/utils/canonicalAttempt.js";

const openaiContent = (content) => ({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
const openaiFinish = (fr) => ({ choices: [{ index: 0, delta: {}, finish_reason: fr }] });

describe("streaming canonical-attempt holder (Commit D)", () => {
  it("holder is the same object reference returned on ChatResult, then filled at flush", () => {
    const streamState = createStreamState();
    // Mirrors streamingHandler.js wiring: live holder created up front.
    const canonicalAttempt = createCanonicalAttempt(streamState, { status: 200, source: "provider" });

    // At this point the stream has not completed — derived fields inherit the
    // still-empty state but the object reference is already on the envelope.
    const chatResult = { success: true, canonicalAttempt };
    expect(chatResult.canonicalAttempt).toBe(canonicalAttempt);
    const sameRef = chatResult.canonicalAttempt;

    // Stream completes; handler overwrites the holder contents in place.
    observeParsedEvent(streamState, openaiContent("hello"));
    observeParsedEvent(streamState, openaiFinish("stop"));
    Object.assign(canonicalAttempt, createCanonicalAttempt(streamState, { status: 200, source: "provider" }));

    // Reference identity preserved (no new object handed to the consumer).
    expect(chatResult.canonicalAttempt).toBe(sameRef);
    expect(chatResult.canonicalAttempt.logicalSuccess).toBe(true);
    expect(chatResult.canonicalAttempt.completionState).toBe("success");
    expect(chatResult.canonicalAttempt.usableOutput).toBe(deriveUsableOutput(streamState));
  });

  it("fill-at-flush leaves the stream body untouched (read-only status)", () => {
    const streamState = createStreamState();
    const canonicalAttempt = createCanonicalAttempt(streamState, { status: 200, source: "provider" });
    // The completion overwrite only reads transport status + observational
    // state; it never pulls bytes from a Response. Prove status independence.
    const before = { ...canonicalAttempt };
    Object.assign(canonicalAttempt, createCanonicalAttempt(streamState, { status: 503, source: "provider" }));
    expect(canonicalAttempt.transportOk).toBe(false);
    expect(canonicalAttempt).not.toHaveProperty("body");
    void before;
  });
});
