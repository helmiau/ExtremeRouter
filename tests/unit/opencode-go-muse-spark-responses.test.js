// ocg/muse-spark-1.3-contributor — responses-only routing through the Go lane.
//
// Port of decolua/9router commit e74db4d (muse-spark-1.3-contributor on
// OpenCode Go): the family is served by /zen/go/v1/responses ONLY, so the
// registry entry is responses-only, getModelTargetFormat guards the muse
// family on the oc/ocg aliases, and OpenCodeGoExecutor routes + normalizes
// the Responses body (tool coercions, caps mapping, stream/store).
import { describe, expect, it } from "vitest";
import { PROVIDER_MODELS, getModelTargetFormat } from "../../open-sse/config/providerModels.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { resolveTransport } from "../../open-sse/services/provider.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { OpenCodeGoExecutor } from "../../open-sse/executors/opencode-go.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { translateRequest } from "../../open-sse/translator/index.js";

const MODEL = "muse-spark-1.3-contributor";
const PROVIDER = "opencode-go";

// Mirror of chatCore's per-model targetFormat precedence:
//   getModelTargetFormat(alias, model) || resolveTransport(provider, sourceFormat)?.format
function pickTargetFormat(provider, sourceFormat, alias, model) {
  return getModelTargetFormat(alias, model) || resolveTransport(provider, sourceFormat)?.format || null;
}

describe("ocg/muse-spark-1.3-contributor catalog", () => {
  it("is registered responses-only", () => {
    const entry = (PROVIDER_MODELS["opencode-go"] || []).find((m) => m.id === MODEL);
    expect(entry).toBeDefined();
    expect(entry.targetFormat).toBe("openai-responses");
    expect(getModelTargetFormat("ocg", MODEL)).toBe(FORMATS.OPENAI_RESPONSES);
    expect(getModelTargetFormat("opencode-go", MODEL)).toBe(FORMATS.OPENAI_RESPONSES);
  });

  it("never takes the sourceFormat-matched transport (always translates)", () => {
    // chatCore precedence: the per-model targetFormat beats the runtime
    // transport for BOTH chat and claude sources — muse never rides
    // /chat/completions or /messages on the Go lane.
    expect(pickTargetFormat(PROVIDER, "openai", "opencode-go", MODEL)).toBe(FORMATS.OPENAI_RESPONSES);
    expect(pickTargetFormat(PROVIDER, "claude", "opencode-go", MODEL)).toBe(FORMATS.OPENAI_RESPONSES);
    expect(pickTargetFormat(PROVIDER, "openai-responses", "opencode-go", MODEL)).toBe(FORMATS.OPENAI_RESPONSES);
    // And the muse guard does not leak onto other providers' muse ids
    // (muse-spark-web is a cookie bridge that speaks chat only).
    expect(getModelTargetFormat("meta-ai", "muse-spark-1.3-contributor")).toBeNull();
  });

  it("advertises reasoning via the shared muse-spark pattern", () => {
    expect(getCapabilitiesForModel(PROVIDER, MODEL)).toMatchObject({
      vision: true,
      reasoning: true,
      thinkingFormat: "openai",
    });
    expect(getThinkingLevels(PROVIDER, MODEL)).toContain("xhigh");
  });
});

describe("OpenCodeGoExecutor routing + sanitization", () => {
  it("is wired for opencode-go and routes muse-spark to /responses", () => {
    expect(getExecutor("opencode-go")).toBeInstanceOf(OpenCodeGoExecutor);
    const ex = new OpenCodeGoExecutor();
    expect(ex.buildUrl(MODEL)).toBe("https://opencode.ai/zen/go/v1/responses");
    // Thinking suffix does not derail routing.
    expect(ex.buildUrl(`${MODEL}(high)`)).toBe("https://opencode.ai/zen/go/v1/responses");
  });

  it("leaves non-muse models on the default chat/messages transport", () => {
    const ex = new OpenCodeGoExecutor();
    expect(ex.buildUrl("kimi-k2.6")).toBe("https://opencode.ai/zen/go/v1/chat/completions");
    expect(ex.buildUrl("minimax-m3")).toBe("https://opencode.ai/zen/go/v1/messages");
  });

  it("normalizes caps + reasoning and coerces tool items exactly once", () => {
    const ex = new OpenCodeGoExecutor();
    const args = { path: "a\"b\nc\\d", emoji: "🚀 ü", nested: { q: "x'y\"z" } };
    const body = {
      model: MODEL,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "function_call", call_id: "x".repeat(100), name: "read", arguments: args },
        { type: "function_call", call_id: "bad", name: "   ", arguments: "{}" },
        { type: "function_call", call_id: "frag", name: "exec", arguments: "{not json" },
        { type: "function_call_output", call_id: "c1", output: { ok: true, text: "héllo \"w\"" } },
        { type: "function_call_output", call_id: "c2", output: null },
      ],
      tools: [
        { type: "function", function: { name: "read", description: "r", parameters: { type: "object", properties: {} } } },
        { type: "function", function: { name: "  ", parameters: {} } },
      ],
      max_tokens: 2048,
      reasoning_effort: "high",
    };
    const out = ex.transformRequest(MODEL, body, true, {});
    expect(out.max_output_tokens).toBe(2048);
    expect(out.max_tokens).toBeUndefined();
    expect(out.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(out.stream).toBe(true);
    expect(out.store).toBe(false);
    // nameless declaration dropped, nameless call dropped
    expect(out.tools.map((t) => t.name)).toEqual(["read"]);
    const calls = out.input.filter((i) => i.type === "function_call");
    expect(calls.map((c) => c.name)).toEqual(["read", "exec"]);
    // overlong id clamped, object args stringified exactly once
    expect(calls[0].call_id).toHaveLength(64);
    expect(JSON.parse(calls[0].arguments)).toEqual(args);
    // invalid fragment coerced, never double-encoded
    expect(calls[1].arguments).toBe("{}");
    const outputs = out.input.filter((i) => i.type === "function_call_output");
    expect(JSON.parse(outputs[0].output)).toEqual({ ok: true, text: "héllo \"w\"" });
    expect(outputs[1].output).toBe("");
  });
});

describe("chat/claude clients translate to Responses without breaking tools", () => {
  const tricky = { cmd: "echo \"hi\"\nnewline\ttab\\slash", emoji: "🎉 café naïve", nested: { a: [1, "x'y"] } };

  it("openai chat → responses keeps arguments parseable", () => {
    const translated = translateRequest(
      FORMATS.OPENAI,
      FORMATS.OPENAI_RESPONSES,
      MODEL,
      {
        model: `ocg/${MODEL}`,
        messages: [
          { role: "system", content: [{ type: "text", text: "sys one" }, { type: "text", text: "sys two" }] },
          { role: "user", content: "run it" },
          {
            role: "assistant", content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "exec", arguments: tricky } }],
          },
          { role: "tool", tool_call_id: "call_1", content: tricky },
        ],
        tools: [{ type: "function", function: { name: "exec", description: "e", parameters: { type: "object", properties: {} } } }],
      },
      true, {}, PROVIDER,
    );
    expect(translated.instructions).toBe("sys one\nsys two");
    const fc = translated.input.find((i) => i.type === "function_call");
    expect(JSON.parse(fc.arguments)).toEqual(tricky);
    const fco = translated.input.find((i) => i.type === "function_call_output");
    expect(JSON.parse(fco.output)).toEqual(tricky);
  });

  it("claude messages → responses double-hop keeps tool input intact", () => {
    const viaOpenAI = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI, MODEL, {
      system: "be terse",
      messages: [
        { role: "user", content: [{ type: "text", text: "go" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "calling" },
            { type: "tool_use", id: "tu_1", name: "exec", input: tricky },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: JSON.stringify(tricky) }] }],
        },
      ],
      tools: [{ name: "exec", description: "e", input_schema: { type: "object", properties: {} } }],
    }, true, {}, PROVIDER);
    const translated = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, MODEL, viaOpenAI, true, {}, PROVIDER);
    const fc = translated.input.find((i) => i.type === "function_call");
    expect(JSON.parse(fc.arguments)).toEqual(tricky);
    const fco = translated.input.find((i) => i.type === "function_call_output");
    expect(JSON.parse(fco.output)).toEqual(tricky);
  });
});
