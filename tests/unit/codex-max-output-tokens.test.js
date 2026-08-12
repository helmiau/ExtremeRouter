/**
 * Codex executor: max_output_tokens handling.
 *
 * The ChatGPT Codex backend silently truncates model output at its default
 * output cap when the request carries no max_output_tokens. For heavy-reasoning
 * models (gpt-5.6-luna / gpt-5.6-terra) the truncation lands mid-tool-call and
 * the Codex CLI fails with "Bash was called with input that could not be parsed
 * as JSON" — the exact class of failure documented in openai/codex#36180.
 *
 * Covers:
 *  - injecting a model-aware max_output_tokens when the client sends none
 *  - forwarding the client's max_output_tokens when present
 *  - still stripping chat-only max_tokens / max_completion_tokens
 *  - retrying once WITHOUT max_output_tokens when the upstream 400s on it
 *    (defensive: preserves behavior for backends that reject the field)
 *  - not retrying on unrelated 400s
 */

import { describe, expect, it, vi, afterEach } from "vitest";

import { CodexExecutor } from "../../open-sse/executors/codex.js";
import * as proxyFetchModule from "../../open-sse/utils/proxyFetch.js";

function makeBody(extra = {}) {
  return {
    model: "gpt-5.6-luna",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    stream: true,
    ...extra,
  };
}

function transformFor(model, extra = {}) {
  const executor = new CodexExecutor();
  const body = makeBody(extra);
  executor.transformRequest(model, body, true, {
    connectionId: "test-codex-max-output",
    providerSpecificData: {},
  });
  return body;
}

describe("CodexExecutor max_output_tokens injection", () => {
  it("injects a model-aware default when the client sends none (gpt-5.6 family)", () => {
    const body = transformFor("gpt-5.6-luna");
    expect(body.max_output_tokens).toBe(128000);
  });

  it("injects the same default for terra and sol", () => {
    expect(transformFor("gpt-5.6-terra").max_output_tokens).toBe(128000);
    expect(transformFor("gpt-5.6-sol").max_output_tokens).toBe(128000);
  });

  it("falls back to the capability floor for models without explicit metadata", () => {
    // "gpt-5.6-luna" resolves via PROVIDER_CAPABILITIES (128000); an unknown
    // model gets the DEFAULT_CAPABILITIES.maxOutput floor (64000) — still far
    // above the backend's small default cap, so no silent truncation.
    const body = transformFor("some-unknown-model");
    expect(body.max_output_tokens).toBe(64000);
  });

  it("forwards the client-sent max_output_tokens instead of overriding it", () => {
    const body = transformFor("gpt-5.6-luna", { max_output_tokens: 8192 });
    expect(body.max_output_tokens).toBe(8192);
  });

  it("still strips chat-only max_tokens and max_completion_tokens", () => {
    const body = transformFor("gpt-5.6-luna", { max_tokens: 100, max_completion_tokens: 200 });
    expect(body.max_tokens).toBeUndefined();
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.max_output_tokens).toBe(128000);
  });
});

describe("CodexExecutor 400 fallback for max_output_tokens", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockCodexFetch(sequence) {
    const sentBodies = [];
    let call = 0;
    vi.spyOn(proxyFetchModule, "proxyAwareFetch").mockImplementation(async (url, init) => {
      sentBodies.push(init.body);
      const step = sequence[Math.min(call++, sequence.length - 1)];
      return step(sentBodies[sentBodies.length - 1]);
    });
    return sentBodies;
  }

  const okSSE = () => new Response(
    'data: {"type":"response.completed","response":{"id":"resp_test","status":"completed"}}\n\ndata: [DONE]\n\n',
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

  it("retries without max_output_tokens when the upstream 400s on it", async () => {
    const sentBodies = mockCodexFetch([
      () => new Response(
        JSON.stringify({ error: { message: "unsupported parameter: max_output_tokens" } }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
      () => okSSE(),
    ]);

    const executor = new CodexExecutor();
    const result = await executor.execute({
      model: "gpt-5.6-luna",
      body: makeBody(),
      stream: true,
      credentials: { accessToken: "test" },
    });

    expect(result.response.status).toBe(200);
    expect(sentBodies).toHaveLength(2);

    const first = JSON.parse(sentBodies[0]);
    const second = JSON.parse(sentBodies[1]);
    expect(first.max_output_tokens).toBe(128000);
    expect(second.max_output_tokens).toBeUndefined();
  });

  it("does not retry on a 400 that does not reference max_output_tokens", async () => {
    const sentBodies = mockCodexFetch([
      () => new Response(
        JSON.stringify({ error: { message: "rate limited" } }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
      () => okSSE(),
    ]);

    const executor = new CodexExecutor();
    const result = await executor.execute({
      model: "gpt-5.6-luna",
      body: makeBody(),
      stream: true,
      credentials: { accessToken: "test" },
    });

    expect(result.response.status).toBe(400);
    expect(sentBodies).toHaveLength(1);
  });

  it("does not leak suppression state into a later request", async () => {
    const sentBodies = mockCodexFetch([
      () => new Response(
        JSON.stringify({ error: { message: "unsupported parameter: max_output_tokens" } }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
      () => okSSE(),
      () => okSSE(),
    ]);

    const executor = new CodexExecutor();

    const first = await executor.execute({
      model: "gpt-5.6-luna",
      body: makeBody(),
      stream: true,
      credentials: { accessToken: "test" },
    });
    expect(first.response.status).toBe(200);

    const second = await executor.execute({
      model: "gpt-5.6-luna",
      body: makeBody(),
      stream: true,
      credentials: { accessToken: "test" },
    });
    expect(second.response.status).toBe(200);

    expect(sentBodies).toHaveLength(3);
    expect(JSON.parse(sentBodies[0]).max_output_tokens).toBe(128000);
    expect(JSON.parse(sentBodies[1]).max_output_tokens).toBeUndefined();
    // Third request is a fresh execute() — the field must be injected again.
    expect(JSON.parse(sentBodies[2]).max_output_tokens).toBe(128000);
  });
});
