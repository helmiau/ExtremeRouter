// Downstream streaming-contract forensic suite.
//
// Incident: internal accounting reported full success (recvLines=4, emitted=5,
// canonical classification=success) yet the client re-POSTed seconds later —
// the signature of a client that received 200 + valid SSE frames but no
// terminal sentinel.
//
// These tests read the FINAL downstream body (not internal transform output):
//   1. The exact 4-frame Antigravity incident stream is piped through the
//      production TransformStream (createSSETransformStreamWithLogger) and the
//      complete downstream body is collected and asserted.
//   2. The Combo ownership chain is proven byte-preserving: the streaming
//      candidate Response returned by handleComboChat (and re-wrapped by
//      wrapResponseWithAdmission, the same wrapper the route uses) must carry
//      the full translated body — never a stale/empty/replaced stream.
import { describe, it, expect } from "vitest";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";
import { createStreamState } from "../../open-sse/utils/streamState.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { handleComboChat } from "../../open-sse/services/combo.js";
import { acquireComboAdmission, wrapResponseWithAdmission, getComboAdmissionStats } from "../../src/sse/services/comboAdmission.js";

// The exact upstream shape from the incident: 4 Antigravity SSE data events
// (text deltas, a functionCall, then finishReason=STOP + usageMetadata),
// wrapped in the `response` envelope.
const INCIDENT_PROVIDER_FRAMES = [
  'data: {"response":{"responseId":"resp_1","modelVersion":"gemini-3.8-flash-high","candidates":[{"content":{"role":"model","parts":[{"text":"Working on it."}]},"index":0}]}}\n\n',
  'data: {"response":{"candidates":[{"content":{"parts":[{"text":" more"}]},"index":0}]}}\n\n',
  'data: {"response":{"candidates":[{"content":{"parts":[{"functionCall":{"name":"Bash","args":{"command":"echo hi"}}}]},"index":0}]}}\n\n',
  'data: {"response":{"candidates":[{"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":10,"totalTokenCount":110}}}\n\n',
];

function providerStream(frames) {
  return new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
}

async function drain(response) {
  return await response.text();
}

describe("Downstream SSE contract: Antigravity → OpenAI translate mode (final body)", () => {
  it("translated frames reach the final body in order and the stream terminates with data: [DONE]", async () => {
    const streamState = createStreamState();
    let completed = null;
    const transform = createSSETransformStreamWithLogger(
      FORMATS.ANTIGRAVITY,   // targetFormat (provider side)
      FORMATS.OPENAI,        // sourceFormat (client side) — /v1/chat/completions contract
      "antigravity",
      null,                  // reqLogger
      null,                  // toolNameMap
      "gemini-3.8-flash-high",
      "conn-test",
      { messages: [{ role: "user", content: "hi" }] },
      (...args) => { completed = args; },
      null,                  // apiKey
      null,                  // responsesAccumulator
      streamState,
    );

    const response = new Response(providerStream(INCIDENT_PROVIDER_FRAMES).pipeThrough(transform), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    // Q-K/L: contract headers
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    // Read the FINAL body the HTTP client would receive.
    const body = await drain(response);
    const frames = body.split("\n\n").filter((f) => f.startsWith("data: "));

    // A./B. Incident accounting: 4 provider events → 5 translated frames
    // (role + 2 content + tool_calls + finish/usage).
    expect(frames.length).toBeGreaterThanOrEqual(5);

    const parsed = frames
      .filter((f) => f !== "data: [DONE]")
      .map((f) => JSON.parse(f.slice(6)));
    // Role-opening chunk first (translator contract).
    expect(parsed[0].choices?.[0]?.delta?.role).toBe("assistant");
    // Text content preserved.
    const textDelta = parsed.find((c) => c.choices?.[0]?.delta?.content === "Working on it.");
    expect(textDelta).toBeTruthy();
    // Tool call serialized in OpenAI wire shape (Q-N).
    const toolDelta = parsed.find((c) => c.choices?.[0]?.delta?.tool_calls?.length > 0);
    expect(toolDelta).toBeTruthy();
    expect(toolDelta.choices[0].delta.tool_calls[0].function.name).toBe("Bash");
    expect(toolDelta.choices[0].delta.tool_calls[0].function.arguments).toContain("echo hi");
    // Terminal chunk: finish_reason + usage (Q-M preconditions). NOTE the two
    // layers: canonical finishReason=stop records the upstream Gemini "STOP",
    // while the CLIENT-facing OpenAI finish_reason is "tool_calls" because a
    // function call was emitted in this stream (openai wire semantics).
    const finish = parsed.find((c) => c.choices?.[0]?.finish_reason);
    expect(finish?.choices?.[0]?.finish_reason).toBe("tool_calls");
    expect(finish?.usage?.completion_tokens).toBeGreaterThan(0);

    // M. OpenAI-compatible streams MUST terminate with the [DONE] sentinel.
    //    Without it, strict OpenAI-compatible clients treat the stream as
    //    truncated and re-issue the request (the observed repeat POSTs).
    expect(body.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(body).not.toContain("reasoning_effort");

    // C. Every translated frame was actually written to the downstream body —
    //    nothing dropped between transform and HTTP boundary.
    expect(body).toContain("Working on it.");

    // Lifecycle: flush finalized the canonical attempt with success evidence.
    expect(completed).toBeTruthy();
    expect(streamState.eofSeen).toBe(true);
    expect(streamState.hasToolCall).toBe(true);
    expect(streamState.finishReason).toBe("stop");
  });
});

describe("Combo ownership: successful streaming candidate body is returned intact", () => {
  it("handleComboChat returns the live transformed stream (not a stale/empty body) and never advances to the next candidate", async () => {
    const enc = new TextEncoder();
    const servedFrames = [
      'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
      'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n',
      'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ];
    let secondCandidateTried = false;

    const handleSingleModel = async (_body, modelStr) => {
      if (modelStr === "first/stream") {
        // Mirror the streamingHandler admission shape: 2xx + text/event-stream,
        // success=true (candidateServed admits on this before body completion).
        return {
          success: true,
          response: new Response(
            new ReadableStream({
              start(c) { for (const f of servedFrames) c.enqueue(enc.encode(f)); c.close(); },
            }),
            { status: 200, headers: { "Content-Type": "text/event-stream" } },
          ),
        };
      }
      secondCandidateTried = true;
      return { success: false, status: 500, response: new Response("{}", { status: 500 }) };
    };

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["first/stream", "second/stream"],
      handleSingleModel,
      log: { info() {}, warn() {}, error() {} },
      comboName: "t",
      comboStrategy: "fallback",
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(secondCandidateTried).toBe(false); // progression stopped correctly

    // D/E/J: the returned Response.body IS the transformed stream — read to EOF.
    const body = await drain(res);
    expect(body).toContain('"delta":{"content":"ok"}');
    expect(body).toContain('"finish_reason":"stop"');
    expect(body.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  it("wrapResponseWithAdmission (route-level wrapper) preserves the body byte-for-byte and releases the lease at EOF", async () => {
    const before = getComboAdmissionStats().activeGlobal;
    const lease = acquireComboAdmission("forensic-test");
    expect(lease.ok).toBe(true);

    const enc = new TextEncoder();
    const inner = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'));
          c.enqueue(enc.encode("data: [DONE]\n\n"));
          c.close();
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );

    const wrapped = wrapResponseWithAdmission(inner, lease);
    expect(wrapped.status).toBe(200);
    expect(wrapped.headers.get("content-type")).toBe("text/event-stream");

    const body = await drain(wrapped);
    expect(body).toBe('data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n');
    expect(getComboAdmissionStats().activeGlobal).toBe(before); // lease released on close
  });
});
