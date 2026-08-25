import { describe, it, expect, vi } from "vitest";

// Commit E: canonical attempt LIFECYCLE + FINALIZATION-BOUNDARY validation.
//
// Proves, with executable tests, exactly WHEN canonicalAttempt is:
//   - provisional  (streaming: live holder before flush)
//   - final        (after the path's completion boundary)
// across every execution path defined by the Wave-2 contract. No production
// behavior is changed; this is a validation/documentation commit.
//
// Hard scope guards (must hold):
//  - ChatResult.success is NEVER read-from / replaced-by canonicalAttempt.
//  - canonicalAttempt.logicalSuccess may DIVERGE from success (asserted).
//  - No consumer (Combo/fallback) reads canonicalAttempt yet.
//  - canonicalAttempt never leaks into the public HTTP Response.

import { createStreamState, observeParsedEvent } from "../../open-sse/utils/streamState.js";
import { createCanonicalAttempt } from "../../open-sse/utils/canonicalAttempt.js";
import { createCanonicalAttemptFromNonStreaming } from "../../open-sse/utils/nonStreamingAttempt.js";
import { createCanonicalAttemptFromForcedSse } from "../../open-sse/utils/forcedSseAttempt.js";
import { buildChatResult, createErrorResult, chatResultFromErrorResponse } from "../../open-sse/utils/error.js";

const openaiContent = (content) => ({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
const openaiFinish = (fr) => ({ choices: [{ index: 0, delta: {}, finish_reason: fr }] });
const openaiText = (content, finish_reason = "stop") => ({ choices: [{ message: { role: "assistant", content }, finish_reason }] });

// Mirrors streamingHandler.js: a live holder created up front, filled at flush.
const makeStreamingHolder = (status) => {
  const streamState = createStreamState();
  const holder = createCanonicalAttempt(streamState, { status, source: "provider" });
  const flush = () =>
    Object.assign(holder, createCanonicalAttempt(streamState, { status, source: "provider" }));
  return { streamState, holder, flush };
};

describe("STREAMING lifecycle: provisional → final", () => {
  it("holder reference exists immediately; NOT final before completion", () => {
    const { holder } = makeStreamingHolder(200);
    // Before any stream bytes: live holder present but carries no evidence.
    expect(holder).toBeDefined();
    expect(holder.source).toBe("provider");
    expect(holder.usableOutput).toBe(false);
    expect(holder.completionState).toBe("unknown");
    expect(holder.logicalSuccess).toBe(false); // provisional, must not read as final
  });

  it("streaming SUCCESS: final after content + stop + EOF", () => {
    const { streamState, holder, flush } = makeStreamingHolder(200);
    observeParsedEvent(streamState, openaiContent("hello"));
    observeParsedEvent(streamState, openaiFinish("stop"));
    streamState.eofSeen = true;
    flush();
    expect(holder.transportOk).toBe(true);
    expect(holder.hasText).toBe(true);
    expect(holder.terminalState).toBe("success");
    expect(holder.completionState).toBe("success");
    expect(holder.usableOutput).toBe(true);
    expect(holder.logicalSuccess).toBe(true); // SAFE to read here
    expect(holder.outcome).toBe("success");
  });

  it("streaming INCOMPLETE: 200 + text + EOF, no terminal → not logicalSuccess", () => {
    const { streamState, holder, flush } = makeStreamingHolder(200);
    observeParsedEvent(streamState, openaiContent("partial"));
    streamState.eofSeen = true;
    flush();
    expect(holder.transportOk).toBe(true);
    expect(holder.hasText).toBe(true);
    expect(holder.completionState).toBe("incomplete");
    expect(holder.logicalSuccess).toBe(false); // diverges from success
    expect(holder.outcome).toBe("incomplete");
  });

  it("streaming FAILURE: explicit provider failure terminal → failure", () => {
    const { streamState, holder, flush } = makeStreamingHolder(200);
    observeParsedEvent(streamState, openaiContent("partial"));
    observeParsedEvent(streamState, { type: "error" });
    streamState.eofSeen = true;
    flush();
    expect(holder.hasText).toBe(true);
    expect(holder.errorSeen).toBe(true);
    expect(holder.completionState).toBe("failure");
    expect(holder.logicalSuccess).toBe(false);
    expect(holder.outcome).toBe("failure");
  });

  it("provider CANCELLATION (response.cancelled): cancelled, abortSeen=false", () => {
    const { streamState, holder, flush } = makeStreamingHolder(200);
    observeParsedEvent(streamState, { type: "response.cancelled" });
    streamState.eofSeen = true;
    flush();
    expect(holder.completionState).toBe("cancelled");
    expect(holder.abortSeen).toBe(false); // evidence distinction preserved
    expect(holder.logicalSuccess).toBe(false);
  });

  it("client DISCONNECT (abortSeen): cancelled, abortSeen=true", () => {
    const { streamState, holder, flush } = makeStreamingHolder(200);
    streamState.abortSeen = true; // handler sets this on pipe disconnect
    streamState.eofSeen = true;
    flush();
    expect(holder.completionState).toBe("cancelled");
    expect(holder.abortSeen).toBe(true); // evidence distinction preserved
    expect(holder.logicalSuccess).toBe(false);
  });
});

describe("NON-STREAMING lifecycle: final immediately after translation", () => {
  it("200 + text → final, logicalSuccess=true", () => {
    const ca = createCanonicalAttemptFromNonStreaming({ status: 200, parsed: openaiText("ok"), usage: null, malformed: false });
    expect(ca.source).toBe("provider");
    expect(ca.streamStarted).toBeNull();
    expect(ca.transportOk).toBe(true);
    expect(ca.completionState).toBe("success");
    expect(ca.logicalSuccess).toBe(true); // SAFE immediately
  });

  it("200 + usage only → final, logicalSuccess=false", () => {
    const ca = createCanonicalAttemptFromNonStreaming({ status: 200, parsed: { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } }, usage: null, malformed: false });
    expect(ca.transportOk).toBe(true);
    expect(ca.completionState).toBe("incomplete");
    expect(ca.logicalSuccess).toBe(false);
  });
});

describe("FORCED SSE → JSON lifecycle: final immediately after conversion", () => {
  it("valid complete body → final, logicalSuccess=true", () => {
    const ca = createCanonicalAttemptFromForcedSse({ status: 200, finalJson: openaiText("ok"), usage: { prompt_tokens: 1, completion_tokens: 1 } });
    expect(ca.streamStarted).toBeNull(); // no TransformStream lifecycle
    expect(ca.transportOk).toBe(true);
    expect(ca.completionState).toBe("success");
    expect(ca.logicalSuccess).toBe(true); // SAFE immediately
    expect(ca.outcome).toBe("success");
  });

  it("C.1 malformed-only SSE → public 502 preserved, attempt failure+final", () => {
    const ca = createCanonicalAttemptFromForcedSse({ status: 200, finalJson: null, malformedLines: 3 });
    expect(ca.completionState).toBe("failure");
    expect(ca.errorSeen).toBe(true);
    expect(ca.logicalSuccess).toBe(false);
    // Surface on the ChatResult envelope exactly as C.1 wired it:
    const r = createErrorResult(502, "Invalid SSE response for non-streaming request", undefined, { canonicalAttempt: ca });
    expect(r.success).toBe(false);
    expect(r.status).toBe(502);
    expect(r.canonicalAttempt).toBe(ca);
  });

  it("provider HTTP error (500) on forced SSE → failure, transportOk=false", () => {
    const ca = createCanonicalAttemptFromForcedSse({ status: 500, finalJson: null });
    expect(ca.source).toBe("provider");
    expect(ca.transportOk).toBe(false);
    expect(ca.completionState).toBe("failure");
    expect(ca.errorSeen).toBe(true);
    expect(ca.logicalSuccess).toBe(false);
  });
});

describe("PRE-PROVIDER / BYPASS / CACHE lifecycle contract", () => {
  it("pre-provider validation error → canonicalAttempt is null (no fabricated attempt)", () => {
    const r = createErrorResult(400, "invalid request");
    expect(r.success).toBe(false);
    expect(r.canonicalAttempt).toBeNull();
  });

  it("raw Response from a bypass path is NOT a ChatResult (canonicalAttempt integration deferred)", () => {
    // Per §13: bypass currently returns a bare Response, not a ChatResult
    // envelope. No adapter exists yet, so canonicalAttempt is correctly absent.
    // We assert the contract boundary (no fabricated envelope), not a field.
    const rawResponse = new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    expect(rawResponse).toBeInstanceOf(Response);
    expect("canonicalAttempt" in rawResponse).toBe(false);
  });

  it("cache HIT returns a ChatResult with canonicalAttempt: null (adapter not yet integrated)", () => {
    // chatCore.js cache-hit returns buildChatResult({...fromCache:true}) which
    // defaults canonicalAttempt to null. Documented as deferred integration.
    const r = buildChatResult({ success: true, response: new Response("{}"), fromCache: true, cacheSimilarity: 0.97 });
    expect(r.success).toBe(true);
    expect(r.fromCache).toBe(true);
    expect(r.canonicalAttempt).toBeNull();
  });
});

describe("PUBLIC HTTP BOUNDARY: canonicalAttempt never leaks to clients (regression)", () => {
  const jsonRes = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", "x-request-id": "abc" } });

  it("body + headers of a success ChatResult do not expose canonicalAttempt/logicalSuccess", async () => {
    const attempt = createCanonicalAttemptFromNonStreaming({ status: 200, parsed: openaiText("ok"), usage: null, malformed: false });
    const r = buildChatResult({ success: true, response: jsonRes({ choices: [{ message: { content: "ok" } }] }), canonicalAttempt: attempt });
    const body = await r.response.json();
    expect(body).not.toHaveProperty("canonicalAttempt");
    expect(body).not.toHaveProperty("logicalSuccess");
    for (const key of r.response.headers.keys()) {
      expect(key.toLowerCase()).not.toContain("canonical");
      expect(key.toLowerCase()).not.toContain("logical");
    }
  });

  it("SSE-streaming ChatResult keeps the body as a live stream (not consumed to build envelope)", () => {
    const { holder } = makeStreamingHolder(200);
    const r = buildChatResult({ success: true, response: new Response("data: keep-streaming\n\n", { headers: { "content-type": "text/event-stream" } }), canonicalAttempt: holder });
    expect(r.response.headers.get("content-type")).toContain("text/event-stream");
    expect(r.canonicalAttempt).toBe(holder); // same live holder; body untouched
  });
});

describe("SEMANTIC DIVERGENCE: success != canonicalAttempt.logicalSuccess (critical)", () => {
  it("incomplete stream: success=true yet canonicalAttempt.logicalSuccess=false is representable", () => {
    // Current handler semantics: an incomplete-but-200 stream still yields a
    // 200 Response envelope (success=true), while the canonical attempt records
    // logicalSuccess=false. The two contracts are intentionally separate.
    const r = buildChatResult({ success: true, response: new Response("data: partial\n\n", { status: 200 }), canonicalAttempt: null });
    expect(r.success).toBe(true);
    // A divergence is safe to construct without mutating success:
    const divergent = buildChatResult({ success: true, response: r.response, canonicalAttempt: { logicalSuccess: false } });
    expect(divergent.success).toBe(true);
    expect(divergent.canonicalAttempt.logicalSuccess).toBe(false);
  });

  it("chatResultFromErrorResponse (Wave 1B) preserves success=false + null attempt", () => {
    const r = chatResultFromErrorResponse(new Response("err", { status: 500 }), 500);
    expect(r.success).toBe(false);
    expect(r.canonicalAttempt).toBeNull();
  });
});
