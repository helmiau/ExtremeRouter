// Regression suite for the Antigravity premature-EOF false empty_output bug.
//
// Root cause: Antigravity Gemini SSE data events arrive wrapped as
//   { "response": { "candidates": [...], "usageMetadata": {...} } }
// but the canonical stream observer only inspected `parsed.candidates` / `parsed.usage`,
// so valid content / finish / usage was translated + emitted yet observability +
// classification reported hasText=false, hasUsage=false, terminalSeen=false →
// empty_output. Combo then wrongly rejected a successful Antigravity candidate.
//
// The fix normalizes both shapes (direct Gemini AND wrapped Antigravity) in
// observeParsedEvent() and in the stream.js content accumulator — it does NOT
// touch routing, fallback, retry, cooldown, or circuit-breaker semantics.
//
// These tests verify the OBSERVABILITY/CLASSIFICATION layer only (where the bug
// was). The translation layer (gemini-to-openai.js) already unwrapped correctly
// and is covered here only to prove end-to-end logicalSuccess.
import { describe, it, expect } from "vitest";
import {
  createStreamState,
  observeParsedEvent,
} from "../../open-sse/utils/streamState.js";
import { deriveLogicalSuccess } from "../../open-sse/utils/canonicalAttempt.js";
import { geminiToOpenAIResponse } from "../../open-sse/translator/response/gemini-to-openai.js";

// Helper: feed a parsed SSE event into a fresh stream state.
function observe(parsed) {
  const state = createStreamState();
  observeParsedEvent(state, parsed);
  return state;
}

describe("Antigravity wrapped-event observability (Tests A-E)", () => {
  it("Test A: wrapped content event → hasText=true", () => {
    const state = observe({
      response: {
        candidates: [
          {
            content: {
              parts: [{ text: "Hello" }],
            },
          },
        ],
      },
    });
    expect(state.hasText).toBe(true);
    expect(state.hasReasoning).toBe(false);
    expect(state.hasToolCall).toBe(false);
    expect(state.hasUsage).toBe(false);
    expect(state.terminalSeen).toBe(false);
  });

  it("Test B: wrapped finish event → terminalSeen + success terminal + finishReason 'stop'", () => {
    const state = observe({
      response: {
        candidates: [{ finishReason: "STOP" }],
      },
    });
    expect(state.terminalSeen).toBe(true);
    expect(state.terminalState).toBe("success");
    expect(state.terminalType).toBe("finish_reason");
    expect(state.finishReason).toBe("stop");
    expect(state.hasText).toBe(false);
  });

  it("Test C: wrapped usage event → hasUsage=true but not usable output", () => {
    const state = observe({
      response: {
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          totalTokenCount: 15,
        },
      },
    });
    expect(state.hasUsage).toBe(true);
    expect(state.hasText).toBe(false);
    expect(state.hasReasoning).toBe(false);
    expect(state.hasToolCall).toBe(false);
    expect(state.terminalSeen).toBe(false);
    // Usage alone is NEVER usable output (defensive invariant).
    expect(state.hasText || state.hasReasoning || state.hasToolCall).toBe(false);
  });

  it("Test D: full six-event-like Antigravity sequence → NOT empty_output", () => {
    const state = createStreamState();
    // 5 content chunks (wrapped)
    for (let i = 0; i < 5; i++) {
      observeParsedEvent(state, {
        response: {
          candidates: [{ content: { parts: [{ text: `chunk-${i}` }] } }],
        },
      });
    }
    // final STOP + usageMetadata (wrapped)
    observeParsedEvent(state, {
      response: {
        candidates: [{ finishReason: "STOP" }],
        usageMetadata: {
          promptTokenCount: 155627,
          candidatesTokenCount: 136,
          totalTokenCount: 155763,
        },
      },
    });

    expect(state.hasText).toBe(true);
    expect(state.hasUsage).toBe(true);
    expect(state.terminalSeen).toBe(true);
    expect(state.terminalState).toBe("success");
    expect(state.finishReason).toBe("stop");
    expect(state.eofSeen).toBe(false); // not yet flushed; set by stream flush later

    // Before EOF the completion state is derived from terminal + usable output.
    // deriveLogicalSuccess also requires !errorSeen && !abortSeen (true here).
    expect(deriveLogicalSuccess(state)).toBe(true);
  });

  it("Test E: direct (non-wrapped) Gemini shape still works exactly as before", () => {
    const direct = observe({
      candidates: [
        {
          content: { parts: [{ text: "direct gemini" }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        totalTokenCount: 15,
      },
    });
    expect(direct.hasText).toBe(true);
    expect(direct.hasUsage).toBe(true);
    expect(direct.terminalSeen).toBe(true);
    expect(direct.terminalState).toBe("success");
    expect(direct.finishReason).toBe("stop");

    // And wrapped shape is equivalent
    const wrapped = observe({
      response: {
        candidates: [
          {
            content: { parts: [{ text: "wrapped gemini" }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          totalTokenCount: 15,
        },
      },
    });
    expect(wrapped.hasText).toBe(true);
    expect(wrapped.hasUsage).toBe(true);
    expect(wrapped.terminalSeen).toBe(true);
    expect(wrapped.finishReason).toBe("stop");
  });
});

describe("Antigravity realistic incident: HTTP 200, 6 data events, emitted 7 → success (Test F)", () => {
  it("full path: wrapped Gemini events → Antigravity observer → gemini-to-OpenAI translation → logicalSuccess", () => {
    const state = createStreamState();
    const translatorState = {};

    // 6 Antigravity data events (all wrapped in `response`), mirroring the
    // production incident: 5 content chunks + 1 terminal/usage event.
    const events = [
      { response: { responseId: "resp_1", modelVersion: "gemini-3.8-flash-high", candidates: [{ content: { role: "model", parts: [{ text: "Hello" }] } }] } },
      { response: { responseId: "resp_1", modelVersion: "gemini-3.8-flash-high", candidates: [{ content: { role: "model", parts: [{ text: " from" }] } }] } },
      { response: { responseId: "resp_1", modelVersion: "gemini-3.8-flash-high", candidates: [{ content: { role: "model", parts: [{ text: " Antigravity" }] } }] } },
      { response: { responseId: "resp_1", modelVersion: "gemini-3.8-flash-high", candidates: [{ content: { role: "model", parts: [{ text: " with" }] } }] } },
      { response: { responseId: "resp_1", modelVersion: "gemini-3.8-flash-high", candidates: [{ content: { role: "model", parts: [{ text: " content" }] } }] } },
      { response: { responseId: "resp_1", modelVersion: "gemini-3.8-flash-high", candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 155627, candidatesTokenCount: 136, totalTokenCount: 155763 } } },
    ];

    let emittedChunks = 0;
    for (const evt of events) {
      // 1) canonical observer (the buggy layer) — now fix-normalized
      observeParsedEvent(state, evt);
      // 2) translation layer (already correct) — proves end-to-end output
      const translated = geminiToOpenAIResponse(evt, translatorState);
      if (Array.isArray(translated)) emittedChunks += translated.length;
    }

    // Simulate stream flush marking EOF (flush sets this; not part of the bug).
    state.eofSeen = true;

    // Translator emitted 7 chunks (1 synthetic role + 5 content deltas + 1 finish).
    expect(emittedChunks).toBe(7);

    // Canonical observability now correct:
    expect(state.hasText).toBe(true);
    expect(state.hasUsage).toBe(true);
    expect(state.terminalSeen).toBe(true);
    expect(state.terminalState).toBe("success");
    expect(state.finishReason).toBe("stop");

    // Final semantic state must NOT be empty_output:
    // usableOutput (hasText) + completionState==='success' + !error + !abort.
    expect(deriveLogicalSuccess(state)).toBe(true);

    // Explicit negative: the old broken shape (missing .response) would have
    // produced hasText=false. Assert the fix keeps it true.
    expect(state.hasText).not.toBe(false);
  });
});
