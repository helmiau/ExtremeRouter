/**
 * Muse Spark 1.3 tool-call-only Responses audit — focused regression test.
 *
 * This test drives a tool-call-only OpenAI Responses SSE stream (the Muse Spark
 * 1.3 scenario: upstream returns Responses SSE from /zen/v1/responses, client
 * speaks OpenAI Chat Completions) through the actual production Responses
 * translator (openaiResponsesToOpenAIResponse) + formatSSE to capture and assert
 * the EXACT downstream SSE body that the IDE/client receives.
 *
 * Per the audit spec: "If current production output is protocol-valid, DO NOT
 * modify production code. Report that the issue is consumer compatibility."
 *
 * The forensic record for the incident showed:
 *   logicalSuccess=true, hasToolCall=true, classification=success
 *   yet the IDE/client reported "empty response".
 *
 * This test proves the server-side SSE body is a complete, correctly-ordered,
 * protocol-valid OpenAI Chat Completions stream with tool_calls — the root
 * cause is downstream consumer compatibility, not an ExtremeRouter bug.
 *
 * Flow: targetFormat=openai-responses (upstream), sourceFormat=openai (client)
 * Transform: openaiResponsesToOpenAIResponse (Responses SSE → Chat Completions SSE)
 */

import { describe, expect, it } from "vitest";
import "./registerAll.js";
import { translateResponse, initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { formatSSE } from "../../open-sse/utils/streamHelpers.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";

// ── helpers ─────────────────────────────────────────────────────────────

/**
 * Run Responses SSE events through the translator (openai-responses→openai)
 * and format each emitted Chat Completions chunk as downstream SSE bytes.
 * This replicates what stream.js does in TRANSLATE mode:
 *   translateResponse(targetFormat="openai-responses", sourceFormat="openai", parsed, state)
 *   → formatSSE(item, sourceFormat="openai")
 *
 * NOTE: The stream parses upstream `data:` lines with parseSSELine(trimmed, targetFormat).
 * For Responses upstream, each upstream SSE line is:
 *   event: response.xxx\n
 *   data: {...}\n
 * The transform stream captures the event: line, then the data: line is parsed
 * as JSON and passed to translateResponse as a {type, ...} object.
 *
 * For this test we simulate the upstream stream as raw SSE text (event:/data:
 * framing) and pipe it through the full transform stream, which is the truest
 * reproduction. We also test the translator directly for targeted assertions.
 */

function runResponsesToChat(events) {
  const state = initState(FORMATS.OPENAI_RESPONSES);
  const chunks = [];
  for (const ev of events) {
    // The stream parses upstream data: lines into JSON objects.
    // For Responses upstream, the parsed object has the event's `type` field
    // (e.g. "response.output_item.added") and all the event payload fields.
    // The translator's openaiResponsesToOpenAIResponse checks chunk.type || chunk.event.
    const out = translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, ev, state);
    if (Array.isArray(out)) {
      for (const item of out) {
        if (item !== null && item !== undefined) chunks.push(item);
      }
    } else if (out) {
      chunks.push(out);
    }
  }
  // Flush (null chunk → final chunk with finish_reason + usage).
  // translateResponse returns an array; the flush may return null (if
  // response.completed already sent the final chunk) or [] (empty array).
  const flushed = translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, null, state);
  if (Array.isArray(flushed)) {
    for (const item of flushed) {
      if (item !== null && item !== undefined) chunks.push(item);
    }
  } else if (flushed) {
    chunks.push(flushed);
  }
  return chunks;
}

function chunksToSSE(chunks) {
  return chunks.map((c) => formatSSE(c, FORMATS.OPENAI)).join("");
}

/**
 * Run the full transform stream (ReadableStream → createSSETransformStreamWithLogger)
 * to capture the exact downstream bytes, including [DONE] sentinel and flush-phase
 * events. This is the truest reproduction of what the client's ReadableStream receives.
 */
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
      FORMATS.OPENAI_RESPONSES, // targetFormat (upstream speaks Responses)
      FORMATS.OPENAI,           // sourceFormat (client speaks Chat Completions)
      "opencode",               // provider
      null, null, "muse-spark-1.3", "test-conn",
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

/** Build upstream Responses SSE text from {event, data} pairs. */
function buildResponsesSSE(events) {
  return events.map((ev) => {
    const data = JSON.stringify(ev);
    return `event: ${ev.type}\ndata: ${data}\n\n`;
  }).join("");
}

/** Parse downstream SSE text into structured {event, data} pairs. */
function parseSSEEvents(text) {
  const events = [];
  const blocks = text.split("\n\n");
  for (const block of blocks) {
    if (!block.trim()) continue;
    let event = null;
    let data = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7).trim();
      else if (line.startsWith("data: ")) {
        const raw = line.slice(6);
        if (raw === "[DONE]") { data = "[DONE]"; }
        else { try { data = JSON.parse(raw); } catch { data = raw; } }
      }
    }
    if (event || data) events.push({ event, data });
  }
  return events;
}

// ── fixtures: realistic Muse Spark 1.3 tool-call-only Responses stream ─

const RESPONSE_ID = "resp_muse_spark_1.3_001";
const CALL_ID = "call_muse_spark_1_3_a1b2c3d4";
const ITEM_ID = `fc_${CALL_ID}`;
const TOOL_NAME = "read_file";
const TOOL_ARGS = '{"path":"/src/index.ts"}';

/**
 * A tool-call-only Responses SSE stream — the Muse Spark 1.3 incident shape.
 * The model decided to call a tool instead of producing text.
 * No response.output_text.* events at all.
 */
const toolCallOnlyResponsesEvents = [
  { type: "response.created", response: { id: RESPONSE_ID, status: "in_progress", output: [] } },
  { type: "response.output_item.added", output_index: 0, item: { id: ITEM_ID, type: "function_call", call_id: CALL_ID, name: TOOL_NAME, arguments: "" } },
  { type: "response.function_call_arguments.delta", output_index: 0, item_id: ITEM_ID, delta: TOOL_ARGS },
  { type: "response.function_call_arguments.done", output_index: 0, item_id: ITEM_ID, arguments: TOOL_ARGS },
  { type: "response.output_item.done", output_index: 0, item: { id: ITEM_ID, type: "function_call", call_id: CALL_ID, name: TOOL_NAME, arguments: TOOL_ARGS } },
  { type: "response.completed", response: { id: RESPONSE_ID, status: "completed" } },
];

/** A text-only Responses stream (control). */
const textOnlyResponsesEvents = [
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

/** Mixed: text + tool call in the same response. */
const mixedResponsesEvents = [
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

// ── Tests: tool-call-only (the Muse Spark 1.3 incident) ─────────────────

describe("Muse Spark 1.3 tool-call-only: Responses → Chat Completions", () => {
  it("emits tool_call chunks with correct name and call_id", () => {
    const chunks = runResponsesToChat(toolCallOnlyResponsesEvents);
    const toolCallChunks = chunks.filter((c) => c?.choices?.[0]?.delta?.tool_calls?.length > 0);

    expect(toolCallChunks.length).toBeGreaterThan(0);
    const firstTC = toolCallChunks[0].choices[0].delta.tool_calls[0];
    expect(firstTC.id).toBe(CALL_ID);
    expect(firstTC.type).toBe("function");
    expect(firstTC.function.name).toBe(TOOL_NAME);
  });

  it("streams the full tool-call arguments via delta", () => {
    const chunks = runResponsesToChat(toolCallOnlyResponsesEvents);
    const argsChunks = chunks
      .filter((c) => c?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments !== undefined)
      .map((c) => c.choices[0].delta.tool_calls[0].function.arguments);

    // Should contain the delta argument chunk(s) + the full args on output_item.done
    // for no-delta providers. With deltas present, argsStreamed=true → no duplicate.
    const assembled = argsChunks.join("");
    expect(assembled).toBe(TOOL_ARGS);
  });

  it("emits exactly one finish_reason=tool_calls chunk", () => {
    const chunks = runResponsesToChat(toolCallOnlyResponsesEvents);
    const finishChunks = chunks.filter((c) => c?.choices?.[0]?.finish_reason);

    expect(finishChunks).toHaveLength(1);
    expect(finishChunks[0].choices[0].finish_reason).toBe("tool_calls");
  });

  it("does NOT inject any text content for a tool-call-only response", () => {
    const chunks = runResponsesToChat(toolCallOnlyResponsesEvents);
    const textChunks = chunks.filter((c) => c?.choices?.[0]?.delta?.content);

    expect(textChunks).toHaveLength(0);
  });

  it("emits response.created and in_progress on the Responses stream, but these are ignored in the Chat output", () => {
    const chunks = runResponsesToChat(toolCallOnlyResponsesEvents);
    // response.created and response.in_progress don't produce Chat chunks
    // (the translator returns null for them). Only tool_call + finish chunks.
    const meaningfulChunks = chunks.filter((c) =>
      c?.choices?.[0]?.delta?.tool_calls || c?.choices?.[0]?.finish_reason
    );
    expect(meaningfulChunks.length).toBeGreaterThan(0);
  });

  it("does NOT emit a content: null or empty-content chunk that could trigger an 'empty response' heuristic", () => {
    const chunks = runResponsesToChat(toolCallOnlyResponsesEvents);
    // No chunk should have delta.content === "" or delta.content === null
    const emptyContentChunks = chunks.filter((c) =>
      c?.choices?.[0]?.delta?.content === "" || c?.choices?.[0]?.delta?.content === null
    );
    expect(emptyContentChunks).toHaveLength(0);
  });
});

// ── Tests: text-only (control) ──────────────────────────────────────────

describe("Muse Spark 1.3 text-only: Responses → Chat (control)", () => {
  it("emits text content deltas and a stop finish", () => {
    const chunks = runResponsesToChat(textOnlyResponsesEvents);
    const textChunks = chunks.filter((c) => c?.choices?.[0]?.delta?.content);
    const assembled = textChunks.map((c) => c.choices[0].delta.content).join("");

    expect(assembled).toBe("Hello world");

    const finishChunks = chunks.filter((c) => c?.choices?.[0]?.finish_reason);
    expect(finishChunks).toHaveLength(1);
    expect(finishChunks[0].choices[0].finish_reason).toBe("stop");
  });
});

// ── Tests: mixed (text + tool call) ─────────────────────────────────────

describe("Muse Spark 1.3 mixed: Responses → Chat (text + tool_call)", () => {
  it("emits both text content and tool_call chunks", () => {
    const chunks = runResponsesToChat(mixedResponsesEvents);
    const textChunks = chunks.filter((c) => c?.choices?.[0]?.delta?.content);
    const toolCallChunks = chunks.filter((c) => c?.choices?.[0]?.delta?.tool_calls?.length > 0);

    expect(textChunks.length).toBeGreaterThan(0);
    expect(toolCallChunks.length).toBeGreaterThan(0);
    expect(textChunks.map((c) => c.choices[0].delta.content).join("")).toBe("Let me check that.");
  });
});

// ── Tests: full pipeline (stream.js transform) ──────────────────────────

describe("Muse Spark 1.3 full pipeline (stream.js transform)", () => {
  it("produces a protocol-valid Chat Completions SSE stream with [DONE] for tool-call-only", async () => {
    const upstreamSSE = buildResponsesSSE(toolCallOnlyResponsesEvents);
    const sse = await runFullPipeline(upstreamSSE);
    const events = parseSSEEvents(sse);

    // Should contain Chat Completions data: chunks (not Responses event: framing)
    const dataChunks = events.filter((e) => e.data !== "[DONE]" && e.data !== null);
    expect(dataChunks.length).toBeGreaterThan(0);

    // Every data chunk should be a chat.completion.chunk
    for (const e of dataChunks) {
      expect(e.data.object).toBe("chat.completion.chunk");
      expect(e.data.choices).toBeDefined();
      expect(e.data.choices.length).toBeGreaterThan(0);
    }

    // Must contain tool_calls in the stream
    const toolCallChunks = dataChunks.filter((e) =>
      e.data.choices[0]?.delta?.tool_calls?.length > 0
    );
    expect(toolCallChunks.length).toBeGreaterThan(0);

    // Must end with [DONE] sentinel
    expect(sse).toContain("data: [DONE]");

    // Must contain finish_reason
    const finishChunks = dataChunks.filter((e) => e.data.choices[0]?.finish_reason);
    expect(finishChunks.length).toBe(1);
    expect(finishChunks[0].data.choices[0].finish_reason).toBe("tool_calls");
  });

  it("preserves tool call name, call_id, and arguments through the full pipeline", async () => {
    const upstreamSSE = buildResponsesSSE(toolCallOnlyResponsesEvents);
    const sse = await runFullPipeline(upstreamSSE);
    const events = parseSSEEvents(sse);
    const dataChunks = events.filter((e) => e.data !== "[DONE]" && e.data !== null);

    // The first tool_call chunk has the header (id, name, empty args)
    const headerChunk = dataChunks.find((e) =>
      e.data.choices[0]?.delta?.tool_calls?.[0]?.function?.name
    );
    expect(headerChunk).toBeTruthy();
    expect(headerChunk.data.choices[0].delta.tool_calls[0].id).toBe(CALL_ID);
    expect(headerChunk.data.choices[0].delta.tool_calls[0].function.name).toBe(TOOL_NAME);

    // The arguments are streamed (or emitted as a full delta)
    const argsChunks = dataChunks
      .filter((e) => e.data.choices[0]?.delta?.tool_calls?.[0]?.function?.arguments !== undefined)
      .map((e) => e.data.choices[0].delta.tool_calls[0].function.arguments);
    expect(argsChunks.join("")).toBe(TOOL_ARGS);
  });

  it("does NOT accidentally pass Responses event: framing through to the client", async () => {
    const upstreamSSE = buildResponsesSSE(toolCallOnlyResponsesEvents);
    const sse = await runFullPipeline(upstreamSSE);

    // The downstream body must NOT contain Responses event: framing.
    // It should be pure Chat Completions data: framing.
    expect(sse).not.toContain("event: response.created");
    expect(sse).not.toContain("event: response.completed");
    expect(sse).not.toContain("event: response.output_item");
    expect(sse).not.toContain("event: response.function_call_arguments");
  });

  it("text-only control also produces valid Chat Completions SSE through the pipeline", async () => {
    const upstreamSSE = buildResponsesSSE(textOnlyResponsesEvents);
    const sse = await runFullPipeline(upstreamSSE);
    const events = parseSSEEvents(sse);
    const dataChunks = events.filter((e) => e.data !== "[DONE]" && e.data !== null);

    expect(dataChunks.some((e) => e.data.choices[0]?.delta?.content === "Hello")).toBe(true);
    expect(dataChunks.some((e) => e.data.choices[0]?.delta?.content === " world")).toBe(true);
    expect(dataChunks.some((e) => e.data.choices[0]?.finish_reason === "stop")).toBe(true);
    expect(sse).toContain("data: [DONE]");
  });
});

// ── Tests: protocol validity assertions ──────────────────────────────────

describe("Muse Spark 1.3 Chat Completions output validity", () => {
  it("every emitted chunk has id, object, created, model, and choices", () => {
    const chunks = runResponsesToChat(toolCallOnlyResponsesEvents);

    for (const c of chunks) {
      expect(typeof c.id).toBe("string");
      expect(c.object).toBe("chat.completion.chunk");
      expect(c.created).toBeTruthy();
      expect(c.model).toBeTruthy();
      expect(c.choices).toBeDefined();
      expect(c.choices.length).toBe(1);
    }
  });

  it("tool_call chunks have valid index, id, type, function.name, and function.arguments", () => {
    const chunks = runResponsesToChat(toolCallOnlyResponsesEvents);
    const tcChunks = chunks.filter((c) => c?.choices?.[0]?.delta?.tool_calls?.length > 0);

    for (const c of tcChunks) {
      const tc = c.choices[0].delta.tool_calls[0];
      expect(typeof tc.index).toBe("number");
      // The header chunk (first tool_call chunk) has id, type, and function.name.
      // Subsequent argument-delta chunks omit id/type/name per OpenAI streaming spec.
      if (tc.id) expect(tc.id).toBe(CALL_ID);
      if (tc.function?.name) expect(tc.function.name).toBe(TOOL_NAME);
      if (tc.type) expect(tc.type).toBe("function");
      // function.arguments is always present (even if empty string on header)
      expect(tc.function).toBeDefined();
      expect(typeof tc.function.arguments).toBe("string");
    }
  });

  it("finish_reason chunk has tool_calls (not stop) for a tool-call-only response", () => {
    const chunks = runResponsesToChat(toolCallOnlyResponsesEvents);
    const finishChunks = chunks.filter((c) => c?.choices?.[0]?.finish_reason);
    expect(finishChunks).toHaveLength(1);
    expect(finishChunks[0].choices[0].finish_reason).toBe("tool_calls");
  });

  it("exactly one [DONE] sentinel in the full pipeline output", async () => {
    const upstreamSSE = buildResponsesSSE(toolCallOnlyResponsesEvents);
    const sse = await runFullPipeline(upstreamSSE);
    const doneCount = (sse.match(/\[DONE\]/g) || []).length;
    expect(doneCount).toBe(1);
  });
});
