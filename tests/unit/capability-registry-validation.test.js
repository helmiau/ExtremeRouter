/**
 * Static validation of the capability registry.
 *
 * These assertions encode the invariants the registry must satisfy for
 * getCapabilitiesForModel to be a trustworthy source for Token Budget. They are
 * structural — no network, no model research — so a bad entry fails CI rather
 * than silently mis-budgeting a request in production.
 *
 * What is deliberately NOT asserted: whether a given number is factually
 * correct. That requires vendor evidence and lives in
 * docs/capability-research.md. This file catches self-contradiction.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAPABILITIES,
  MODEL_CAPABILITIES,
  PROVIDER_CAPABILITIES,
  PATTERN_CAPABILITIES,
  getCapabilitiesForModel,
} from "../../open-sse/providers/capabilities.js";
import { REGISTRY_LIMITS, getRegistryLimits } from "../../open-sse/providers/registryLimits.js";
import { PROVIDER_MODELS } from "../../open-sse/config/providerModels.js";
import { matchPattern } from "../../open-sse/providers/pricing.js";

// Every declared entry, labelled, so a failure names the offender.
function allDeclarations() {
  const out = [];
  for (const [id, caps] of Object.entries(MODEL_CAPABILITIES)) {
    out.push({ label: `MODEL_CAPABILITIES["${id}"]`, caps });
  }
  for (const [provider, models] of Object.entries(PROVIDER_CAPABILITIES)) {
    for (const [id, caps] of Object.entries(models)) {
      out.push({ label: `PROVIDER_CAPABILITIES["${provider}"]["${id}"]`, caps });
    }
  }
  for (const { pattern, provider, caps } of PATTERN_CAPABILITIES) {
    out.push({ label: `PATTERN["${provider ? `${provider}:` : ""}${pattern}"]`, caps });
  }
  return out;
}

// Resolved capabilities for every model the registry actually serves.
function allRegistryModels() {
  const out = [];
  for (const [alias, models] of Object.entries(PROVIDER_MODELS)) {
    for (const m of models || []) {
      out.push({ alias, id: m.id, kind: m.kind || m.type || "llm" });
    }
  }
  return out;
}

describe("capability registry: numeric sanity", () => {
  it("declared contextWindow and maxOutput are positive integers", () => {
    const bad = [];
    for (const { label, caps } of allDeclarations()) {
      for (const field of ["contextWindow", "maxOutput"]) {
        const v = caps[field];
        if (v === undefined) continue;
        if (!Number.isInteger(v) || v <= 0) bad.push(`${label}.${field} = ${v}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("no declared entry claims more output than its context window holds", () => {
    // A model cannot emit more tokens than fit in its window. Where an entry
    // declares only one of the pair the other is inherited, so resolve the
    // merged view rather than comparing raw fields.
    const bad = [];
    for (const { label, caps } of allDeclarations()) {
      const merged = { ...DEFAULT_CAPABILITIES, ...caps };
      // Only meaningful when the entry itself constrains at least one side;
      // pure feature entries inherit the floor pair, which is already valid.
      if (caps.contextWindow === undefined && caps.maxOutput === undefined) continue;
      if (merged.maxOutput > merged.contextWindow) {
        bad.push(`${label}: maxOutput ${merged.maxOutput} > contextWindow ${merged.contextWindow}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("every registry model resolves to a self-consistent limit pair", () => {
    const bad = [];
    for (const { alias, id } of allRegistryModels()) {
      const c = getCapabilitiesForModel(alias, id);
      if (c.maxOutput > c.contextWindow) {
        bad.push(`${alias}/${id}: maxOutput ${c.maxOutput} > contextWindow ${c.contextWindow}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("capability registry: thinking coherence", () => {
  it("thinking metadata is never declared on a non-reasoning entry", () => {
    // thinkingFormat / thinkingLevels / thinkingRange / thinkingMaxEffort are
    // only meaningful when the model can reason. A stray value here makes the
    // dashboard offer a reasoning control the endpoint will reject.
    const bad = [];
    for (const { label, caps } of allDeclarations()) {
      const merged = { ...DEFAULT_CAPABILITIES, ...caps };
      if (merged.reasoning) continue;
      for (const field of ["thinkingFormat", "thinkingLevels", "thinkingRange"]) {
        if (caps[field]) bad.push(`${label}.${field} set but reasoning is false`);
      }
      if (caps.thinkingMaxEffort) bad.push(`${label}.thinkingMaxEffort set but reasoning is false`);
    }
    expect(bad).toEqual([]);
  });

  it("thinkingMaxEffort agrees with an explicit thinkingLevels list", () => {
    // When both are declared they must not contradict: thinkingMaxEffort gates
    // the "max" option in ThinkingLevelPicker and ComboCard, while
    // thinkingLevels is the authoritative set. Claiming max support while
    // omitting it from the list offers an effort the endpoint rejects.
    const bad = [];
    for (const { label, caps } of allDeclarations()) {
      if (!Array.isArray(caps.thinkingLevels)) continue;
      const listHasMax = caps.thinkingLevels.includes("max");
      if (caps.thinkingMaxEffort === true && !listHasMax) {
        bad.push(`${label}: thinkingMaxEffort true but levels ${JSON.stringify(caps.thinkingLevels)} omit "max"`);
      }
      if (caps.thinkingMaxEffort === false && listHasMax) {
        bad.push(`${label}: thinkingMaxEffort false but levels include "max"`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("declared thinkingLevels contain no duplicates and no empty lists", () => {
    const bad = [];
    for (const { label, caps } of allDeclarations()) {
      const lv = caps.thinkingLevels;
      if (!Array.isArray(lv)) continue;
      if (lv.length === 0) bad.push(`${label}: thinkingLevels is empty (use null for "all levels")`);
      if (new Set(lv).size !== lv.length) bad.push(`${label}: thinkingLevels has duplicates`);
    }
    expect(bad).toEqual([]);
  });

  it("thinkingRange min does not exceed max", () => {
    const bad = [];
    for (const { label, caps } of allDeclarations()) {
      const r = caps.thinkingRange;
      if (!r) continue;
      if (!(r.min > 0) || !(r.max > 0)) bad.push(`${label}: thinkingRange has a non-positive bound`);
      else if (r.min > r.max) bad.push(`${label}: thinkingRange min ${r.min} > max ${r.max}`);
    }
    expect(bad).toEqual([]);
  });
});

describe("capability registry: pattern hygiene", () => {
  it("no duplicate pattern within the same provider scope", () => {
    const seen = new Map();
    const dupes = [];
    for (const { pattern, provider } of PATTERN_CAPABILITIES) {
      const key = `${provider || "*"}::${pattern}`;
      if (seen.has(key)) dupes.push(key);
      seen.set(key, true);
    }
    expect(dupes).toEqual([]);
  });

  it("no pattern is fully shadowed by an earlier one", () => {
    // First match wins, so a pattern whose representative id is already claimed
    // by an earlier entry is dead code and its capabilities never apply.
    const representative = (p) => p.replace(/^\*/, "x").replace(/\*$/, "y").replace(/\*/g, "-");
    const dead = [];
    PATTERN_CAPABILITIES.forEach((later, i) => {
      const id = representative(later.pattern);
      const winner = PATTERN_CAPABILITIES.findIndex(
        (p) => (!p.provider || p.provider === later.provider) && matchPattern(p.pattern, id),
      );
      if (winner !== -1 && winner < i) {
        dead.push(`[${i}] "${later.pattern}" is shadowed by [${winner}] "${PATTERN_CAPABILITIES[winner].pattern}"`);
      }
    });
    expect(dead).toEqual([]);
  });

  it("provider-qualified patterns name a provider that resolves", () => {
    // A typo'd provider id makes the pattern permanently unreachable.
    const bad = [];
    for (const { pattern, provider } of PATTERN_CAPABILITIES) {
      if (!provider) continue;
      const known = Object.prototype.hasOwnProperty.call(PROVIDER_MODELS, provider)
        || Object.prototype.hasOwnProperty.call(PROVIDER_CAPABILITIES, provider);
      if (!known) bad.push(`PATTERN["${provider}:${pattern}"] references unknown provider "${provider}"`);
    }
    expect(bad).toEqual([]);
  });
});

describe("capability registry: registry-declared limits", () => {
  it("every registry limit is a positive integer with output <= context", () => {
    const bad = [];
    for (const [providerId, models] of Object.entries(REGISTRY_LIMITS)) {
      for (const [modelId, limits] of Object.entries(models)) {
        const label = `${providerId}/${modelId}`;
        for (const [field, v] of Object.entries(limits)) {
          if (!Number.isInteger(v) || v <= 0) bad.push(`${label}.${field} = ${v}`);
        }
        if (limits.contextWindow && limits.maxOutput && limits.maxOutput > limits.contextWindow) {
          bad.push(`${label}: maxOutput ${limits.maxOutput} > contextWindow ${limits.contextWindow}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("a registry limit overrides a family wildcard", () => {
    // GitHub Copilot serves claude-opus-4.7 with a 64k output cap; Anthropic's
    // own API allows 128k. Without the registry tier the wildcard would apply
    // GitHub's model the wrong ceiling.
    expect(getRegistryLimits("github", "claude-opus-4.7")).toEqual({
      contextWindow: 1000000,
      maxOutput: 64000,
    });
    expect(getCapabilitiesForModel("gh", "claude-opus-4.7").maxOutput).toBe(64000);
    expect(getCapabilitiesForModel("anthropic", "claude-opus-4.7").maxOutput).toBe(128000);
  });

  it("a registry limit does not override an explicit provider entry", () => {
    // PROVIDER_CAPABILITIES is the same specificity but describes more fields,
    // so it stays authoritative. Codex pins gpt-5.6-sol at a 372k window that
    // the forge registry entry (1.05M) must not widen.
    expect(getCapabilitiesForModel("codex", "gpt-5.6-sol").contextWindow).toBe(372000);
  });

  it("a registry limit does not leak across providers", () => {
    expect(getRegistryLimits("anthropic", "claude-opus-4.7")).toBe(null);
  });

  it("limits apply on top of pattern-derived feature flags", () => {
    // The claude wildcard supplies vision/reasoning; the registry supplies the
    // GitHub-specific ceiling. Both must survive.
    const c = getCapabilitiesForModel("gh", "claude-sonnet-4.6");
    expect(c.reasoning).toBe(true);
    expect(c.vision).toBe(true);
    expect(c.maxOutput).toBe(64000);
  });
});
