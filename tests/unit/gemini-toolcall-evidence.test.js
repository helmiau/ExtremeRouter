// Regression suite: Gemini/Antigravity tool-call-only responses were misclassified
// as `empty_output` / `usage_only`.
//
// Root cause: observeParsedEvent() (open-sse/utils/streamState.js) inspected ONLY
// `part.text` on Gemini content parts. A `functionCall` part carries no text, so
// the `if (!part?.text) continue;` guard skipped it entirely and hasToolCall was
// never set — even though gemini-to-openai.js translated the call into an OpenAI
// `tool_calls` delta and emitted it to the client.
//
// Result: usableOutput=false → logicalSuccess=false → empty_output/usage_only.
//
// Production incident (antigravity / gemini-3.8-flash-high):
//   HTTP 200, recvLines=2, dataLines=2, emitted=3,
//   hasText=false, hasReasoning=false, hasToolCall=false, hasUsage=true,
//   finishReason=stop → empty_output/usage_only.
//
// Fix: record `part.functionCall` as hasToolCall BEFORE the text guard, for BOTH
// the direct Gemini shape and the wrapped Antigravity shape ({ response: {...} }).
//
// Scope: evidence layer only. No change to combo admission, candidateServed(),
// fallback, retry, cooldown, circuit breaker, or routing.
import { describe, it, expect } from "vitest";
import {
  createStreamState,
  observeParsedEvent,
} from "../../open-sse/utils/streamState.js";
import {
  createCanonicalAttempt,
  deriveUsableOutput,
  deriveLogicalSuccess,
} from "../../open-sse/utils/canonicalAttempt.js";
import { geminiToOpenAIResponse } from "../../open-sse/translator/response/gemini-to-openai.js";

// Feed raw parsed Gemini/Antigravity SSE events through the REAL observer.
// eofSeen is set by the stream transform flush — outside the observer's scope.
function observeAll(events) {
  const state = createStreamState();
  state.streamStarted = true;
  for (const evt of events) observeParsedEvent(state, evt);
  state.eofSeen = true;
  return state;
}

function canonical(events) {
  return createCanonicalAttempt(observeAll(events), { status: 200, source: "provider" });
}

const WRAPPED_FUNCTION_CALL = {
  response: {
    candidates: [
      {
        content: {
          parts: [{ functionCall: { name: "Bash", args: { command: "echo test" } } }],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: 100,
      candidatesTokenCount: 10,
      totalTokenCount: 110,
    },
  },
};

const DIRECT_FUNCTION_CALL = {
  candidates: [
    {
      content: {
        parts: [{ functionCall: { name: "Bash", args: { command: "echo test" } } }],
      },
      finishReason: "STOP",
    },
  ],
  usageMetadata: {
    promptTokenCount: 100,
    candidatesTokenCount: 10,
    totalTokenCount: 110,
  },
};

describe("Gemini functionCall evidence (Tests 1-5)", () => {
  it("Test 1: wrapped Antigravity functionCall-only → hasToolCall=true, NOT empty_output", () => {
    const state = observeAll([WRAPPED_FUNCTION_CALL]);
    const attempt = canonical([WRAPPED_FUNCTION_CALL]);

    expect(state.hasText).toBe(false);
    expect(state.hasReasoning).toBe(false);
    expect(state.hasToolCall).toBe(true);
    expect(state.hasUsage).toBe(true);
    expect(state.terminalSeen).toBe(true);
    expect(state.terminalState).toBe("success");
    expect(state.finishReason).toBe("stop");

    expect(deriveUsableOutput(state)).toBe(true);
    expect(deriveLogicalSuccess(state)).toBe(true);
    expect(attempt.usableOutput).toBe(true);
    expect(attempt.logicalSuccess).toBe(true);
    expect(attempt.outcome).toBe("success");
    expect(attempt.classification).toBe("success");
    expect(attempt.classification).not.toBe("empty_output");
  });

  it("Test 2: direct (non-wrapped) Gemini functionCall shape → identical semantic state", () => {
    const state = observeAll([DIRECT_FUNCTION_CALL]);
    const attempt = canonical([DIRECT_FUNCTION_CALL]);

    expect(state.hasText).toBe(false);
    expect(state.hasReasoning).toBe(false);
    expect(state.hasToolCall).toBe(true);
    expect(state.hasUsage).toBe(true);
    expect(state.terminalSeen).toBe(true);
    expect(state.terminalState).toBe("success");
    expect(state.finishReason).toBe("stop");

    expect(deriveUsableOutput(state)).toBe(true);
    expect(deriveLogicalSuccess(state)).toBe(true);
    expect(attempt.classification).toBe("success");
    expect(attempt.classification).not.toBe("empty_output");
  });

  it("Test 3: functionCall + text in the same content parts → hasText AND hasToolCall", () => {
    const events = [
      {
        response: {
          candidates: [
            {
              content: {
                parts: [
                  { text: "Let me check the working tree." },
                  { functionCall: { name: "Bash", args: { command: "git status --short" } } },
                ],
              },
            },
          ],
        },
      },
      // Terminal event so the turn is complete (logicalSuccess requires a
      // successful completion, not just usable output).
      {
        response: {
          candidates: [{ finishReason: "STOP", index: 0 }],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 },
        },
      },
    ];
    const state = observeAll(events);

    expect(state.hasText).toBe(true);
    expect(state.hasToolCall).toBe(true);
    expect(state.hasReasoning).toBe(false);
    expect(deriveLogicalSuccess(state)).toBe(true);
  });

  it("Test 4: usage-only control (no text, no functionCall) → still empty_output", () => {
    // Same production shape as the incident but WITHOUT a tool call. This proves
    // the fix does not blanket-promote usage-only responses to success.
    const events = [
      {
        response: {
          candidates: [{ finishReason: "STOP", index: 0 }],
          usageMetadata: {
            promptTokenCount: 278977,
            candidatesTokenCount: 48,
            totalTokenCount: 279025,
            cachedContentTokenCount: 276686,
          },
        },
      },
    ];
    const state = observeAll(events);
    const attempt = canonical(events);

    expect(state.hasUsage).toBe(true);
    expect(state.hasToolCall).toBe(false);
    expect(state.hasText).toBe(false);
    expect(state.hasReasoning).toBe(false);

    expect(attempt.usableOutput).toBe(false);
    expect(attempt.logicalSuccess).toBe(false);
    expect(attempt.classification).toBe("empty_output");
    expect(attempt.reason).toBe("usage_only");
  });

  it("Test 5: realistic production sequence (emitted=3) → success", () => {
    // The exact two-event Antigravity stream that produced emitted=3:
    //   event 1 → synthetic role chunk + tool_calls chunk
    //   event 2 → finish chunk (usage + finishReason)
    const events = [
      {
        response: {
          responseId: "resp_1",
          modelVersion: "gemini-3.8-flash-high",
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    functionCall: {
                      name: "Bash",
                      args: { command: "git status --short", description: "Check git status" },
                    },
                  },
                ],
              },
              index: 0,
            },
          ],
        },
      },
      {
        response: {
          responseId: "resp_1",
          modelVersion: "gemini-3.8-flash-high",
          candidates: [{ finishReason: "STOP", index: 0 }],
          usageMetadata: {
            promptTokenCount: 278977,
            candidatesTokenCount: 48,
            totalTokenCount: 279025,
            cachedContentTokenCount: 276686,
          },
        },
      },
    ];

    const state = observeAll(events);
    const attempt = canonical(events);

    let emitted = 0;
    const translatorState = {};
    for (const evt of events) {
      const translated = geminiToOpenAIResponse(evt, translatorState);
      if (Array.isArray(translated)) emitted += translated.length;
    }
    expect(emitted).toBe(3);

    expect(state.hasToolCall).toBe(true);
    expect(state.hasUsage).toBe(true);
    expect(state.terminalSeen).toBe(true);
    expect(state.finishReason).toBe("stop");
    expect(deriveLogicalSuccess(state)).toBe(true);
    expect(attempt.classification).toBe("success");
  });

  it("Test 6: detection is signature-independent (with AND without thoughtSignature)", () => {
    const withSig = observeAll([
      {
        response: {
          candidates: [
            {
              content: {
                parts: [
                  {
                    thoughtSignature: "ErYDCloYA",
                    functionCall: { name: "Edit", args: { file_path: "a.js" } },
                  },
                ],
              },
            },
          ],
        },
      },
    ]);
    const withoutSig = observeAll([
      {
        response: {
          candidates: [
            {
              content: {
                parts: [{ functionCall: { name: "Edit", args: { file_path: "a.js" } } }],
              },
            },
          ],
        },
      },
    ]);

    expect(withSig.hasToolCall).toBe(true);
    expect(withoutSig.hasToolCall).toBe(true);
    // A tool call is never misattributed as text.
    expect(withSig.hasText).toBe(false);
    expect(withoutSig.hasText).toBe(false);
  });

  it("Test 7: thought parts still classify as reasoning, not text", () => {
    const state = observeAll([
      {
        response: {
          candidates: [
            {
              content: {
                parts: [
                  { text: "planning", thought: true },
                  { functionCall: { name: "Bash", args: { command: "ls" } } },
                ],
              },
            },
          ],
        },
      },
    ]);
    expect(state.hasReasoning).toBe(true);
    expect(state.hasText).toBe(false);
    expect(state.hasToolCall).toBe(true);
  });
});

describe("End-to-end: Gemini wrapped functionCall → translator → observer → logicalSuccess", () => {
  it("translator emits tool_calls AND observer records hasToolCall", () => {
    const state = createStreamState();
    state.streamStarted = true;
    const translatorState = {};

    const events = [
      {
        response: {
          responseId: "resp_e2e",
          modelVersion: "gemini-3.8-flash-high",
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ functionCall: { name: "Bash", args: { command: "echo test" } } }],
              },
              index: 0,
            },
          ],
        },
      },
      {
        response: {
          responseId: "resp_e2e",
          modelVersion: "gemini-3.8-flash-high",
          candidates: [{ finishReason: "STOP", index: 0 }],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, totalTokenCount: 110 },
        },
      },
    ];

    const emitted = [];
    for (const evt of events) {
      observeParsedEvent(state, evt);
      const translated = geminiToOpenAIResponse(evt, translatorState);
      if (Array.isArray(translated)) emitted.push(...translated);
    }
    state.eofSeen = true;

    // 1) translator emitted the tool call to the client
    const toolChunk = emitted.find((c) => c?.choices?.[0]?.delta?.tool_calls?.length > 0);
    expect(toolChunk).toBeTruthy();
    expect(toolChunk.choices[0].delta.tool_calls[0].function.name).toBe("Bash");
    expect(toolChunk.choices[0].delta.tool_calls[0].function.arguments).toContain("echo test");

    // 2) terminal chunk reports tool_calls
    const finishChunk = emitted.find((c) => c?.choices?.[0]?.finish_reason);
    expect(finishChunk.choices[0].finish_reason).toBe("tool_calls");

    // 3) observer recorded the semantic tool call
    expect(state.hasToolCall).toBe(true);
    expect(deriveUsableOutput(state)).toBe(true);

    // 4) canonical attempt is a success (the previously-broken step)
    const attempt = createCanonicalAttempt(state, { status: 200, source: "provider" });
    expect(attempt.usableOutput).toBe(true);
    expect(attempt.logicalSuccess).toBe(true);
    expect(attempt.outcome).toBe("success");
    expect(attempt.classification).toBe("success");
    expect(attempt.classification).not.toBe("empty_output");
  });
});
