/**
 * Audit of the OpenAI Responses streaming paths.
 *
 * Covers the three consumers of a Responses SSE stream and the terminal-event
 * matrix (completed / incomplete / failed / cancelled / error):
 *
 *  1. Responses → OpenAI Chat (openaiResponsesToOpenAIResponse): tool-call
 *     arguments must be emitted EXACTLY once (regression for the duplicated
 *     args bug — the golden snapshot previously locked in the double emit),
 *     and each terminal event must map to the right finish/error chunk without
 *     a second terminal chunk.
 *  2. Forced non-stream (convertResponsesStreamToJson): exactly-once terminal
 *     status for completed / incomplete / no-terminal streams.
 *  3. Responses → Responses passthrough (createSSEStream translate mode):
 *     events forwarded in order with a single [DONE], terminal events never
 *     synthesized twice.
 */

import { describe, expect, it } from "vitest";
import "./registerAll.js";
import { translateResponse, initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createResponsesAccumulator, finalizeResponsesAccumulator } from "../../open-sse/translator/concerns/responsesAccumulator.js";
import { convertResponsesStreamToJson } from "../../open-sse/transformer/streamToJsonConverter.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";

// ── helpers ─────────────────────────────────────────────────────────────

function runResponsesToChat(events) {
  const state = initState(FORMATS.OPENAI_RESPONSES);
  const all = [];
  for (const ev of events) {
    const out = translateResponse(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, ev, state);
    if (Array.isArray(out)) all.push(...out);
    else if (out) all.push(out);
  }
  return all;
}

function toolArgs(chunks) {
  return chunks
    .filter((c) => c?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments !== undefined)
    .map((c) => c.choices[0].delta.tool_calls[0].function.arguments);
}

// Ignore the empty-arguments header chunk emitted by output_item.added.
function streamedArgs(chunks) {
  return toolArgs(chunks).filter((a) => a !== "");
}

function finishChunks(chunks) {
  return chunks.filter((c) => c?.choices?.[0]?.finish_reason).map((c) => c.choices[0].finish_reason);
}

const SSE_ARGS = '{"command":"git status --short","timeout":120000,"description":"status","run_in_background":false,"dangerous":false}';

function sseStream(bodyText) {
  return new Response(bodyText, { headers: { "content-type": "text/event-stream" } }).body;
}

async function runPassthrough(input) {
  const encoder = new TextEncoder();
  const src = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(input));
      controller.close();
    },
  });
  const output = src.pipeThrough(
    createSSETransformStreamWithLogger(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI_RESPONSES, "codex", null, null, "gpt-5.6-luna"),
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

function sseFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ── 1. Responses → OpenAI Chat ──────────────────────────────────────────

describe("Responses → OpenAI Chat (openaiResponsesToOpenAIResponse)", () => {
  it("emits streamed tool-call arguments exactly once (no duplicate)", () => {
    const events = [
      { type: "response.output_item.added", output_index: 0, item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "Bash", arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_1", delta: '{"command":"git st' },
      { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_1", delta: 'atus --short","timeout":120000,"description":"status","run_in_background":false,"dangerous":false}' },
      { type: "response.output_item.done", output_index: 0, item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "Bash", arguments: SSE_ARGS } },
      { type: "response.completed", response: { id: "resp_1", status: "completed" } },
    ];

    const chunks = runResponsesToChat(events);
    expect(streamedArgs(chunks).join("")).toBe(SSE_ARGS);
    expect(streamedArgs(chunks)).toHaveLength(2); // one per delta, no full re-emit
    expect(finishChunks(chunks)).toEqual(["tool_calls"]);
  });

  it("still emits full arguments once for no-delta providers (output_item.done only)", () => {
    const events = [
      { type: "response.output_item.added", output_index: 0, item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "Bash" } },
      { type: "response.output_item.done", output_index: 0, item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "Bash", arguments: SSE_ARGS } },
      { type: "response.completed", response: { id: "resp_1", status: "completed" } },
    ];

    const chunks = runResponsesToChat(events);
    expect(streamedArgs(chunks).join("")).toBe(SSE_ARGS);
  });

  it("maps response.incomplete (max_output_tokens) to finish_reason length, not an error", () => {
    const events = [
      { type: "response.output_text.delta", delta: "partial answer" },
      { type: "response.incomplete", response: { id: "resp_1", status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } },
    ];

    const chunks = runResponsesToChat(events);
    expect(finishChunks(chunks)).toEqual(["length"]);
    expect(chunks.some((c) => c?.choices?.[0]?.delta?.content?.startsWith?.("[Error]"))).toBe(false);
  });

  it("maps response.failed / response.cancelled / error to a single error chunk", () => {
    for (const terminal of [
      { type: "response.failed", response: { id: "resp_1", status: "failed", error: { message: "boom" } } },
      { type: "response.cancelled", response: { id: "resp_1", status: "cancelled" } },
      { type: "error", error: { message: "model_not_found" } },
    ]) {
      const chunks = runResponsesToChat([terminal]);
      const errorChunks = chunks.filter((c) => c?.choices?.[0]?.delta?.content?.startsWith?.("[Error]"));
      expect(errorChunks).toHaveLength(1);
      // A terminal error must never produce a second finish chunk.
      expect(finishChunks(chunks).filter((f) => f !== "stop")).toHaveLength(0);
    }
  });

  it("does not emit a second terminal after an error terminal (exactly-once)", () => {
    const events = [
      { type: "error", error: { message: "boom" } },
      { type: "response.completed", response: { id: "resp_1", status: "completed" } },
    ];
    const chunks = runResponsesToChat(events);
    expect(chunks.filter((c) => c?.choices?.[0]?.finish_reason)).toHaveLength(1);
  });
});

// ── 2. Forced non-stream (convertResponsesStreamToJson) ──────────────────

describe("Forced non-stream (convertResponsesStreamToJson)", () => {
  it("returns status incomplete with partial args when the stream is truncated by max_output_tokens", async () => {
    const body = [
      sseFrame("response.created", { type: "response.created", response: { id: "resp_1", status: "in_progress" } }),
      sseFrame("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "Bash", arguments: "" } }),
      sseFrame("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_1", delta: '{"command":"git status","timeout":120000,"description":"status","run_in_background":false,"dangero' }),
      sseFrame("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "Bash", arguments: '{"command":"git status","timeout":120000,"description":"status","run_in_background":false,"dangero' } }),
      sseFrame("response.incomplete", { type: "response.incomplete", response: { id: "resp_1", status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }),
    ].join("");

    const json = await convertResponsesStreamToJson(sseStream(body));
    expect(json.status).toBe("incomplete");
    expect(json.incomplete_details?.reason).toBe("max_output_tokens");
    const tool = json.output.find((o) => o.type === "function_call");
    expect(tool.arguments).toContain('"dangero');
    expect(tool.arguments.endsWith("}")).toBe(false); // truncated mid-JSON
  });

  it("reconstructs complete tool args for terminal-only providers (response.completed with output)", async () => {
    const body = [
      sseFrame("response.created", { type: "response.created", response: { id: "resp_1", status: "in_progress" } }),
      sseFrame("response.completed", {
        type: "response.completed",
        response: {
          id: "resp_1",
          status: "completed",
          output: [
            { id: "fc_1", type: "function_call", call_id: "call_1", name: "Bash", arguments: SSE_ARGS },
          ],
        },
      }),
    ].join("");

    const json = await convertResponsesStreamToJson(sseStream(body));
    expect(json.status).toBe("completed");
    const tool = json.output.find((o) => o.type === "function_call");
    expect(tool.arguments).toBe(SSE_ARGS);
  });

  it("finalizes as failed when the stream closes without any terminal event", async () => {
    const body = [
      sseFrame("response.created", { type: "response.created", response: { id: "resp_1", status: "in_progress" } }),
      sseFrame("response.output_text.delta", { type: "response.output_text.delta", delta: "partial" }),
    ].join("");

    const json = await convertResponsesStreamToJson(sseStream(body));
    expect(json.status).toBe("failed");
    expect(json.error?.code).toBe("stream_disconnected");
  });
});

// ── 3. Responses → Responses passthrough ────────────────────────────────

describe("Responses → Responses passthrough (createSSEStream translate mode)", () => {
  it("forwards a full tool-call stream in order with a single [DONE] and no synthesized failed", async () => {
    const input = [
      sseFrame("response.created", { type: "response.created", response: { id: "resp_1", status: "in_progress" } }),
      sseFrame("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "Bash", arguments: "" } }),
      sseFrame("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_1", delta: SSE_ARGS }),
      sseFrame("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "Bash", arguments: SSE_ARGS } }),
      sseFrame("response.completed", { type: "response.completed", response: { id: "resp_1", status: "completed" } }),
      "data: [DONE]\n\n",
    ].join("");

    const out = await runPassthrough(input);
    const order = ["response.created", "response.output_item.added", "response.function_call_arguments.delta", "response.output_item.done", "response.completed"];
    let idx = -1;
    for (const ev of order) {
      const at = out.indexOf(`event: ${ev}`);
      expect(at).toBeGreaterThan(idx);
      idx = at;
    }
    expect(out.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(out).not.toContain("event: response.failed");
    // The forwarded delta re-serializes the JSON (escaped quotes) — parse it
    // back and verify the arguments string survives byte-for-byte.
    const deltaFrame = out.match(/event: response\.function_call_arguments\.delta\ndata: ([^\n]+)/);
    expect(JSON.parse(deltaFrame[1]).delta).toBe(SSE_ARGS);
  });

  it("forwards each terminal variant exactly once and still appends one [DONE]", async () => {
    for (const terminal of ["response.completed", "response.incomplete", "response.failed", "response.cancelled"]) {
      const input = [
        sseFrame(terminal, { type: terminal, response: { id: "resp_1", status: terminal.split(".")[1] } }),
        "data: [DONE]\n\n",
      ].join("");
      const out = await runPassthrough(input);
      expect(out.match(new RegExp(`event: ${terminal}`, "g"))).toHaveLength(1);
      expect(out.match(/data: \[DONE\]/g)).toHaveLength(1);
      // No duplicate synthesis: the terminal appears exactly once even for
      // response.failed itself (forwarded once, never re-synthesized).
    }
  });
});

// ── 4. Accumulator exactly-once terminal status ──────────────────────────

describe("ResponsesAccumulator terminal status", () => {
  it("never overwrites a terminal status with a later non-terminal event", () => {
    const acc = createResponsesAccumulator();
    acc.ingest("response.failed", { type: "response.failed", response: { id: "r", status: "failed", error: { message: "x" } } });
    acc.ingest("response.output_text.delta", { type: "response.output_text.delta", delta: "late" });
    expect(acc.status).toBe("failed");
    expect(acc.error?.message).toBe("x");
    finalizeResponsesAccumulator(acc);
    expect(acc.finalized).toBe(true);
  });
});
