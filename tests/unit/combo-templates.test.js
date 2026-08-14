import { describe, it, expect } from "vitest";
import { COMBO_TEMPLATES } from "@/shared/constants/comboTemplates";
import { PROVIDER_MODELS } from "open-sse/config/providerModels.js";
import { STRATEGY_OPTIONS } from "@/app/(dashboard)/dashboard/combos/components/helpers";
import {
  resolveTemplateModels,
  resolveTemplateStrategyConfig,
  TEMPLATE_ROLE_KEYS,
} from "@/app/(dashboard)/dashboard/combos/components/templateResolution";
import { resolveProviderId, getProviderAlias } from "@/shared/constants/providers";

const VALID_STRATEGIES = new Set(STRATEGY_OPTIONS.map((o) => o.value));

describe("COMBO_TEMPLATES catalog sanity", () => {
  it("every template model name exists in the catalog, and preferred aliases resolve", () => {
    const failures = [];
    for (const tpl of COMBO_TEMPLATES) {
      for (const ref of tpl.models || []) {
        const modelName = ref.includes("/") ? ref.slice(ref.indexOf("/") + 1) : ref;
        const carriers = Object.entries(PROVIDER_MODELS)
          .filter(([, models]) => models.some((m) => m.id === modelName))
          .map(([alias]) => alias);
        if (carriers.length === 0) {
          failures.push(`${tpl.id}: model "${modelName}" not found in any provider catalog`);
        }
      }
      for (const [modelName, alias] of Object.entries(tpl.preferredProviders || {})) {
        const carriers = Object.entries(PROVIDER_MODELS)
          .filter(([, models]) => models.some((m) => m.id === modelName))
          .map(([alias]) => alias);
        if (!carriers.includes(alias)) {
          failures.push(
            `${tpl.id}: preferred provider "${alias}" does not carry "${modelName}" (carriers: ${carriers.join(", ")})`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("every template has a valid strategy; strategyConfig.fallbackStrategy matches it", () => {
    for (const tpl of COMBO_TEMPLATES) {
      expect(VALID_STRATEGIES, `${tpl.id}: invalid strategy "${tpl.strategy}"`).toContain(tpl.strategy);
      if (tpl.strategyConfig) {
        expect(tpl.strategyConfig.fallbackStrategy, `${tpl.id}: strategyConfig strategy mismatch`).toBe(tpl.strategy);
      }
    }
  });

  it("template role models reference member models by name", () => {
    for (const tpl of COMBO_TEMPLATES) {
      const memberNames = new Set((tpl.models || []).map((ref) =>
        ref.includes("/") ? ref.slice(ref.indexOf("/") + 1) : ref
      ));
      for (const roleKey of TEMPLATE_ROLE_KEYS) {
        const roleRef = tpl.strategyConfig?.[roleKey];
        if (!roleRef) continue;
        const roleModelName = roleRef.includes("/") ? roleRef.slice(roleRef.indexOf("/") + 1) : roleRef;
        expect(
          memberNames.has(roleModelName),
          `${tpl.id}: role ${roleKey} model "${roleModelName}" is not a template member`,
        ).toBe(true);
      }
    }
  });
});

describe("resolveTemplateModels", () => {
  const connected = new Set(["claude", "codex", "glm"]);
  const modelIndex = {
    "claude-opus-4-7": ["cc", "puter"],
    "gpt-5.4": ["cx"],
    "glm-5.1": ["glm"],
    "MiniMax-M2.7": ["minimax"],
  };

  it("preferred provider wins when connected", () => {
    const tpl = {
      models: ["claude-opus-4-7"],
      preferredProviders: { "claude-opus-4-7": "cc" },
    };
    const [m] = resolveTemplateModels(tpl, { modelIndex, connectedProviders: connected });
    expect(m).toMatchObject({ available: true, provider: "claude", providerAlias: "cc", full: "cc/claude-opus-4-7" });
  });

  it("falls back to another connected provider when the preferred one is not connected", () => {
    // preferred minimax is NOT connected; only glm carries... build a case where
    // the model is carried by puter + claude and preferred is puter (disconnected).
    const tpl = {
      models: ["claude-opus-4-7"],
      preferredProviders: { "claude-opus-4-7": "puter" },
    };
    const [m] = resolveTemplateModels(tpl, { modelIndex, connectedProviders: connected });
    expect(m.available).toBe(true);
    expect(m.provider).toBe("claude"); // fallback, not puter
    expect(m.resolvedFrom).toBe("puter");
  });

  it("marks unavailable when no connected provider carries the model", () => {
    const tpl = { models: ["MiniMax-M2.7"], preferredProviders: { "MiniMax-M2.7": "minimax" } };
    const [m] = resolveTemplateModels(tpl, { modelIndex, connectedProviders: connected });
    expect(m.available).toBe(false);
    expect(m.full).toBe("MiniMax-M2.7"); // bare name when no prefix
  });

  it("supports legacy provider/model refs (preferred embedded)", () => {
    const tpl = { models: ["cc/claude-opus-4-7"] };
    const [m] = resolveTemplateModels(tpl, { modelIndex, connectedProviders: connected });
    expect(m).toMatchObject({ available: true, modelName: "claude-opus-4-7", full: "cc/claude-opus-4-7" });
  });
});

describe("resolveTemplateStrategyConfig", () => {
  const connected = new Set(["claude", "codex", "glm", "kiro"]);
  const modelIndex = {
    "claude-opus-4-7": ["cc"],
    "gpt-5.4": ["cx"],
    "glm-5.1": ["glm"],
    "claude-sonnet-4.5": ["kr"],
  };
  const tpl = {
    strategy: "swarm",
    models: ["claude-opus-4-7", "gpt-5.4", "glm-5.1", "claude-sonnet-4.5"],
    strategyConfig: {
      fallbackStrategy: "swarm",
      managerModel: "claude-opus-4-7",
      auditModel: "claude-sonnet-4.5",
    },
  };

  it("resolves model-name role refs to alias/model of the resolved member", () => {
    const resolved = resolveTemplateModels(tpl, { modelIndex, connectedProviders: connected });
    const cfg = resolveTemplateStrategyConfig(tpl, resolved);
    expect(cfg.fallbackStrategy).toBe("swarm");
    expect(cfg.managerModel).toBe("cc/claude-opus-4-7");
    expect(cfg.auditModel).toBe("kr/claude-sonnet-4.5");
  });

  it("falls back to { fallbackStrategy } for legacy templates without strategyConfig", () => {
    const legacy = { strategy: "fallback", models: ["gpt-5.4"] };
    const resolved = resolveTemplateModels(legacy, { modelIndex, connectedProviders: connected });
    const cfg = resolveTemplateStrategyConfig(legacy, resolved);
    expect(cfg).toEqual({ fallbackStrategy: "fallback" });
  });

  it("keeps the original role ref when the role model is unresolvable (server will reject clearly)", () => {
    const bad = {
      strategy: "swarm",
      models: ["gpt-5.4"],
      strategyConfig: { fallbackStrategy: "swarm", managerModel: "claude-opus-4-7" },
    };
    const resolved = resolveTemplateModels(bad, { modelIndex, connectedProviders: connected });
    const cfg = resolveTemplateStrategyConfig(bad, resolved);
    expect(cfg.managerModel).toBe("claude-opus-4-7"); // unresolvable → left as-is
  });
});

describe("preferred alias helper coherence", () => {
  it("template preferred aliases resolve to a real provider id", () => {
    for (const tpl of COMBO_TEMPLATES) {
      for (const alias of Object.values(tpl.preferredProviders || {})) {
        const id = resolveProviderId(alias);
        expect(id, `${tpl.id}: alias "${alias}" does not resolve`).not.toBe("");
        expect(getProviderAlias(id), `${tpl.id}: alias round-trip failed for "${alias}"`).toBe(alias);
      }
    }
  });
});
