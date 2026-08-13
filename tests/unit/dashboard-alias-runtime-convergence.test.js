import { describe, it, expect } from "vitest";
import { AI_MODELS } from "../../src/shared/constants/config";
import { getProviderAlias } from "../../src/shared/constants/providers";
import { resolveProviderAlias } from "../../open-sse/services/model.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getPricingForModel } from "../../open-sse/providers/pricing.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";

// Audit: the dashboard sends ALIAS keys ("cx/gpt-5.6-sol") while the runtime
// sends PROVIDER IDs ("codex/gpt-5.6-sol"). After the alias→id normalization
// in capabilities.js/pricing.js/thinkingLevels.js, both lookups must converge
// on identical values for every model the dashboard advertises.

describe("dashboard alias vs runtime id convergence", () => {
  // Iterates the FULL AI_MODELS catalog (~1352 models) — needs more than
  // vitest's 5s default under 60-way batch concurrency.
  const opts = { timeout: 30_000 };
  const providers = [...new Set(AI_MODELS.map((m) => m.provider))];
  const models = AI_MODELS.filter((m) => !m.isPlaceholder);

  it("every AI_MODELS provider resolves to a known provider id", opts, () => {
    for (const p of providers) {
      const id = resolveProviderAlias(p);
      expect(id, `alias "${p}" should resolve to a provider id`).toBeTruthy();
    }
  });

  it("capabilities identical via alias key vs provider id key", opts, () => {
    const mismatches = [];
    for (const m of models) {
      const alias = m.provider;
      const id = resolveProviderAlias(alias);
      const a = getCapabilitiesForModel(alias, m.model);
      const b = getCapabilitiesForModel(id, m.model);
      for (const k of ["vision", "search", "reasoning", "contextWindow", "maxOutput", "thinkingFormat"]) {
        if (a[k] !== b[k]) {
          mismatches.push({ full: `${alias}/${m.model}`, field: k, aliasVal: a[k], idVal: b[k] });
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("pricing identical via alias key vs provider id key", opts, () => {
    const mismatches = [];
    for (const m of models) {
      const alias = m.provider;
      const id = resolveProviderAlias(alias);
      const a = getPricingForModel(alias, m.model);
      const b = getPricingForModel(id, m.model);
      const sig = (p) => (p ? `${p.input ?? p.prompt ?? p.inputCost ?? 0}/${p.output ?? p.completion ?? p.outputCost ?? 0}` : "null");
      if (sig(a) !== sig(b)) {
        mismatches.push({ full: `${alias}/${m.model}`, aliasVal: sig(a), idVal: sig(b) });
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("thinking levels identical via alias key vs provider id key", opts, () => {
    const mismatches = [];
    for (const m of models) {
      const alias = m.provider;
      const id = resolveProviderAlias(alias);
      const a = getThinkingLevels(alias, m.model);
      const b = getThinkingLevels(id, m.model);
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        mismatches.push({ full: `${alias}/${m.model}`, aliasVal: a, idVal: b });
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("concrete regression: cx/gpt-5.6-sol alias lookup equals runtime id lookup", () => {
    // Pre-fix: alias "cx" missed PROVIDER_CAPABILITIES.codex → fell to pattern
    // → vision:false, 272k ctx. Runtime "codex" → vision:true, 372k ctx.
    const viaAlias = getCapabilitiesForModel("cx", "gpt-5.6-sol");
    const viaId = getCapabilitiesForModel("codex", "gpt-5.6-sol");
    expect(viaAlias).toEqual(viaId);
    expect(viaAlias.vision).toBe(true);
    expect(viaAlias.contextWindow).toBe(372000);
  });

  it("concrete regression: gh/gpt-5.3-codex pricing now resolves to GitHub rates", () => {
    // Pre-fix: PROVIDER_PRICING was keyed by alias "gh" (never called at
    // runtime) → id lookup fell through to canonical OpenAI $6/$24.
    const viaId = getPricingForModel("github", "gpt-5.3-codex");
    const viaAlias = getPricingForModel("gh", "gpt-5.3-codex");
    expect(viaId).toEqual(viaAlias);
    expect(viaId).not.toBeNull();
    expect(viaId.input).toBe(1.75);
    expect(viaId.output).toBe(14);
  });

  it("every dashboard provider key round-trips to a consistent id", () => {
    // Sanity: whatever key AI_MODELS uses (id or alias), resolving it yields
    // the provider id, and resolving that id is idempotent.
    for (const p of providers) {
      const id = resolveProviderAlias(p);
      expect(resolveProviderAlias(id), `provider ${p}`).toBe(id);
    }
  });
});
