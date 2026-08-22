/**
 * Canonical model identity, resolution precedence, and capability provenance.
 *
 * The failure these guard against: a family wildcard silently answering for a
 * model that differs from its family. `*claude*opus*` must not decide what
 * GitHub Copilot's claude-opus-4.7 can do, and an unknown model must not be
 * handed a plausible-looking 200k/64k pair as though it were researched.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_CAPABILITIES, getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getRegistryLimits } from "../../open-sse/providers/registryLimits.js";
import { resolveOutputBudget } from "../../open-sse/services/tokenBudget.js";
import { toClientCaps } from "../../src/shared/utils/modelCaps.js";

describe("canonical model identity", () => {
  it("provider aliases and canonical ids resolve identically", () => {
    // "gh" is the alias, "github" the registry id. Both must reach the same
    // capability entry or the dashboard and the router disagree.
    expect(getCapabilitiesForModel("gh", "claude-opus-4.7"))
      .toEqual(getCapabilitiesForModel("github", "claude-opus-4.7"));
  });

  it("a vendor-prefixed model id resolves to the same profile as the bare id", () => {
    expect(getCapabilitiesForModel("anthropic", "anthropic/claude-opus-4.7"))
      .toEqual(getCapabilitiesForModel("anthropic", "claude-opus-4.7"));
  });

  it("dotted and dashed version spellings resolve identically", () => {
    // Registries carry both claude-opus-4.7 and claude-opus-4-7.
    expect(getCapabilitiesForModel("anthropic", "claude-opus-4-7"))
      .toEqual(getCapabilitiesForModel("anthropic", "claude-opus-4.7"));
  });

  it("a provider-prefixed opencode id is not double-prefixed", () => {
    // The oc/ prefix once appeared twice in a resolved full model id, which
    // missed the capability entry entirely and dropped the reasoning icon.
    const bare = getCapabilitiesForModel("opencode", "x-preview-f-free");
    expect(bare.reasoning).toBe(true);
    expect(getCapabilitiesForModel("opencode", "oc/x-preview-f-free")).toEqual(bare);
    expect(getCapabilitiesForModel("oc", "x-preview-f-free")).toEqual(bare);
  });

  it("a stealth-prefixed id resolves through its family pattern", () => {
    const c = getCapabilitiesForModel("cline", "stealth/ox-alpha");
    expect(c.reasoning).toBe(true);
    expect(c.thinkingFormat).toBe("openai");
  });

  it("an empty model id yields the floor and is marked unverified", () => {
    const c = getCapabilitiesForModel("anthropic", "");
    expect(c.known).toBe(false);
    expect(c.contextWindow).toBe(DEFAULT_CAPABILITIES.contextWindow);
  });
});

describe("resolution precedence", () => {
  it("an exact provider entry beats the family wildcard", () => {
    // *gpt-5.6-sol* declares a 272k window; the codex provider entry pins 372k
    // because the ChatGPT backend reports a different figure.
    expect(getCapabilitiesForModel("codex", "gpt-5.6-sol").contextWindow).toBe(372000);
    expect(getCapabilitiesForModel("openai", "gpt-5.6-sol").contextWindow).toBe(272000);
  });

  it("an exact model entry beats the family wildcard", () => {
    // *claude*opus* would give 200k + budget thinking; the exact 4.7 entry
    // gives 1M + adaptive.
    const exact = getCapabilitiesForModel("anthropic", "claude-opus-4.7");
    expect(exact.contextWindow).toBe(1000000);
    expect(exact.thinkingFormat).toBe("claude-adaptive");

    const older = getCapabilitiesForModel("anthropic", "claude-opus-4-5-20251101");
    expect(older.contextWindow).toBe(200000);
    expect(older.thinkingFormat).toBe("claude-budget");
  });

  it("a registry limit beats the family wildcard but not a provider entry", () => {
    // GitHub caps claude output at 64k; Anthropic's own API allows 128k.
    expect(getCapabilitiesForModel("gh", "claude-opus-4.7").maxOutput).toBe(64000);
    expect(getCapabilitiesForModel("anthropic", "claude-opus-4.7").maxOutput).toBe(128000);
    // forge declares a 1.05M window for gpt-5.6-sol; codex's provider entry wins.
    expect(getCapabilitiesForModel("codex", "gpt-5.6-sol").contextWindow).toBe(372000);
  });

  it("a provider-qualified pattern applies only under that provider", () => {
    // tokenrouter's qwen backend rejects effort levels above medium.
    const scoped = getCapabilitiesForModel("tokenrouter", "qwen3.8-max");
    expect(scoped.thinkingLevels).toEqual(["low", "medium"]);
    expect(scoped.thinkingFormat).toBe("openai");

    // The same family elsewhere keeps the generic qwen profile.
    const generic = getCapabilitiesForModel("dashscope", "qwen3.8-max");
    expect(generic.thinkingFormat).toBe("qwen");
    expect(generic.thinkingLevels).toBe(null);
  });

  it("more specific wildcards win over broader ones in the same family", () => {
    // *gemini-3*pro* declares 65535 output; the broader *gemini-3* declares 65536.
    expect(getCapabilitiesForModel("gemini", "gemini-3-pro-preview").maxOutput).toBe(65535);
    expect(getCapabilitiesForModel("gemini", "gemini-3-flash").maxOutput).toBe(65536);
  });
});

describe("capability isolation: family is metadata, not inheritance", () => {
  it("same family, different vision", () => {
    // glm-4.6v reads images; the text glm-4.6 does not. A *glm* wildcard must
    // not promote the text model to vision.
    expect(getCapabilitiesForModel("zai", "glm-4.6v").vision).toBe(true);
    expect(getCapabilitiesForModel("zai", "glm-4.6").vision).toBe(false);
  });

  it("same family, different context window", () => {
    expect(getCapabilitiesForModel("zai", "glm-5.3").contextWindow).toBe(1000000);
    expect(getCapabilitiesForModel("zai", "glm-5").contextWindow).toBe(200000);
  });

  it("same family, different thinking level sets", () => {
    expect(getCapabilitiesForModel("xai", "grok-4.6").thinkingLevels).toEqual(["low", "medium", "high", "xhigh"]);
    expect(getCapabilitiesForModel("xai", "grok-4.5").thinkingLevels).toEqual(["low", "medium", "high"]);
    expect(getCapabilitiesForModel("xai", "grok-4").thinkingLevels).toBe(null);
  });

  it("same model name under different providers can differ", () => {
    const codexSol = getCapabilitiesForModel("codex", "gpt-5.6-sol");
    const forgeSol = getCapabilitiesForModel("forge", "gpt-5.6-sol");
    expect(codexSol.contextWindow).not.toBe(forgeSol.contextWindow);
    // Codex advertises the discrete level matrix; forge falls back to the family.
    expect(codexSol.thinkingLevels).toContain("ultra");
    expect(forgeSol.thinkingLevels).toBe(null);
  });

  it("contextWindow and maxOutput stay independent", () => {
    const c = getCapabilitiesForModel("anthropic", "claude-opus-4.7");
    expect(c.contextWindow).toBe(1000000);
    expect(c.maxOutput).toBe(128000);
    expect(c.maxOutput).not.toBe(c.contextWindow);
  });
});

describe("capability provenance: known vs unverified", () => {
  it("an unknown model is marked unverified", () => {
    const c = getCapabilitiesForModel("no-such-provider", "no-such-model-zzz");
    expect(c.known).toBe(false);
  });

  it("the unverified floor is never mistaken for evidence", () => {
    // Same numbers, different standing: verified entries must be reachable
    // without the floor's assumption. This asserts the flag actually
    // discriminates rather than being constant.
    const unknown = getCapabilitiesForModel("no-such-provider", "no-such-model-zzz");
    const verified = getCapabilitiesForModel("anthropic", "claude-opus-4.7");
    expect(unknown.known).toBe(false);
    expect(verified.known).toBe(true);
    expect(unknown.contextWindow).toBe(DEFAULT_CAPABILITIES.contextWindow);
  });

  it("a model known only through a registry limit is marked verified for that limit", () => {
    // oswe-vscode-prime matches no pattern; GitHub's registry supplies the pair.
    expect(getRegistryLimits("github", "oswe-vscode-prime")).toEqual({
      contextWindow: 264000,
      maxOutput: 64000,
    });
    const c = getCapabilitiesForModel("gh", "oswe-vscode-prime");
    expect(c.known).toBe(true);
    expect(c.contextWindow).toBe(264000);
    // Feature flags still come from the floor — the registry says nothing here.
    expect(c.reasoning).toBe(false);
  });

  it("each resolution tier reports known: true", () => {
    for (const [provider, model] of [
      ["codex", "gpt-5.6-sol"],          // provider entry
      ["anthropic", "claude-opus-4.7"],  // exact model entry
      ["zai", "glm-5.3"],                // pattern
      ["gh", "oswe-vscode-prime"],       // registry limit only
    ]) {
      expect(getCapabilitiesForModel(provider, model).known, `${provider}/${model}`).toBe(true);
    }
  });

  it("toClientCaps forwards the unverified marker and omits it when verified", () => {
    const unknown = toClientCaps(getCapabilitiesForModel("no-such-provider", "no-such-model-zzz"));
    expect(unknown.known).toBe(false);

    const verified = toClientCaps(getCapabilitiesForModel("anthropic", "claude-opus-4.7"));
    expect("known" in verified).toBe(false);
  });
});

describe("Token Budget consumes verified capability data", () => {
  // The registry is the data source; the resolver is the enforcement. These
  // assert the wiring, not the arithmetic (see tests/unit/tokenBudget.test.js).
  const budget = (provider, model, requested, input = 1000) =>
    resolveOutputBudget({
      requestedOutputTokens: requested,
      provider,
      model,
      exactInputTokens: input,
    });

  it("a different maxOutput yields a different output ceiling", () => {
    // Same request, same provider family, different verified output caps.
    expect(budget("anthropic", "claude-opus-4.7", 200000).effectiveOutputTokens).toBe(128000);
    expect(budget("gh", "claude-opus-4.7", 200000).effectiveOutputTokens).toBe(64000);
  });

  it("a different contextWindow yields a different feasibility verdict", () => {
    // 300k of input: fits inside a 1M window, overruns a 200k one.
    const wide = budget("anthropic", "claude-opus-4.7", 4096, 300000);
    const narrow = budget("anthropic", "claude-opus-4-5-20251101", 4096, 300000);
    expect(wide.feasible).toBe(true);
    expect(narrow.feasible).toBe(false);
    expect(narrow.effectiveOutputTokens).toBe(0);
    expect(narrow.limitingFactor).toBe("context_window");
  });

  it("registry-declared limits reach the resolver's hard ceiling", () => {
    const r = budget("qwc", "glm-5.2", 128000);
    expect(r.constraints.modelMaxOutput).toBe(16384);
    expect(r.effectiveOutputTokens).toBe(16384);
    expect(r.limitingFactor).toBe("model_max_output");
  });

  it("the unverified floor still supplies a ceiling rather than going unbounded", () => {
    // Unknown capability must not mean unconstrained output — a null ceiling
    // would be the unsafe direction.
    const r = budget("no-such-provider", "no-such-model-zzz", 1000000);
    expect(r.constraints.modelMaxOutput).toBe(DEFAULT_CAPABILITIES.maxOutput);
    expect(r.effectiveOutputTokens).toBe(DEFAULT_CAPABILITIES.maxOutput);
  });
});
