import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// End-to-end contextWindow/maxOutput audit regressions (§27/§28):
// limit resolution matrix, field-name compatibility, canonical max_*
// precedence, and per-candidate fallback recomputation.

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));
vi.mock("@/shared/utils/ssrfGuard.js", () => ({ assertPublicUrl: vi.fn() }));

const { getCapabilitiesForModel, setCatalogSource } = await import("open-sse/providers/capabilities.js");
const { getRegistryLimits } = await import("open-sse/providers/registryLimits.js");
const { translateRequest } = await import("open-sse/translator/index.js");
const { FORMATS } = await import("open-sse/translator/formats.js");

beforeEach(() => setCatalogSource(null));
afterEach(() => setCatalogSource(null));

// ── Registry field-name compatibility (real bug: contextLength/maxOutputTokens were unread) ──

describe("registryLimits field-name compatibility", () => {
  it("reads contextLength/maxOutputTokens spellings (kiro)", () => {
    const limits = getRegistryLimits("kiro", "claude-haiku-4.5");
    expect(limits).toEqual({ contextWindow: 200000, maxOutput: 128000 });
  });

  it("still reads the canonical contextWindow/maxOutput spellings (github)", () => {
    const limits = getRegistryLimits("github", "claude-sonnet-4.6");
    expect(limits).toEqual({ contextWindow: 1000000, maxOutput: 64000 });
  });

  it("kiro/claude-haiku-4.5 output limit reaches the resolver (was floor 64000)", () => {
    const caps = getCapabilitiesForModel("kiro", "claude-haiku-4.5");
    expect(caps.maxOutput).toBe(128000);
    expect(caps.contextWindow).toBe(200000);
    expect(caps.sourceType).toBe("provider-registry");
  });

  it("theoldllm context limits resolve (contextLength-only registry)", () => {
    const caps = getCapabilitiesForModel("theoldllm", "GPT_5_4");
    expect(caps.contextWindow).toBe(400000);
    expect(caps.sourceType).toBe("provider-registry");
  });
});

// ── §27 limit resolution matrix (real project metadata) ──────────────────────

describe("limit resolution matrix", () => {
  const matrix = [
    // [provider, model, expectedContext, expectedMaxOutput, sourceType fragment]
    ["github", "claude-sonnet-4.6", 1000000, 64000, "provider-registry"],   // registry ctx/maxOutput
    ["kiro", "claude-sonnet-4.5", 1000000, 128000, "provider-registry"],    // registry contextLength/maxOutputTokens
    ["kiro", "claude-haiku-4.5", 200000, 128000, "provider-registry"],      // provider-specific output
    ["opencode", "muse-spark-1.2-contributor-free", 1048576, 131072, "provider-model"], // tier-1 explicit
    ["opencode-zen", "gemini-3-pro", 1048576, 65535, "family-pattern"],     // gemini family pattern (no manual limits)
  ];

  it.each(matrix)("%s/%s → ctx %i, out %i (%s)", (prov, model, ctx, out, src) => {
    const caps = getCapabilitiesForModel(prov, model);
    expect(caps.contextWindow).toBe(ctx);
    expect(caps.maxOutput).toBe(out);
    expect(caps.sourceType).toBe(src);
  });

  it("same canonical model through different providers keeps provider-specific limits", () => {
    // claude-sonnet-4.5: kiro serves 1M/128K (contextLength registry);
    // another gateway's claude-sonnet-4.5 falls to the gemini/claude family
    // pattern tier — never kiro's provider-scoped values.
    const kiro = getCapabilitiesForModel("kiro", "claude-sonnet-4.5");
    const other = getCapabilitiesForModel("some-other-gateway", "claude-sonnet-4.5");
    expect(kiro.contextWindow).toBe(1000000);
    expect(kiro.maxOutput).toBe(128000);
    expect(kiro.sourceType).toBe("provider-registry");
    expect(other.sourceType).toBe("family-pattern");
    expect(other.contextWindow).not.toBe(1000000);
  });

  it("manual registry limit beats catalog limit (precedence Scenario C)", () => {
    // kiro/claude-sonnet-4.5 has a manual registry limit of 1M; a catalog that
    // claims 8M must not override it. The registry tier wins over catalog.
    setCatalogSource({
      getModalities: () => null,
      getLimits: (prov, model) => (prov === "kiro" && model === "claude-sonnet-4.5"
        ? { contextWindow: 8000000, maxOutput: 999999 }
        : null),
    });
    const caps = getCapabilitiesForModel("kiro", "claude-sonnet-4.5");
    expect(caps.contextWindow).toBe(1000000);
    expect(caps.maxOutput).toBe(128000);
    expect(caps.sourceType).toBe("provider-registry");
  });

  it("Scenario D: manual absent + catalog present → catalog supplies limits", () => {
    // A floor-tier model (no manual entry, no family pattern) has no explicit
    // limit keys — the catalog supplies both limits (sourceType dynamic-catalog).
    setCatalogSource({
      getModalities: () => null,
      getLimits: (prov, model) => (prov === "opencode-zen" && model === "totally-uncatalogued-model"
        ? { contextWindow: 1048576, maxOutput: 200000 }
        : null),
    });
    const caps = getCapabilitiesForModel("opencode-zen", "totally-uncatalogued-model");
    expect(caps.contextWindow).toBe(1048576);
    expect(caps.maxOutput).toBe(200000);
    expect(caps.sourceType).toBe("dynamic-catalog");
  });

  it("Scenario E: catalog unavailable → local behavior preserved", () => {
    setCatalogSource(null);
    const caps = getCapabilitiesForModel("kiro", "claude-haiku-4.5");
    expect(caps.contextWindow).toBe(200000);
    expect(caps.maxOutput).toBe(128000);
  });

  it("Scenario G: alias and raw id resolve identical limits", () => {
    const byAlias = getCapabilitiesForModel("oc", "muse-spark-1.2-contributor-free");
    const byId = getCapabilitiesForModel("opencode", "muse-spark-1.2-contributor-free");
    expect(byAlias.contextWindow).toBe(byId.contextWindow);
    expect(byAlias.maxOutput).toBe(byId.maxOutput);
  });
});

// ── Canonical max_* precedence (PHASE-5 parity in the intermediate normalizer) ──

describe("canonical max_* precedence (translator/index normalization)", () => {
  const translate = (body) => translateRequest(FORMATS.OPENAI, FORMATS.OPENAI, "m", { ...body }, true, null, "kiro");

  it("max_tokens alone → canonical", () => {
    const out = translate({ messages: [{ role: "user", content: "hi" }], max_tokens: 500 });
    expect(out.max_tokens).toBe(500);
  });

  it("max_output_tokens beats max_tokens when both present", () => {
    const out = translate({ messages: [{ role: "user", content: "hi" }], max_tokens: 128, max_output_tokens: 4096 });
    expect(out.max_tokens).toBe(4096);
    expect(out.max_output_tokens).toBeUndefined();
  });

  it("max_completion_tokens beats max_tokens when max_output_tokens absent", () => {
    const out = translate({ messages: [{ role: "user", content: "hi" }], max_tokens: 128, max_completion_tokens: 777 });
    expect(out.max_tokens).toBe(777);
    expect(out.max_completion_tokens).toBeUndefined();
  });
});

// ── Direct-translator passthrough (no capability-less re-clamp) ──────────────

describe("direct translator max_tokens passthrough", () => {
  it("cursor translator preserves the canonical max_tokens (no floor re-clamp)", async () => {
    const { openaiToCursorRequest } = await import("open-sse/translator/request/openai-to-cursor.js");
    // Canonical budget already resolved upstream; a 1M-context model with a
    // large input must not be re-clamped against the 200K floor.
    const out = openaiToCursorRequest("m", { messages: [{ role: "user", content: "hi" }], max_tokens: 64000 });
    expect(out.max_tokens).toBe(64000);
  });

  it("commandcode translator preserves the canonical max_tokens", async () => {
    const { openaiToCommandCodeRequest } = await import("open-sse/translator/request/openai-to-commandcode.js");
    const out = openaiToCommandCodeRequest("m", { messages: [{ role: "user", content: "hi" }], max_tokens: 64000 }, false);
    expect(out.params.max_tokens).toBe(64000);
  });
});
