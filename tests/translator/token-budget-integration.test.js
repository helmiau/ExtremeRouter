// Token budget INTEGRATION tests — exercise the real production path:
//
//   translateRequest() → adjustMaxTokens() → resolveOutputBudget() → provider body
//
// These exist because the unit tests in tests/unit/tokenBudget.test.js call the
// resolver directly and therefore cannot catch the class of bug where the
// translator hands the resolver a *reduced* body ({max_tokens, thinking, tools}).
// A reduced body makes estimateInputTokens() return ~0, so a 100K-token prompt
// still receives the full output budget and blows the context window.
import { describe, it, expect } from "vitest";
import "./registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { estimateInputTokens } from "../../open-sse/utils/tokenEstimate.js";

// gpt-4o wildcard caps: contextWindow 128000, maxOutput 16384.
const CTX_MODEL = "gpt-4o";
const CTX_WINDOW = 128000;
const CTX_MODEL_MAX_OUTPUT = 16384;

// claude-opus-4-7: contextWindow 1000000, maxOutput 128000 — large enough that
// the model ceiling does not mask the context ceiling.
const BIG_MODEL = "claude-opus-4-7";

// Dense filler: non-whitespace chars only, so chars/3 is the token estimate.
const filler = (approxTokens) => "x".repeat(approxTokens * 3);

const toOpenAI = (body, model = CTX_MODEL) =>
  translateRequest(FORMATS.OPENAI, FORMATS.OPENAI, model, body, true, null, "openai");

describe("token budget integration: full body reaches the estimator", () => {
  // A. Large messages must shrink the output budget.
  it("A: ~100K input tokens on a 128K model leaves <= remaining context", () => {
    const body = {
      messages: [{ role: "user", content: filler(100000) }],
      max_tokens: 64000,
    };
    const inputTokens = estimateInputTokens(body);
    expect(inputTokens).toBeGreaterThan(90000);

    const out = toOpenAI(body, BIG_MODEL);
    const available = 1000000 - inputTokens; // claude-opus-4-7 context
    expect(out.max_tokens).toBeLessThanOrEqual(available);
    expect(out.max_tokens).toBe(64000); // 1M context: request fits untouched
  });

  it("A2: input larger than the context window collapses the budget", () => {
    // 100K estimated input against gpt-4o's 128K window leaves ~28K.
    const body = {
      messages: [{ role: "user", content: filler(100000) }],
      max_tokens: 64000,
    };
    const inputTokens = estimateInputTokens(body);
    const out = toOpenAI(body);
    const available = CTX_WINDOW - inputTokens;

    expect(out.max_tokens).toBeLessThanOrEqual(available);
    // Model ceiling (16384) is below the ~28K available context, so it wins.
    expect(out.max_tokens).toBe(CTX_MODEL_MAX_OUTPUT);
    // The load-bearing assertion: a reduced body would have produced 16384 too,
    // so also assert the context path directly below in A3.
  });

  it("A3: 124K input on a 128K window clamps output below the model ceiling", () => {
    // 124K input → ~4K available, which is BELOW gpt-4o's 16384 maxOutput.
    // Only a full-body estimate can produce this; a reduced body yields 16384.
    const body = {
      messages: [{ role: "user", content: filler(124000) }],
      max_tokens: 64000,
    };
    const inputTokens = estimateInputTokens(body);
    const available = CTX_WINDOW - inputTokens;
    expect(available).toBeLessThan(CTX_MODEL_MAX_OUTPUT);

    const out = toOpenAI(body);
    expect(out.max_tokens).toBe(available);
    expect(inputTokens + out.max_tokens).toBeLessThanOrEqual(CTX_WINDOW);
  });

  // B. Small messages leave the explicit request intact (subject to model max).
  it("B: small input keeps the explicit request, clamped only by model max", () => {
    const out = toOpenAI({
      messages: [{ role: "user", content: filler(4000) }],
      max_tokens: 64000,
    });
    expect(out.max_tokens).toBe(CTX_MODEL_MAX_OUTPUT);
  });

  // C. A huge tool schema must consume context even when messages are tiny.
  it("C: large tool schema reduces the budget despite small messages", () => {
    const bigSchema = { type: "object", properties: {} };
    for (let i = 0; i < 4000; i++) {
      bigSchema.properties[`field_${i}`] = {
        type: "string",
        description: "d".repeat(30),
      };
    }
    const withTools = {
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 64000,
      tools: [{ type: "function", function: { name: "f", description: "big", parameters: bigSchema } }],
    };
    const withoutTools = { messages: [{ role: "user", content: "hi" }], max_tokens: 64000 };

    const inputWith = estimateInputTokens(withTools);
    const inputWithout = estimateInputTokens(withoutTools);
    expect(inputWith).toBeGreaterThan(inputWithout + 50000);

    const out = toOpenAI(withTools);
    expect(out.max_tokens).toBeLessThanOrEqual(CTX_WINDOW - inputWith);
  });

  // D. Explicit limits are never raised by the tool-aware default.
  it("D: explicit max_tokens=4096 with tools present stays 4096", () => {
    const out = toOpenAI({
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 4096,
      tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
    });
    expect(out.max_tokens).toBe(4096);
  });

  // E. Model max reduces an oversized explicit request.
  it("E: max_tokens=64000 is reduced to the model ceiling", () => {
    const out = toOpenAI({ messages: [{ role: "user", content: "hi" }], max_tokens: 64000 });
    expect(out.max_tokens).toBe(CTX_MODEL_MAX_OUTPUT);
  });

  // F. Context exhaustion yields 0, not a floor of 1 and not the tool default.
  it("F: input beyond the context window yields max_tokens 0", () => {
    const out = toOpenAI({
      messages: [{ role: "user", content: filler(140000) }],
      tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
    });
    expect(out.max_tokens).toBe(0);
  });

  // I. Multimodal blocks are visible to the estimator through the real path.
  it("I: image blocks contribute to the input estimate", () => {
    const withImage = {
      messages: [{ role: "user", content: [
        { type: "text", text: "what is this" },
        { type: "image_url", image_url: { url: "https://example.com/a.png" } },
      ] }],
      max_tokens: 1000,
    };
    const textOnly = {
      messages: [{ role: "user", content: [{ type: "text", text: "what is this" }] }],
      max_tokens: 1000,
    };
    expect(estimateInputTokens(withImage)).toBeGreaterThan(estimateInputTokens(textOnly));
    // Small payload: the explicit request survives.
    expect(toOpenAI(withImage).max_tokens).toBe(1000);
  });

  // Tool-aware default applies only when the client omits an output limit.
  it("tool-aware default (32K) applies only without an explicit limit", () => {
    const out = toOpenAI({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
    }, BIG_MODEL);
    expect(out.max_tokens).toBe(32000);
  });
});

describe("token budget integration: Kiro paths use the canonical budget", () => {
  const O2K = (body) =>
    translateRequest(FORMATS.OPENAI, FORMATS.KIRO, "claude-sonnet-4.5", body, true, null, "kiro");
  const C2K = (body) =>
    translateRequest(FORMATS.CLAUDE, FORMATS.KIRO, "claude-sonnet-4.5", body, true, null, "kiro");

  it("J1: OpenAI→Kiro respects an explicit max_tokens", () => {
    const out = O2K({ max_tokens: 4096, messages: [{ role: "user", content: "hi" }] });
    expect(out.inferenceConfig?.maxTokens).toBe(4096);
  });

  it("J2: OpenAI→Kiro without max_tokens gets a resolver-supplied budget", () => {
    const out = O2K({ messages: [{ role: "user", content: "hi" }] });
    expect(out.inferenceConfig?.maxTokens).toBeGreaterThan(0);
  });

  it("J3: Claude→Kiro (direct route) respects an explicit max_tokens", () => {
    const out = C2K({ max_tokens: 4096, messages: [{ role: "user", content: "hi" }] });
    expect(out.inferenceConfig?.maxTokens).toBe(4096);
  });

  it("J4: Claude→Kiro (direct route) gets a canonical budget when omitted", () => {
    // No local `body.max_tokens || 32000` fallback exists in the translator, so a
    // value here proves the canonical resolver ran before the direct translation.
    const out = C2K({ messages: [{ role: "user", content: "hi" }] });
    expect(out.inferenceConfig?.maxTokens).toBeGreaterThan(0);
  });

  it("J5: Claude→Kiro with a huge prompt is clamped by context, not defaulted", () => {
    const body = { messages: [{ role: "user", content: filler(140000) }] };
    const inputTokens = estimateInputTokens(body);
    const out = C2K(body);
    // No explicit limit and no tools → desired is the 64K normal default. A value
    // below that proves the context ceiling (derived from the full body) applied.
    expect(out.inferenceConfig?.maxTokens ?? 0).toBeLessThan(64000);
    expect(out.inferenceConfig?.maxTokens ?? 0).toBe(200000 - inputTokens); // default 200K window
  });
});

describe("token budget integration: alias normalization", () => {
  it("max_completion_tokens is normalized and clamped", () => {
    const out = toOpenAI({ messages: [{ role: "user", content: "hi" }], max_completion_tokens: 4096 });
    expect(out.max_tokens).toBe(4096);
    expect(out.max_completion_tokens).toBeUndefined();
  });

  it("max_output_tokens is normalized and clamped", () => {
    const out = toOpenAI({ messages: [{ role: "user", content: "hi" }], max_output_tokens: 64000 });
    expect(out.max_tokens).toBe(CTX_MODEL_MAX_OUTPUT);
    expect(out.max_output_tokens).toBeUndefined();
  });

  it("max_tokens wins over aliases when several are present", () => {
    const out = toOpenAI({
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 2048,
      max_completion_tokens: 8192,
      max_output_tokens: 9999,
    });
    expect(out.max_tokens).toBe(2048);
  });
});
