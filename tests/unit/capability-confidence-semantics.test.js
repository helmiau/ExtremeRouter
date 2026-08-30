/**
 * Semantics of `known`, `confidence` and `sourceType`.
 *
 * The trap these guard against: reading `known: true` as "this data is
 * confirmed". It is not — it means some evidence applied, and a family wildcard
 * or a provider catalog listing counts as evidence. Only
 * `confidence === "verified"` means a source names this exact model.
 *
 * Frozen-baseline contract for the Capability Registry:
 *   known === (confidence !== "unknown")        always, no exceptions
 *   sourceType determines confidence            via one mapping, not per-entry
 *   inferred !== verified                       distinguishable by consumers
 *   default floor is always unknown/known:false never silently promoted
 */
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_CONFIDENCE,
  CAPABILITY_SOURCE,
  DEFAULT_CAPABILITIES,
  getCapabilitiesForModel,
} from "../../open-sse/providers/capabilities.js";
import { PROVIDER_MODELS } from "../../open-sse/config/providerModels.js";
import { toClientCaps } from "../../src/shared/utils/modelCaps.js";

// One representative per source tier. Chosen so each lands on a different tier;
// asserted below so a registry change that moves one is caught rather than
// silently weakening the coverage.
const BY_SOURCE = {
  [CAPABILITY_SOURCE.PROVIDER_MODEL]: ["codex", "gpt-5.6-sol"],
  [CAPABILITY_SOURCE.MODEL_EXACT]: ["anthropic", "claude-opus-4.7"],
  [CAPABILITY_SOURCE.PROVIDER_REGISTRY]: ["gh", "oswe-vscode-prime"],
  [CAPABILITY_SOURCE.FAMILY_PATTERN]: ["zai", "glm-5.3"],
  [CAPABILITY_SOURCE.DEFAULT_FLOOR]: ["no-such-provider", "no-such-model-zzz"],
};

describe("provenance fields are always present and internally consistent", () => {
  it("every source tier is exercised by a distinct representative", () => {
    for (const [expectedSource, [provider, model]] of Object.entries(BY_SOURCE)) {
      const c = getCapabilitiesForModel(provider, model);
      expect(c.sourceType, `${provider}/${model}`).toBe(expectedSource);
    }
  });

  it("known is exactly the negation of unknown confidence", () => {
    // The invariant that keeps the boolean and the enum from drifting apart.
    for (const [provider, model] of Object.values(BY_SOURCE)) {
      const c = getCapabilitiesForModel(provider, model);
      expect(c.known, `${provider}/${model}`).toBe(c.confidence !== CAPABILITY_CONFIDENCE.UNKNOWN);
    }
  });

  it("holds across every model the registry serves", { timeout: 30_000 }, () => {
    const bad = [];
    for (const [alias, models] of Object.entries(PROVIDER_MODELS)) {
      for (const m of models || []) {
        const c = getCapabilitiesForModel(alias, m.id);
        if (!c.sourceType) bad.push(`${alias}/${m.id}: missing sourceType`);
        if (!c.confidence) bad.push(`${alias}/${m.id}: missing confidence`);
        if (c.known !== (c.confidence !== CAPABILITY_CONFIDENCE.UNKNOWN)) {
          bad.push(`${alias}/${m.id}: known=${c.known} contradicts confidence=${c.confidence}`);
        }
        if (!Object.values(CAPABILITY_SOURCE).includes(c.sourceType)) {
          bad.push(`${alias}/${m.id}: unrecognised sourceType "${c.sourceType}"`);
        }
        if (!Object.values(CAPABILITY_CONFIDENCE).includes(c.confidence)) {
          bad.push(`${alias}/${m.id}: unrecognised confidence "${c.confidence}"`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("a missing model id resolves to the floor with unknown confidence", () => {
    for (const model of ["", null, undefined]) {
      const c = getCapabilitiesForModel("anthropic", model);
      expect(c.sourceType, String(model)).toBe(CAPABILITY_SOURCE.DEFAULT_FLOOR);
      expect(c.confidence, String(model)).toBe(CAPABILITY_CONFIDENCE.UNKNOWN);
      expect(c.known, String(model)).toBe(false);
    }
  });
});

describe("known: true does not mean verified", () => {
  it("a family-pattern result is known but only inferred", () => {
    // The whole point of the distinction: glm-5.3 gets real numbers from a
    // family rule, so evidence applied — but no source named this model.
    const c = getCapabilitiesForModel("zai", "glm-5.3");
    expect(c.known).toBe(true);
    expect(c.confidence).toBe(CAPABILITY_CONFIDENCE.INFERRED);
    expect(c.confidence).not.toBe(CAPABILITY_CONFIDENCE.VERIFIED);
  });

  it("a provider-catalog result is known but only inferred", () => {
    const c = getCapabilitiesForModel("gh", "oswe-vscode-prime");
    expect(c.known).toBe(true);
    expect(c.confidence).toBe(CAPABILITY_CONFIDENCE.INFERRED);
  });

  it("known: true spans both verified and inferred, so it cannot stand in for verified", () => {
    const verified = getCapabilitiesForModel("anthropic", "claude-opus-4.7");
    const inferred = getCapabilitiesForModel("zai", "glm-5.3");
    expect(verified.known).toBe(inferred.known); // both true
    expect(verified.confidence).not.toBe(inferred.confidence);
  });
});

describe("verified is reserved for model-specific sources", () => {
  it("an exact provider+model entry is verified", () => {
    const c = getCapabilitiesForModel("codex", "gpt-5.6-sol");
    expect(c.sourceType).toBe(CAPABILITY_SOURCE.PROVIDER_MODEL);
    expect(c.confidence).toBe(CAPABILITY_CONFIDENCE.VERIFIED);
  });

  it("an exact canonical model id is verified", () => {
    const c = getCapabilitiesForModel("anthropic", "claude-opus-4.7");
    expect(c.sourceType).toBe(CAPABILITY_SOURCE.MODEL_EXACT);
    expect(c.confidence).toBe(CAPABILITY_CONFIDENCE.VERIFIED);
  });

  it("verified survives alias, vendor-prefix and version-spelling variation", () => {
    // Canonicalization must not downgrade provenance.
    for (const [provider, model] of [
      ["anthropic", "claude-opus-4.7"],
      ["anthropic", "anthropic/claude-opus-4.7"],
      ["anthropic", "claude-opus-4-7"],
    ]) {
      const c = getCapabilitiesForModel(provider, model);
      expect(c.confidence, `${provider}/${model}`).toBe(CAPABILITY_CONFIDENCE.VERIFIED);
    }
  });

  it("an exact match whose limits come from a catalog is downgraded to inferred", () => {
    // github/claude-opus-4.7 matches the exact 4.7 entry for its features, but
    // the ceiling Token Budget enforces (64000) comes from GitHub's catalog.
    // Reporting "verified" would overstate where the enforced number came from.
    const c = getCapabilitiesForModel("gh", "claude-opus-4.7");
    expect(c.sourceType).toBe(CAPABILITY_SOURCE.PROVIDER_REGISTRY);
    expect(c.confidence).toBe(CAPABILITY_CONFIDENCE.INFERRED);
    expect(c.maxOutput).toBe(64000);
    // Features still arrive from the exact entry.
    expect(c.thinkingFormat).toBe("claude-adaptive");

    // Without the catalog overlay the same model id stays verified.
    const direct = getCapabilitiesForModel("anthropic", "claude-opus-4.7");
    expect(direct.confidence).toBe(CAPABILITY_CONFIDENCE.VERIFIED);
    expect(direct.maxOutput).toBe(128000);
  });

  it("a provider entry is not downgraded by a catalog listing", () => {
    // PROVIDER_CAPABILITIES is checked before the overlay, so codex's pinned
    // 372k window stays verified despite forge declaring 1.05M for the same id.
    const c = getCapabilitiesForModel("codex", "gpt-5.6-sol");
    expect(c.confidence).toBe(CAPABILITY_CONFIDENCE.VERIFIED);
    expect(c.contextWindow).toBe(372000);
  });
});

describe("unknown stays unknown", () => {
  it("an unmatched model reports the floor as its source", () => {
    const c = getCapabilitiesForModel("no-such-provider", "no-such-model-zzz");
    expect(c.sourceType).toBe(CAPABILITY_SOURCE.DEFAULT_FLOOR);
    expect(c.confidence).toBe(CAPABILITY_CONFIDENCE.UNKNOWN);
    expect(c.known).toBe(false);
  });

  it("the floor's numbers are never presented as evidence", () => {
    const c = getCapabilitiesForModel("no-such-provider", "no-such-model-zzz");
    // The numbers are real (Token Budget needs a ceiling) but unverified.
    expect(c.contextWindow).toBe(DEFAULT_CAPABILITIES.contextWindow);
    expect(c.maxOutput).toBe(DEFAULT_CAPABILITIES.maxOutput);
    expect(c.confidence).toBe(CAPABILITY_CONFIDENCE.UNKNOWN);
  });

  it("a floor result carrying identical numbers to a verified one is still distinguishable", () => {
    // DEFAULT_CAPABILITIES is 200000/64000. A model verified at those same
    // numbers must not be confusable with the floor.
    const floor = getCapabilitiesForModel("no-such-provider", "no-such-model-zzz");
    const patterned = getCapabilitiesForModel("zai", "glm-5");
    expect(patterned.contextWindow).toBe(floor.contextWindow); // both 200000
    expect(patterned.confidence).not.toBe(floor.confidence);
    expect(patterned.known).toBe(true);
    expect(floor.known).toBe(false);
  });

  it("no LLM model is promoted out of unknown without evidence", () => {
    // Snapshot of the evidence gap. This number may only go DOWN as models gain
    // entries; an increase means something regressed to the floor.
    let unknown = 0;
    for (const [alias, models] of Object.entries(PROVIDER_MODELS)) {
      for (const m of models || []) {
        if ((m.kind || m.type || "llm") !== "llm") continue;
        if (getCapabilitiesForModel(alias, m.id).confidence === CAPABILITY_CONFIDENCE.UNKNOWN) unknown++;
      }
    }
    expect(unknown).toBeLessThanOrEqual(140);
  });
});

describe("provenance reaches the client shape", () => {
  it("inferred is forwarded so the dashboard can mark it", () => {
    const caps = toClientCaps(getCapabilitiesForModel("zai", "glm-5.3"));
    expect(caps.confidence).toBe(CAPABILITY_CONFIDENCE.INFERRED);
    // Evidence applied, so the boolean stays absent (⇒ known).
    expect("known" in caps).toBe(false);
  });

  it("unknown is forwarded as both confidence and the boolean", () => {
    const caps = toClientCaps(getCapabilitiesForModel("no-such-provider", "no-such-model-zzz"));
    expect(caps.confidence).toBe(CAPABILITY_CONFIDENCE.UNKNOWN);
    expect(caps.known).toBe(false);
  });

  it("verified is omitted, matching the omit-defaults wire convention", () => {
    const caps = toClientCaps(getCapabilitiesForModel("anthropic", "claude-opus-4.7"));
    expect("confidence" in caps).toBe(false);
    expect("known" in caps).toBe(false);
  });

  it("a client caps object without provenance keys reads as verified and known", () => {
    // Consumers treat absence as the default, so an older cached payload does
    // not start reporting everything as unknown.
    const caps = toClientCaps({ vision: true, maxOutput: 4096 });
    expect(caps.confidence).toBeUndefined();
    expect(caps.known).toBeUndefined();
  });
});

describe("provenance does not disturb capability resolution", () => {
  it("precedence is unchanged by the provenance fields", () => {
    // Same expectations as capability-identity-precedence, restated here so a
    // provenance refactor that breaks precedence fails in this file too.
    expect(getCapabilitiesForModel("codex", "gpt-5.6-sol").contextWindow).toBe(372000);
    expect(getCapabilitiesForModel("openai", "gpt-5.6-sol").contextWindow).toBe(272000);
    expect(getCapabilitiesForModel("gh", "claude-opus-4.7").maxOutput).toBe(64000);
    expect(getCapabilitiesForModel("anthropic", "claude-opus-4.7").maxOutput).toBe(128000);
    expect(getCapabilitiesForModel("zai", "glm-4.6v").vision).toBe(true);
    expect(getCapabilitiesForModel("zai", "glm-4.6").vision).toBe(false);
  });

  it("resolved limit pairs stay self-consistent regardless of source", () => {
    const bad = [];
    for (const [alias, models] of Object.entries(PROVIDER_MODELS)) {
      for (const m of models || []) {
        const c = getCapabilitiesForModel(alias, m.id);
        if (c.maxOutput > c.contextWindow) {
          bad.push(`${alias}/${m.id} [${c.sourceType}]: out ${c.maxOutput} > ctx ${c.contextWindow}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
