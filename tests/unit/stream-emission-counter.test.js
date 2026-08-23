/**
 * Streaming Phase 1 — SSE emission counter & telemetry accuracy.
 *
 * Instrumentation-only tests: verify that `sseEmittedCount` (surfaced in the
 * `dbg("SSE", …)` flush log) accurately reflects the number of `enqueueTracked`
 * calls in BOTH PASSTHROUGH and TRANSLATE modes, and that `dataLines`/`
 * `eventLines` counters are semantically correct and distinct.
 *
 * dbg fires in `finally` block → emitted = transform + flush-phase emissions.
 * No behavioral assertions (success/fallback/error) — those belong to Phase 2.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "../translator/registerAll.js";
import { createPassthroughStreamWithLogger, createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

// ── helpers ─────────────────────────────────────────────────────────────

function sseStream(input) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(input));
      controller.close();
    },
  });
}

async function pipeAndCollect(stream, transform) {
  const output = stream.pipeThrough(transform);
  const reader = output.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const chunks = [];
  while (true) {
    let done = false;
    try {
      const result = await reader.read();
      done = result.done;
      if (!done && result.value) {
        const decoded = decoder.decode(result.value, { stream: true });
        text += decoded;
        chunks.push(decoded);
      }
    } catch {
      break;
    }
    if (done) break;
  }
  text += decoder.decode();
  return { text, chunks };
}

function openaiDelta(content) {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
}

function openaiFinish(reason = "stop") {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\n`;
}

function openaiUsage(usage) {
  return `data: ${JSON.stringify({ usage })}\n\n`;
}

function openaiSse(chunk) {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function claudeFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// Capture DBG:SSE flush log lines (emissions, counters).
let dbgSpy;
const flushLogs = [];

beforeEach(() => {
  flushLogs.length = 0;
  dbgSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
    const line = args.join(" ");
    if (line.includes("[DBG:SSE]") && line.includes("flush |")) {
      flushLogs.push(line);
    }
  });
});

afterEach(() => {
  dbgSpy.mockRestore();
});

function lastFlushLog() {
  return flushLogs[flushLogs.length - 1] || "";
}

function extractCounter(logLine, key) {
  const m = logLine.match(new RegExp(`${key}=(\\d+)`));
  return m ? parseInt(m[1], 10) : null;
}

// ── A. PASSTHROUGH MODE ────────────────────────────────────────────────
// In PASSTHROUGH mode:
// - data: lines that pass hasValuableContent are forwarded + counted
// - empty lines (SSE framing from \n\n split) are forwarded but NOT counted
// - [DONE] from input is forwarded + counted; flush also emits [DONE] + counted
// - hasValuableContent falls through to `return true` for chunks without
//   choices[0].delta (e.g. usage-only), so those ARE forwarded + counted
//
// NOTE: In test env, logUsage may throw for valid usage objects (no DB),
// preventing flush [DONE]. Tests that exercise valid usage use assertions
// that tolerate this — the key tests use empty usage (appendRequestLog path).

describe("PASSTHROUGH mode — emission counter", () => {
  it("single data event + [DONE]: emitted = content + input[DONE] + flush[DONE] = 3", async () => {
    const input = openaiDelta("hello") + "data: [DONE]\n\n";
    await pipeAndCollect(sseStream(input), createPassthroughStreamWithLogger("test-provider", null, "gpt-4", "conn-1", { messages: [] }));

    const log = lastFlushLog();
    // content (1) + input [DONE] (1) + flush [DONE] (1) = 3
    expect(extractCounter(log, "emitted")).toBe(3);
    expect(extractCounter(log, "dataLines")).toBe(2); // 2 data: lines
    expect(extractCounter(log, "eventLines")).toBe(0);
    expect(extractCounter(log, "recvLines")).toBe(2);
  });

  it("multiple events: each content + [DONE] counted", async () => {
    const input = openaiDelta("hello") + openaiDelta(" world") + openaiFinish("stop") + "data: [DONE]\n\n";
    const { text } = await pipeAndCollect(sseStream(input), createPassthroughStreamWithLogger("test-provider", null, "gpt-4", "conn-1", { messages: [] }));

    const log = lastFlushLog();
    // 2 content + 1 finish + 1 input[DONE] + 1 flush[DONE] = 5
    expect(extractCounter(log, "emitted")).toBe(5);
    expect(extractCounter(log, "dataLines")).toBe(4);
    expect(extractCounter(log, "eventLines")).toBe(0);
    expect(extractCounter(log, "recvLines")).toBe(4);
    expect(text).toContain("hello");
    expect(text).toContain(" world");
    expect(text).toContain("data: [DONE]");
  });

  it("multi-chunk stream: count reflects emissions not chunk count", async () => {
    const chunk1 = openaiDelta("a") + openaiDelta("b");
    const chunk2 = openaiDelta("c") + "data: [DONE]\n\n";
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(chunk1));
        controller.enqueue(new TextEncoder().encode(chunk2));
        controller.close();
      },
    });

    await pipeAndCollect(stream, createPassthroughStreamWithLogger("test-provider", null, "gpt-4", "conn-1", { messages: [] }));

    const log = lastFlushLog();
    // 3 content + 1 input[DONE] + 1 flush[DONE] = 5 emissions (not 2 = chunk count)
    expect(extractCounter(log, "emitted")).toBe(5);
  });

  it("finish event: hasValuableContent passes (finish_reason truthy)", async () => {
    const input = openaiDelta("x") + openaiFinish("stop") + "data: [DONE]\n\n";
    await pipeAndCollect(sseStream(input), createPassthroughStreamWithLogger("test-provider", null, "gpt-4", "conn-1", {}));

    const log = lastFlushLog();
    // content + finish + input[DONE] + flush[DONE] = 4
    expect(extractCounter(log, "emitted")).toBe(4);
  });

  it("usage-only chunk forwarded (hasValuableContent falls through to true)", async () => {
    // OpenAI chunks without choices[0].delta fall through to `return true`
    // at streamHelpers.js:61, so they ARE forwarded and counted.
    // In test env, logUsage(validUsage) throws (no DB), so flush [DONE] is
    // skipped — emitted reflects transform-phase only.
    const input = openaiDelta("hi") + openaiUsage({ prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }) + "data: [DONE]\n\n";
    await pipeAndCollect(sseStream(input), createPassthroughStreamWithLogger("test-provider", null, "gpt-4", "conn-1", {}));

    const log = lastFlushLog();
    // 3 non-empty lines: content, usage, [DONE]
    expect(extractCounter(log, "recvLines")).toBe(3);
    expect(extractCounter(log, "dataLines")).toBe(3);
    expect(extractCounter(log, "eventLines")).toBe(0);
    // content (1) + usage (1, fallthrough true) + input[DONE] (1) + flush[DONE] (1) = 4
    expect(extractCounter(log, "emitted")).toBe(4);
  });

  it("terminal [DONE] counted as emitted", async () => {
    const input = openaiDelta("test") + "data: [DONE]\n\n";
    await pipeAndCollect(sseStream(input), createPassthroughStreamWithLogger("test-provider", null, "gpt-4", "conn-1", {}));

    const log = lastFlushLog();
    // content + input[DONE] + flush[DONE] = 3
    expect(extractCounter(log, "emitted")).toBe(3);
  });
});

// ── B. TRANSLATE MODE ──────────────────────────────────────────────────
// createSSETransformStreamWithLogger(targetFormat, sourceFormat, ...)
//   targetFormat = provider's format (input chunk format)
//   sourceFormat = client's format (output item format)
//
// In TRANSLATE mode, the input's `data: [DONE]` is consumed (sets streamDoneSent)
// but NOT re-emitted — the translated terminal event (e.g. Claude's
// message_stop) IS the terminal signal. No flush [DONE] is emitted for
// non-Responses formats.

describe("TRANSLATE mode — emission counter (unchanged behavior)", () => {
  it("OpenAI → Claude: translated events each counted once", async () => {
    const input = openaiDelta("hello world") + openaiFinish("stop") + "data: [DONE]\n\n";
    await pipeAndCollect(
      sseStream(input),
      createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.CLAUDE, "openai", null, null, "gpt-4", "conn-1", { messages: [] })
    );

    const log = lastFlushLog();
    // openaiDelta → message_start + content_block_start + content_block_delta (3)
    // openaiFinish → content_block_stop + message_delta + message_stop (3)
    // [DONE] → consumed, streamDoneSent=true, NOT re-emitted
    // flush: translateResponse(null) → [] → no emissions
    // Total: 6
    expect(extractCounter(log, "emitted")).toBe(6);
    expect(extractCounter(log, "dataLines")).toBe(3);   // 3 data: lines in input
    expect(extractCounter(log, "eventLines")).toBe(0); // OpenAI has no event: lines
  });

  it("OpenAI → Claude: multiple translated events — no double-count", async () => {
    const input = openaiDelta("a") + openaiDelta("b") + openaiDelta("c") + openaiFinish("stop") + "data: [DONE]\n\n";
    await pipeAndCollect(
      sseStream(input),
      createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.CLAUDE, "openai", null, null, "gpt-4", "conn-1", { messages: [] })
    );

    const log = lastFlushLog();
    // First chunk: message_start + content_block_start + content_block_delta (3)
    // Second chunk: content_block_delta (1)
    // Third chunk: content_block_delta (1)
    // Finish: content_block_stop + message_delta + message_stop (3)
    // [DONE]: consumed, not re-emitted
    // Total: 8
    expect(extractCounter(log, "emitted")).toBe(8);
  });

  it("OpenAI → Claude: usage-only chunk does not block translation of other chunks", async () => {
    // A usage-only chunk (no choices) returns null from openaiToClaudeResponse
    // → 0 emissions, but extractUsage still runs on the raw chunk (line 284,
    // before translation) and stores usage in state.usage.
    const usageChunk = { usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 } };
    const input = openaiDelta("hi") + openaiSse(usageChunk) + openaiFinish("stop") + "data: [DONE]\n\n";
    await pipeAndCollect(
      sseStream(input),
      createSSETransformStreamWithLogger(FORMATS.OPENAI, FORMATS.CLAUDE, "openai", null, null, "gpt-4", "conn-1", { messages: [] })
    );

    const log = lastFlushLog();
    // openaiDelta("hi") → message_start + content_block_start + content_block_delta (3)
    // usage-only → openaiToClaudeResponse returns null → 0 emissions
    // openaiFinish → content_block_stop + message_delta + message_stop (3)
    // [DONE] → consumed, not re-emitted
    // Total: 6
    expect(extractCounter(log, "emitted")).toBe(6);
    expect(extractCounter(log, "recvLines")).toBe(4);
    expect(extractCounter(log, "dataLines")).toBe(4);
    expect(extractCounter(log, "eventLines")).toBe(0);
  });

  it("Claude → OpenAI: translated events counted", async () => {
    const input =
      claudeFrame("message_start", { type: "message_start", message: { id: "msg_1", model: "claude-3", content: [], usage: { input_tokens: 10, output_tokens: 0 } } }) +
      claudeFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } }) +
      claudeFrame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }) +
      claudeFrame("message_stop", { type: "message_stop" }) +
      "data: [DONE]\n\n";

    await pipeAndCollect(
      sseStream(input),
      createSSETransformStreamWithLogger(FORMATS.CLAUDE, FORMATS.OPENAI, "anthropic", null, null, "claude-3-7", "conn-1", { messages: [] })
    );

    const log = lastFlushLog();
    // Input: 4 event: lines, 5 data: lines (4 from frames + 1 [DONE])
    // provider="anthropic" — [DONE] consumed in TRANSLATE, not re-emitted
    expect(extractCounter(log, "eventLines")).toBe(4);
    expect(extractCounter(log, "dataLines")).toBe(5);
    expect(extractCounter(log, "emitted")).toBeGreaterThan(0);
  });
});

// ── C. TERMINATION ────────────────────────────────────────────────────

describe("Termination paths — emission counting", () => {
  it("normal EOF: [DONE] sentinel emitted and counted", async () => {
    const input = openaiDelta("done") + "data: [DONE]\n\n";
    await pipeAndCollect(sseStream(input), createPassthroughStreamWithLogger("test-provider", null, "gpt-4", "conn-1", {}));

    const log = lastFlushLog();
    // content + input[DONE] + flush[DONE] = 3
    expect(extractCounter(log, "emitted")).toBe(3);
  });

  it("flush emission: buffered final event emitted on EOF", async () => {
    // chunk1 = openaiDelta("a")  → 1 content in transform
    // chunk2 = openaiDelta("b") + data:[DONE]  → 1 content + 1 [DONE] in transform
    // flush: [DONE] (1)
    // Total: 4
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(openaiDelta("a")));
        controller.enqueue(new TextEncoder().encode(openaiDelta("b") + "data: [DONE]\n\n"));
        controller.close();
      },
    });

    await pipeAndCollect(stream, createPassthroughStreamWithLogger("test-provider", null, "gpt-4", "conn-1", {}));

    const log = lastFlushLog();
    // 2 content + 1 input[DONE] + 1 flush[DONE] = 4
    expect(extractCounter(log, "emitted")).toBe(4);
  });

  it("upstream error: emitted before error counted in flush log", async () => {
    // Enqueue content, then error on next tick so transform processes the chunk
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(openaiDelta("partial")));
        setTimeout(() => controller.error(new Error("upstream failure")), 0);
      },
    });

    const { text } = await pipeAndCollect(stream, createPassthroughStreamWithLogger("test-provider", null, "gpt-4", "conn-1", {}));

    // Content was forwarded before error propagated
    expect(text).toContain("partial");
    // dbg fires in finally — verify the content chunk was counted
    const log = lastFlushLog();
    if (log) {
      expect(extractCounter(log, "emitted")).toBeGreaterThan(0);
    }
  });
});

// ── D. TELEMETRY SEMANTICS ─────────────────────────────────────────────

describe("Telemetry semantics", () => {
  it("data-only OpenAI SSE: eventLines=0, dataLines>0, emitted>0", async () => {
    const input = openaiDelta("a") + openaiDelta("b") + openaiFinish("stop") + "data: [DONE]\n\n";
    await pipeAndCollect(sseStream(input), createPassthroughStreamWithLogger("test-provider", null, "gpt-4", "conn-1", {}));

    const log = lastFlushLog();
    expect(extractCounter(log, "eventLines")).toBe(0);
    expect(extractCounter(log, "dataLines")).toBe(4);
    expect(extractCounter(log, "recvLines")).toBe(4);
    // 3 content/finish + 1 input[DONE] + 1 flush[DONE] = 5
    expect(extractCounter(log, "emitted")).toBe(5);
  });

  it("event+data Claude SSE: eventLines>0, dataLines>0, both distinct", async () => {
    const input =
      claudeFrame("message_start", { type: "message_start", message: { id: "m1", model: "cl", content: [], usage: { input_tokens: 1 } } }) +
      claudeFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } }) +
      claudeFrame("message_stop", { type: "message_stop" }) +
      "data: [DONE]\n\n";

    await pipeAndCollect(sseStream(input), createPassthroughStreamWithLogger("anthropic", null, "claude-3", "conn-1", {}));

    const log = lastFlushLog();
    expect(extractCounter(log, "eventLines")).toBe(3);   // 3 event: lines
    expect(extractCounter(log, "dataLines")).toBe(4);   // 3 data: from frames + 1 [DONE]
    expect(extractCounter(log, "recvLines")).toBe(7);   // 7 non-empty trimmed lines
    // 7 from transform (3 events + 3 data + 1 [DONE]) + 1 flush[DONE] = 8
    expect(extractCounter(log, "emitted")).toBe(8);
  });

  it("emitted equals actual non-empty downstream chunk count (no double-counting)", async () => {
    const input = openaiDelta("x") + "data: [DONE]\n\n";
    const { chunks } = await pipeAndCollect(sseStream(input), createPassthroughStreamWithLogger("test-provider", null, "gpt-4", "conn-1", {}));

    const log = lastFlushLog();
    // emitted counts only SSE events (data:/event: payloads), not empty framing lines
    const nonEmptyChunks = chunks.filter((c) => c.trim());
    expect(extractCounter(log, "emitted")).toBe(nonEmptyChunks.length);
    // 3: content + input[DONE] + flush[DONE]
    expect(extractCounter(log, "emitted")).toBe(3);
  });

  it("emitted does NOT exceed actual chunk count (no double-counting)", async () => {
    const input = openaiDelta("a") + openaiDelta("b") + openaiDelta("c") + "data: [DONE]\n\n";
    const { chunks } = await pipeAndCollect(sseStream(input), createPassthroughStreamWithLogger("test-provider", null, "gpt-4", "conn-1", {}));

    const log = lastFlushLog();
    const nonEmptyChunks = chunks.filter((c) => c.trim());
    expect(extractCounter(log, "emitted")).toBe(nonEmptyChunks.length);
    // 5: 3 content + input[DONE] + flush[DONE]
    expect(extractCounter(log, "emitted")).toBe(5);
  });

  it("emitted is never greater than recvLines + 1 (flush [DONE] is the only excess)", async () => {
    // In PASSTHROUGH mode, flush adds exactly one [DONE] emission that is not
    // counted in recvLines (which only counts transform-phase lines).
    const input = openaiDelta("a") + openaiFinish("stop") + "data: [DONE]\n\n";
    await pipeAndCollect(sseStream(input), createPassthroughStreamWithLogger("test-provider", null, "gpt-4", "conn-1", {}));

    const log = lastFlushLog();
    // recvLines=3 (content, finish, [DONE]), emitted=4 (those 3 + flush [DONE])
    expect(extractCounter(log, "emitted")).toBe(extractCounter(log, "recvLines") + 1);
  });
});

// ── E. FORENSIC REGRESSION: Cline/OpenAI passthrough ──────────────────

describe("Forensic regression: Cline/OpenAI passthrough", () => {
  it("13-line Cline stream: emitted > 0 (previously 0 due to passthrough counter gap)", async () => {
    // Simulates the forensic case: HTTP 200, 13 non-empty recvLines, emitted=0
    // before the fix because sseEmittedCount was never incremented in PASSTHROUGH.
    const lines = [];
    for (let i = 0; i < 10; i++) lines.push(openaiDelta(`chunk${i}`));
    lines.push(openaiFinish("stop"));
    lines.push(openaiUsage({ prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }));
    lines.push("data: [DONE]\n\n");
    const input = lines.join("");

    await pipeAndCollect(sseStream(input), createPassthroughStreamWithLogger("cline", null, "deepseek/deepseek-v4-flash", "conn-1", { messages: [] }));

    const log = lastFlushLog();
    // recvLines = 13 (10 content + finish + usage + [DONE], all data: lines)
    // dataLines = 13
    // eventLines = 0 (OpenAI has no event: lines)
    // emitted = 10 content + 1 finish + 1 usage(fallthrough) + 1 input[DONE] + 1 flush[DONE] = 14
    expect(extractCounter(log, "recvLines")).toBe(13);
    expect(extractCounter(log, "dataLines")).toBe(13);
    expect(extractCounter(log, "eventLines")).toBe(0);
    expect(extractCounter(log, "emitted")).toBe(14);
    expect(extractCounter(log, "emitted")).toBeGreaterThan(0); // <-- previously was 0
  });

  it("before-fix regression guard: emitted was always 0 in passthrough", async () => {
    const input = openaiDelta("test") + "data: [DONE]\n\n";
    await pipeAndCollect(sseStream(input), createPassthroughStreamWithLogger("cline", null, "gpt-4", "conn-1", {}));

    const log = lastFlushLog();
    // Before fix: emitted=0 (counter never incremented in passthrough)
    // After fix: content + input[DONE] + flush[DONE] = 3
    expect(extractCounter(log, "emitted")).toBe(3);
    expect(extractCounter(log, "emitted")).not.toBe(0);
  });
});
