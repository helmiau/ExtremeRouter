import { describe, it, expect, vi } from "vitest";

// Wave 2 commit 1: observational stream-state machine tests. These validate
// STATE OBSERVATION ONLY — nothing here asserts changes to ChatResult.success,
// combo fallback, or termination output.

vi.mock("@/shared/utils/ssrfGuard.js", () => ({ assertPublicUrl: vi.fn() }));
vi.mock("@/lib/dataDir.js", () => ({ DATA_DIR: "/tmp/test-data" }));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

import "../translator/registerAll.js";
const { createSSETransformStreamWithLogger, createPassthroughStreamWithLogger } = await import("../../open-sse/utils/stream.js");
const { FORMATS } = await import("../../open-sse/translator/formats.js");

const enc = new TextEncoder();

async function pump(ts, chunks) {
  const w = ts.writable.getWriter();
  const r = ts.readable.getReader();
  const writeAll = (async () => {
    for (const c of chunks) await w.write(enc.encode(c));
    await w.close();
  })();
  while (true) {
    const { done } = await r.read();
    if (done) break;
  }
  await writeAll.catch(() => {});
}

// Runs SSE chunks through a TRANSLATE-mode transform; resolves the observed
// state delivered to onStreamComplete as the 4th argument.
async function runTranslate({ targetFormat, sourceFormat, chunks }) {
  const completions = [];
  const ts = createSSETransformStreamWithLogger(targetFormat, sourceFormat, "testprov", null, null, "m", "conn", {}, (...a) => completions.push(a));
  await pump(ts, chunks);
  expect(completions.length).toBeGreaterThanOrEqual(1);
  return completions[completions.length - 1][3];
}

// Same for PASSTHROUGH mode (raw OpenAI-compatible/Claude-native wires).
async function runPassthrough({ chunks }) {
  const completions = [];
  const ts = createPassthroughStreamWithLogger("testprov", null, "m", "conn", {}, (...a) => completions.push(a));
  await pump(ts, chunks);
  expect(completions.length).toBeGreaterThanOrEqual(1);
  return completions[completions.length - 1][3];
}

const openaiDelta = (obj) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: obj, finish_reason: null }] })}\n\n`;

describe("Wave 2 stream state machine — semantic output evidence (translate)", () => {
  it("OpenAI delta.content → hasText=true", async () => {
    const s = await runTranslate({ targetFormat: FORMATS.OPENAI, sourceFormat: FORMATS.OPENAI, chunks: [openaiDelta({ content: "hello" })] });
    expect(s.hasText).toBe(true);
    expect(s.hasReasoning).toBe(false);
    expect(s.hasToolCall).toBe(false);
    expect(s.streamStarted).toBe(true);
  });

  it("OpenAI reasoning_content → hasReasoning=true, hasText=false", async () => {
    const s = await runTranslate({ targetFormat: FORMATS.OPENAI, sourceFormat: FORMATS.OPENAI, chunks: [openaiDelta({ reasoning_content: "thinking..." })] });
    expect(s.hasReasoning).toBe(true);
    expect(s.hasText).toBe(false);
  });

  it("OpenAI tool_calls → hasToolCall=true", async () => {
    const s = await runTranslate({
      targetFormat: FORMATS.OPENAI,
      sourceFormat: FORMATS.OPENAI,
      chunks: [openaiDelta({ tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] })],
    });
    expect(s.hasToolCall).toBe(true);
    expect(s.hasText).toBe(false);
  });

  it("usage-only event → hasUsage=true, hasText=false (usage is not model output)", async () => {
    const s = await runTranslate({
      targetFormat: FORMATS.OPENAI,
      sourceFormat: FORMATS.OPENAI,
      chunks: ['data: {"choices":[{"index":0,"delta":{},"finish_reason":null}],"usage":{"prompt_tokens":10,"completion_tokens":4}}\n\n'],
    });
    expect(s.hasUsage).toBe(true);
    expect(s.hasText).toBe(false);
  });
});

describe("Wave 2 stream state machine — terminals (translate)", () => {
  it("finish_reason=stop → success terminal", async () => {
    const s = await runTranslate({
      targetFormat: FORMATS.OPENAI,
      sourceFormat: FORMATS.OPENAI,
      chunks: ['data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'],
    });
    expect(s.terminalSeen).toBe(true);
    expect(s.terminalState).toBe("success");
    expect(s.terminalType).toBe("finish_reason");
    expect(s.finishReason).toBe("stop");
  });

  it("finish_reason=tool_calls → success terminal (tool termination)", async () => {
    const s = await runTranslate({
      targetFormat: FORMATS.OPENAI,
      sourceFormat: FORMATS.OPENAI,
      chunks: ['data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n'],
    });
    expect(s.terminalSeen).toBe(true);
    expect(s.terminalState).toBe("success");
    expect(s.finishReason).toBe("tool_calls");
  });

  it("finish_reason=length → incomplete terminal", async () => {
    const s = await runTranslate({
      targetFormat: FORMATS.OPENAI,
      sourceFormat: FORMATS.OPENAI,
      chunks: ['data: {"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}\n\n'],
    });
    expect(s.terminalSeen).toBe(true);
    expect(s.terminalState).toBe("incomplete");
  });

  it("[DONE] alone is a NEUTRAL marker: terminalSeen, state stays null", async () => {
    const s = await runTranslate({ targetFormat: FORMATS.OPENAI, sourceFormat: FORMATS.OPENAI, chunks: ["data: [DONE]\n\n"] });
    expect(s.terminalSeen).toBe(true);
    expect(s.terminalType).toBe("[DONE]");
    expect(s.terminalState).toBe(null);
    expect(s.hasText).toBe(false);
  });

  it("first terminal wins: finish_reason=stop is not overwritten by later [DONE]", async () => {
    const s = await runTranslate({
      targetFormat: FORMATS.OPENAI,
      sourceFormat: FORMATS.OPENAI,
      chunks: [
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ],
    });
    expect(s.terminalState).toBe("success");
    expect(s.terminalType).toBe("finish_reason");
  });
});

describe("Wave 2 stream state machine — provider terminals (translate)", () => {
  it("Claude message_stop → success terminal", async () => {
    const s = await runTranslate({
      targetFormat: FORMATS.CLAUDE,
      sourceFormat: FORMATS.CLAUDE,
      chunks: ['data: {"type":"message_stop"}\n\n'],
    });
    expect(s.terminalSeen).toBe(true);
    expect(s.terminalState).toBe("success");
    expect(s.terminalType).toBe("message_stop");
  });

  it("Claude thinking delta → hasReasoning=true", async () => {
    const s = await runTranslate({
      targetFormat: FORMATS.CLAUDE,
      sourceFormat: FORMATS.CLAUDE,
      chunks: ['data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hmm"}}\n\n'],
    });
    expect(s.hasReasoning).toBe(true);
    expect(s.hasText).toBe(false);
  });

  it("Responses response.completed → success terminal", async () => {
    const s = await runTranslate({
      targetFormat: FORMATS.OPENAI_RESPONSES,
      sourceFormat: FORMATS.OPENAI_RESPONSES,
      chunks: ['event: response.completed\ndata: {"type":"response.completed"}\n\n'],
    });
    expect(s.terminalSeen).toBe(true);
    expect(s.terminalState).toBe("success");
    expect(s.terminalType).toBe("response.completed");
  });

  it("Responses response.failed → failure terminal + errorSeen", async () => {
    const s = await runTranslate({
      targetFormat: FORMATS.OPENAI_RESPONSES,
      sourceFormat: FORMATS.OPENAI_RESPONSES,
      chunks: ['event: response.failed\ndata: {"type":"response.failed"}\n\n'],
    });
    expect(s.terminalSeen).toBe(true);
    expect(s.terminalState).toBe("failure");
    expect(s.terminalType).toBe("response.failed");
  });

  it("Responses response.incomplete → incomplete terminal", async () => {
    const s = await runTranslate({
      targetFormat: FORMATS.OPENAI_RESPONSES,
      sourceFormat: FORMATS.OPENAI_RESPONSES,
      chunks: ['event: response.incomplete\ndata: {"type":"response.incomplete"}\n\n'],
    });
    expect(s.terminalSeen).toBe(true);
    expect(s.terminalState).toBe("incomplete");
  });

  it("Ollama done=true with payload → success 'done' terminal", async () => {
    const s = await runTranslate({
      targetFormat: FORMATS.OLLAMA,
      sourceFormat: FORMATS.OLLAMA,
      // Ollama speaks NDJSON: parseSSELine(OLLAMA) expects bare JSON lines.
      chunks: ['{"done":true,"message":{"role":"assistant","content":""},"total_duration":1}\n\n'],
    });
    expect(s.terminalSeen).toBe(true);
    expect(s.terminalState).toBe("success");
    expect(s.terminalType).toBe("done");
  });
});

describe("Wave 2 stream state machine — lifecycle (translate)", () => {
  it("EOF without terminal → eofSeen=true, terminalSeen stays false", async () => {
    const s = await runTranslate({
      targetFormat: FORMATS.OPENAI,
      sourceFormat: FORMATS.OPENAI,
      chunks: [openaiDelta({ content: "partial" })],
    });
    expect(s.eofSeen).toBe(true);
    expect(s.terminalSeen).toBe(false);
    expect(s.hasText).toBe(true);
  });

  it("provider error frame → errorSeen=true + failure terminal", async () => {
    const s = await runTranslate({
      targetFormat: FORMATS.OPENAI,
      sourceFormat: FORMATS.OPENAI,
      chunks: ['data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n'],
    });
    expect(s.errorSeen).toBe(true);
    expect(s.terminalSeen).toBe(true);
    expect(s.terminalState).toBe("failure");
    expect(s.terminalType).toBe("error");
  });

  it("FORENSIC CLINE: 200 + content deltas + usage + finish_reason=stop + [DONE] + EOF", async () => {
    const s = await runTranslate({
      targetFormat: FORMATS.OPENAI,
      sourceFormat: FORMATS.OPENAI,
      chunks: [
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n',
        openaiDelta({ content: "Answer part 1 " }),
        openaiDelta({ content: "and part 2." }),
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":7}}\n\n',
        "data: [DONE]\n\n",
      ],
    });
    expect(s.streamStarted).toBe(true);
    expect(s.hasText).toBe(true);
    expect(s.hasUsage).toBe(true);
    expect(s.hasReasoning).toBe(false);
    expect(s.hasToolCall).toBe(false);
    expect(s.terminalSeen).toBe(true);
    expect(s.terminalType).toBe("finish_reason");
    expect(s.finishReason).toBe("stop");
    expect(s.eofSeen).toBe(true);
    expect(s.errorSeen).toBe(false);
  });

  it("EMPTY STREAM: opened with only transport keep-alive, zero events → all output flags false, EOF seen", async () => {
    const s = await runTranslate({
      targetFormat: FORMATS.OPENAI,
      sourceFormat: FORMATS.OPENAI,
      chunks: [": keep-alive\n\n"],
    });
    expect(s.streamStarted).toBe(true);
    expect(s.hasText).toBe(false);
    expect(s.hasReasoning).toBe(false);
    expect(s.hasToolCall).toBe(false);
    expect(s.hasUsage).toBe(false);
    expect(s.terminalSeen).toBe(false);
    expect(s.eofSeen).toBe(true);
  });

  it("TOOL-ONLY: tool_call + finish_reason=tool_calls, no text", async () => {
    const s = await runTranslate({
      targetFormat: FORMATS.OPENAI,
      sourceFormat: FORMATS.OPENAI,
      chunks: [
        openaiDelta({ tool_calls: [{ id: "t1", type: "function", function: { name: "run", arguments: "{}" } }] }),
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      ],
    });
    expect(s.hasToolCall).toBe(true);
    expect(s.hasText).toBe(false);
    expect(s.terminalSeen).toBe(true);
    expect(s.terminalState).toBe("success");
  });

  it("REASONING-ONLY: reasoning + finish_reason=stop, no text", async () => {
    const s = await runTranslate({
      targetFormat: FORMATS.OPENAI,
      sourceFormat: FORMATS.OPENAI,
      chunks: [openaiDelta({ reasoning_content: "deep thought" }), 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'],
    });
    expect(s.hasReasoning).toBe(true);
    expect(s.hasText).toBe(false);
    expect(s.terminalSeen).toBe(true);
  });

  it("CONCURRENCY: two simultaneous streams never cross-observe", async () => {
    const completionsA = [];
    const completionsB = [];
    const tsA = createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.OPENAI, "prov", null, null, "mA", "connA", {}, (...a) => completionsA.push(a));
    const tsB = createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.OPENAI, "prov", null, null, "mB", "connB", {}, (...a) => completionsB.push(a));

    // Stream A: text + finish_reason=stop.
    const runA = pump(tsA, [
      openaiDelta({ content: "answer A" }),
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    ]);

    // Stream B: tool call + provider error frame (failure terminal).
    const runB = pump(tsB, [
      openaiDelta({ tool_calls: [{ id: "b1", type: "function", function: { name: "x", arguments: "{}" } }] }),
      'data: {"type":"error","error":{"type":"api_error"}}\n\n',
    ]);

    await Promise.all([runA, runB]);

    const sa = completionsA[completionsA.length - 1][3];
    const sb = completionsB[completionsB.length - 1][3];
    expect(sa.hasText).toBe(true);
    expect(sa.hasToolCall).toBe(false);
    expect(sa.terminalState).toBe("success");
    expect(sb.hasText).toBe(false);
    expect(sb.hasToolCall).toBe(true);
    expect(sb.terminalState).toBe("failure");
  });
});

describe("Wave 2 stream state machine — PASSTHROUGH mode (raw-line heuristics)", () => {
  it("FORENSIC CLINE (native passthrough wire): text + usage + stop + [DONE]", async () => {
    const s = await runPassthrough({
      chunks: [
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Hello!"}}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":2}}\n\n',
        "data: [DONE]\n\n",
      ],
    });
    expect(s.streamStarted).toBe(true);
    expect(s.hasText).toBe(true);
    expect(s.hasUsage).toBe(true);
    expect(s.hasReasoning).toBe(false);
    expect(s.hasToolCall).toBe(false);
    expect(s.terminalSeen).toBe(true);
    expect(s.terminalState).toBe("success");
    expect(s.terminalType).toBe("finish_reason");
    expect(s.eofSeen).toBe(true);
  });

  it("passthrough: role-only chunk does NOT count as text; tool args do not leak text", async () => {
    const s = await runPassthrough({
      chunks: [
        'data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"1","type":"function","function":{"name":"run","arguments":"{\\"command\\":\\"ls\\"}"}}]}}]}\n\n',
      ],
    });
    expect(s.hasText).toBe(false);
    expect(s.hasToolCall).toBe(true);
  });

  it("passthrough: Claude thinking + message_stop observed natively", async () => {
    const s = await runPassthrough({
      chunks: [
        'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"ponder"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ],
    });
    expect(s.hasReasoning).toBe(true);
    expect(s.hasText).toBe(false);
    expect(s.terminalSeen).toBe(true);
    expect(s.terminalState).toBe("success");
    expect(s.terminalType).toBe("message_stop");
  });

  it("passthrough: usage-only + [DONE] → hasUsage without text", async () => {
    const s = await runPassthrough({
      chunks: [
        'data: {"usage":{"prompt_tokens":3,"completion_tokens":1},"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ],
    });
    expect(s.hasUsage).toBe(true);
    expect(s.hasText).toBe(false);
    expect(s.terminalSeen).toBe(true);
    expect(s.terminalState).toBe("success"); // from finish_reason, not [DONE]
  });
});
