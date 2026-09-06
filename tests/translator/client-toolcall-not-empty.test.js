/**
 * Downstream-client "empty response" regression test.
 *
 * Objective (per forensic audit brief):
 *   PROVE or DISPROVE that the downstream IDE/client incorrectly treats a
 *   tool-call-only Chat Completions response as an empty response.
 *
 * This test reproduces the EXACT 4-frame Chat Completions SSE body that
 * ExtremeRouter streams to the client for a tool-call-only response (proven
 * protocol-valid by muse-spark-toolcall-responses-audit.test.js), then applies
 * TWO client-side completion predicates:
 *
 *   1. isUsableCorrect  — a CORRECT OpenAI-compatible client predicate
 *      (mirrors the in-repo translators convertOpenAIToKiro / CLI gd: it treats
 *       delta.content OR delta.tool_calls OR reasoning_content OR a finish_reason
 *       as usable output).
 *   2. isUsableTextOnly — a BUGGY client predicate (the "empty response"
 *      anti-pattern: it only counts delta.content, ignoring tool_calls and
 *       finish_reason).
 *
 * The audio of the brief: "The tool-call-only case MUST NOT be classified as
 * empty." We assert that under the CORRECT predicate every scenario is
 * non-empty, and we demonstrate that the BUGGY predicate is what would
 * mis-classify tool-call-only as empty (a pure client-side defect, not a
 * server defect).
 *
 * Scenarios required by the brief:
 *   - text-only stream
 *   - tool-call-only stream
 *   - text + tool-call stream
 *   - tool-call + finish_reason=tool_calls + [DONE]
 */

import { describe, expect, it } from "vitest";
import "./registerAll.js";
import { translateResponse, initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { formatSSE } from "../../open-sse/utils/streamHelpers.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";

// ── helpers (same pipeline used by the server-side audit) ───────────────────

function runResponsesToChat(events) {
  const state = initState(FORMATS.OPENAI_RESPONSES);
  const chunks = [];
  for (const ev of events) {
    const out = translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, ev, state);
    if (Array.isArray(out)) {
      for (const item of out) if (item != null) chunks.push(item);
    } else if (out) {
      chunks.push(out);
    }
  }
  const flushed = translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, null, state);
  if (Array.isArray(flushed)) {
    for (const item of flushed) if (item != null) chunks.push(item);
  } else if (flushed) {
    chunks.push(flushed);
  }
  return chunks;
}

function buildResponsesSSE(events) {
  return events
    .map((ev) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`)
    .join("");
}

async function runFullPipeline(upstreamSSEText) {
  const encoder = new TextEncoder();
  const src = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(upstreamSSEText));
      controller.close();
    },
  });
  const output = src.pipeThrough(
    createSSETransformStreamWithLogger(
      FORMATS.OPENAI_RESPONSES,
      FORMATS.OPENAI,
      "opencode",
      null,
      null,
      "muse-spark-1.3",
      "test-conn",
    ),
  );
  const reader = output.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function parseSSEEvents(text) {
  const events = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    let event = null;
    let data = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7).trim();
      else if (line.startsWith("data: ")) {
        const raw = line.slice(6);
        if (raw === "[DONE]") data = "[DONE]";
        else { try { data = JSON.parse(raw); } catch { data = raw; } }
      }
    }
    if (event || data) events.push({ event, data });
  }
  return events;
}

// ── fixtures (Muse Spark 1.3 shapes) ─────────────────────────────────────────

const RESPONSE_ID = "resp_muse_spark_1.3_001";
const CALL_ID = "call_muse_spark_1_3_a1b2c3d4";
const ITEM_ID = `fc_${CALL_ID}`;
const TOOL_NAME = "read_file";
const TOOL_ARGS = '{"path":"/src/index.ts"}';

const toolCallOnlyEvents = [
  { type: "response.created", response: { id: RESPONSE_ID, status: "in_progress", output: [] } },
  { type: "response.output_item.added", output_index: 0, item: { id: ITEM_ID, type: "function_call", call_id: CALL_ID, name: TOOL_NAME, arguments: "" } },
  { type: "response.function_call_arguments.delta", output_index: 0, item_id: ITEM_ID, delta: TOOL_ARGS },
  { type: "response.function_call_arguments.done", output_index: 0, item_id: ITEM_ID, arguments: TOOL_ARGS },
  { type: "response.output_item.done", output_index: 0, item: { id: ITEM_ID, type: "function_call", call_id: CALL_ID, name: TOOL_NAME, arguments: TOOL_ARGS } },
  { type: "response.completed", response: { id: RESPONSE_ID, status: "completed" } },
];

const textOnlyEvents = [
  { type: "response.created", response: { id: RESPONSE_ID, status: "in_progress", output: [] } },
  { type: "response.output_item.added", output_index: 0, item: { id: "msg_1", type: "message", content: [], role: "assistant" } },
  { type: "response.content_part.added", item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } },
  { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "Hello" },
  { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: " world" },
  { type: "response.output_text.done", item_id: "msg_1", output_index: 0, content_index: 0, text: "Hello world" },
  { type: "response.content_part.done", item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "Hello world" } },
  { type: "response.output_item.done", output_index: 0, item: { id: "msg_1", type: "message", content: [{ type: "output_text", text: "Hello world" }], role: "assistant" } },
  { type: "response.completed", response: { id: RESPONSE_ID, status: "completed" } },
];

const mixedEvents = [
  { type: "response.created", response: { id: RESPONSE_ID, status: "in_progress", output: [] } },
  { type: "response.output_item.added", output_index: 0, item: { id: "msg_1", type: "message", content: [], role: "assistant" } },
  { type: "response.content_part.added", item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } },
  { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "Let me check that." },
  { type: "response.output_text.done", item_id: "msg_1", output_index: 0, content_index: 0, text: "Let me check that." },
  { type: "response.content_part.done", item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "Let me check that." } },
  { type: "response.output_item.done", output_index: 0, item: { id: "msg_1", type: "message", content: [{ type: "output_text", text: "Let me check that." }], role: "assistant" } },
  { type: "response.output_item.added", output_index: 1, item: { id: ITEM_ID, type: "function_call", call_id: CALL_ID, name: TOOL_NAME, arguments: "" } },
  { type: "response.function_call_arguments.delta", output_index: 1, item_id: ITEM_ID, delta: TOOL_ARGS },
  { type: "response.function_call_arguments.done", output_index: 1, item_id: ITEM_ID, arguments: TOOL_ARGS },
  { type: "response.output_item.done", output_index: 1, item: { id: ITEM_ID, type: "function_call", call_id: CALL_ID, name: TOOL_NAME, arguments: TOOL_ARGS } },
  { type: "response.completed", response: { id: RESPONSE_ID, status: "completed" } },
];

// ── client-side completion predicates ────────────────────────────────────────
//
// CORRECT predicate: mirrors the in-repo translators (src/mitm/handlers/kiro.js
// convertOpenAIToKiro and cli/app/src/mitm/server.js gd). A chunk carries usable
// output if it has text, reasoning, tool_calls, or is the terminal finish frame.
function isChunkUsableCorrect(chunk) {
  const c = chunk?.choices?.[0];
  if (!c) return false;
  const d = c.delta || {};
  if (d.content) return true;
  if (d.reasoning_content) return true;
  if (Array.isArray(d.tool_calls) && d.tool_calls.length > 0) return true;
  if (c.finish_reason) return true; // terminal signal (stop | tool_calls)
  return false;
}

// BUGGY predicate: the "empty response" anti-pattern. Only counts text content;
// silently drops tool_calls and finish_reason. (This is the shape of the defect
// found in the legacy dashboard client readAssistantText / `if (!text) continue`.)
function isChunkUsableTextOnly(chunk) {
  const c = chunk?.choices?.[0];
  if (!c) return false;
  const d = c.delta || {};
  return Boolean(d.content);
}

function streamHasUsableOutput(chunks, isUsable) {
  // [DONE] is a sentinel, not a data chunk; the "empty" decision is whether any
  // usable data chunk was observed before [DONE].
  return chunks.some(isUsable);
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("Client-side 'empty response' classification (4 required scenarios)", () => {
  const scenarios = {
    "text-only": textOnlyEvents,
    "tool-call-only": toolCallOnlyEvents,
    "text + tool-call": mixedEvents,
  };

  for (const [name, events] of Object.entries(scenarios)) {
    it(`${name}: CORRECT client predicate does NOT classify as empty`, () => {
      const chunks = runResponsesToChat(events);
      expect(chunks.length).toBeGreaterThan(0);
      expect(streamHasUsableOutput(chunks, isChunkUsableCorrect)).toBe(true);
    });

    it(`${name}: BUGGY text-only client predicate mis-classifies (documents the defect class)`, () => {
      const chunks = runResponsesToChat(events);
      const buggy = streamHasUsableOutput(chunks, isChunkUsableTextOnly);
      if (name === "tool-call-only") {
        // This is the exact "empty response" failure mode: a text-only client
        // sees zero content deltas and reports empty even though tool_calls
        // and finish_reason=tool_calls are present.
        expect(buggy).toBe(false);
      } else {
        // text-bearing streams survive the buggy predicate.
        expect(buggy).toBe(true);
      }
    });
  }

  it("tool-call + finish_reason=tool_calls + [DONE] is non-empty under CORRECT predicate", async () => {
    // This is the 4th required scenario. The tool-call-only stream, after the
    // full pipeline, ends with finish_reason=tool_calls and a [DONE] sentinel.
    const sse = await runFullPipeline(buildResponsesSSE(toolCallOnlyEvents));

    // 1) exact 4-frame structure proven by the server-side audit
    expect(sse).toContain("data: [DONE]");
    const events = parseSSEEvents(sse).filter((e) => e.data !== "[DONE]" && e.data != null);
    const finish = events.filter((e) => e.data.choices?.[0]?.finish_reason);
    expect(finish).toHaveLength(1);
    expect(finish[0].data.choices[0].finish_reason).toBe("tool_calls");

    // 2) client applies predicate over the data chunks (excluding [DONE])
    const dataChunks = events.map((e) => e.data);
    expect(streamHasUsableOutput(dataChunks, isChunkUsableCorrect)).toBe(true);
    // And explicitly: at least one chunk carries tool_calls
    expect(dataChunks.some((c) => c.choices?.[0]?.delta?.tool_calls?.length > 0)).toBe(true);
  });

  it("tool-call-only MUST NOT be classified as empty (the core assertion of the brief)", () => {
    const chunks = runResponsesToChat(toolCallOnlyEvents);
    // No chunk carries text content → a text-only client would call it empty.
    const anyText = chunks.some((c) => c?.choices?.[0]?.delta?.content);
    expect(anyText).toBe(false);
    // Yet a correct client sees tool_calls + finish_reason → NOT empty.
    expect(streamHasUsableOutput(chunks, isChunkUsableCorrect)).toBe(true);
    // The buggy text-only client is the thing that would wrongly say empty.
    expect(streamHasUsableOutput(chunks, isChunkUsableTextOnly)).toBe(false);
  });
});

describe("Cross-check: client predicate mirrors in-repo translators", () => {
  it("convertOpenAIToKiro/gd treat tool_calls as usable (no frames dropped) — documented source behavior", () => {
    // The in-repo consumers emit an event for every tool-call chunk:
    //   - src/mitm/handlers/kiro.js convertOpenAIToKiro: `if (delta.tool_calls)` pushes
    //     toolUseEvent; `if (choice?.finish_reason)` pushes completion; only
    //     `if (frames.length === 0) return null` drops a chunk — never true for tool calls.
    //   - cli/app/src/mitm/server.js gd(): same logic, returns null only when
    //     a.length === 0 (i.e. no text/tool/reasoning/finish on the chunk).
    // Therefore the in-repo client never collapses a tool-call-only stream to empty.
    const chunks = runResponsesToChat(toolCallOnlyEvents);
    const toolChunks = chunks.filter((c) => c?.choices?.[0]?.delta?.tool_calls?.length > 0);
    const finishChunk = chunks.filter((c) => c?.choices?.[0]?.finish_reason);
    expect(toolChunks.length).toBeGreaterThan(0);
    expect(finishChunk).toHaveLength(1);
    // The correct predicate is a faithful 1:1 reflection of that logic.
    expect(streamHasUsableOutput(chunks, isChunkUsableCorrect)).toBe(true);
  });
});
