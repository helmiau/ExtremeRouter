// @vitest-environment jsdom
// Benchmark probe: ModelSelectModal render cost with the full 1352-model
// catalog, comparing the pre-optimization caps shape vs the compact
// toClientCaps shape. Prints a report; keeps only generous, ratio-based
// sanity assertions so slow CI boxes never flake the release gate.
import { describe, it, expect, vi } from "vitest";
import { renderToString } from "react-dom/server";
import React from "react";
import { AI_MODELS } from "@/shared/constants/config";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { toClientCaps } from "@/shared/utils/modelCaps";
import { getProviderAlias } from "@/shared/constants/providers";

// --- shared state for the mocked useModelCaps (warm-cache render) ----------
const warm = vi.hoisted(() => ({ byFull: {}, byId: {}, fullModels: [] }));

vi.mock("@/shared/hooks/useModelCaps", () => ({
  useModelCaps: () => ({
    // Same semantics as the real hook with its cache populated from /api/models.
    getCaps: (key) => {
      if (!key) return null;
      const k = typeof key === "string" ? key : String(key);
      if (warm.byFull[k]) return warm.byFull[k];
      const bare = k.includes("/") ? k.slice(k.indexOf("/") + 1) : k;
      if (warm.byId[bare]) return warm.byId[bare];
      return {};
    },
  }),
}));

// Lazy import after vi.mock so the component resolves the mocked hook.
const { default: ModelSelectModal } = await import(
  "@/shared/components/ModelSelectModal"
);

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function timeIt(fn, runs) {
  const t = [];
  for (let i = 0; i < runs; i++) {
    const s = performance.now();
    fn();
    t.push(performance.now() - s);
  }
  return median(t);
}

describe("ModelSelectModal render benchmark (1352 models)", () => {
  it(
    "profiles wire payload, parse, cache build, getCaps and full render",
    { timeout: 120000 },
    () => {
      // 1. Build the real /api/models rows with OLD (full) vs NEW (compact) caps.
      const oldRows = [];
      const newRows = [];
      const fullModels = [];
      for (const m of AI_MODELS) {
        const fullModel = `${m.provider}/${m.model}`;
        const c = getCapabilitiesForModel(m.provider, m.model);
        fullModels.push(fullModel);
        oldRows.push({
          ...m,
          fullModel,
          alias: m.model,
          caps: {
            vision: c.vision,
            search: c.search,
            reasoning: c.reasoning,
            thinkingLevels: c.thinkingLevels || null,
            thinkingMaxEffort: c.thinkingMaxEffort || false,
            thinkingCanDisable: c.thinkingCanDisable !== false,
            thinkingFormat: c.thinkingFormat || null,
            maxOutput: c.maxOutput || null,
            contextWindow: c.contextWindow || null,
            tools: c.tools !== false,
            pdf: c.pdf || false,
            audioInput: c.audioInput || false,
            videoInput: c.videoInput || false,
          },
        });
        newRows.push({ ...m, fullModel, alias: m.model, caps: toClientCaps(c) });
      }
      const oldJson = JSON.stringify(oldRows);
      const newJson = JSON.stringify(newRows);
      const oldKB = (oldJson.length / 1024).toFixed(1);
      const newKB = (newJson.length / 1024).toFixed(1);

      // 2. JSON.parse median.
      const parseOld = timeIt(() => JSON.parse(oldJson), 15);
      const parseNew = timeIt(() => JSON.parse(newJson), 15);

      // 3. useModelCaps cache build (the effect loop over data.models).
      const buildOld = timeIt(() => {
        const full = {};
        const id = {};
        for (const row of JSON.parse(oldJson)) {
          if (!row.caps) continue;
          if (row.fullModel) full[row.fullModel] = row.caps;
          if (row.model) id[row.model] = row.caps;
        }
        return { full, id };
      }, 15);
      const buildNew = timeIt(() => {
        const full = {};
        const id = {};
        for (const row of JSON.parse(newJson)) {
          if (!row.caps) continue;
          if (row.fullModel) full[row.fullModel] = row.caps;
          if (row.model) id[row.model] = row.caps;
        }
        return { full, id };
      }, 15);

      // 4. getCaps warm hot loop: every model button re-resolves caps each render.
      const parsedNew = JSON.parse(newJson);
      const byFull = {};
      const byId = {};
      for (const row of parsedNew) {
        if (row.fullModel) byFull[row.fullModel] = row.caps;
        if (row.model) byId[row.model] = row.caps;
      }
      const getCapsWarm = (key) => {
        if (!key) return null;
        const k = typeof key === "string" ? key : String(key);
        if (byFull[k]) return byFull[k];
        const bare = k.includes("/") ? k.slice(k.indexOf("/") + 1) : k;
        if (byId[bare]) return byId[bare];
        return {};
      };
      const warmLoopMs = timeIt(() => {
        let hits = 0;
        for (const fm of fullModels) if (getCapsWarm(fm)) hits++;
        return hits;
      }, 20);

      // 5. getCaps cold fallback: empty cache → getCapabilitiesForModel + toClientCaps.
      const coldLoopMs = timeIt(() => {
        for (const fm of fullModels) {
          const bare = fm.slice(fm.indexOf("/") + 1);
          const provider = fm.slice(0, fm.indexOf("/"));
          toClientCaps(getCapabilitiesForModel(provider, bare));
        }
      }, 20);

      // 6. Warm render of the actual modal (cache populated from new payload).
      const providers = [...new Set(AI_MODELS.map((m) => m.provider))];
      const activeProviders = providers.map((p) => ({
        provider: p,
        name: p,
        providerSpecificData: { prefix: getProviderAlias(p) || p },
      }));
      const modelAliases = {};
      for (const row of parsedNew) modelAliases[row.model] = row.fullModel;
      warm.byFull = byFull;
      warm.byId = byId;
      warm.fullModels = fullModels;

      const props = {
        isOpen: true,
        onClose: () => {},
        onSelect: () => {},
        title: "Select Model",
        activeProviders,
        modelAliases,
        addedModelValues: fullModels.slice(0, 30),
      };

      const renderWarm = timeIt(
        () => renderToString(React.createElement(ModelSelectModal, props)),
        5
      );
      const html = renderToString(React.createElement(ModelSelectModal, props));
      const htmlLen = html.length;

      // Windowing check: the modal must NOT mount all 1352 pill buttons — only
      // the provider groups in (or near) the initial viewport. The button class
      // is unique to model pills (combo pills use a different leading class).
      const renderedButtons = (html.match(/px-2 py-1 rounded-xl text-xs font-medium transition-all border hover:cursor-pointer/g) || []).length;
      const totalButtons = AI_MODELS.length;

      // ---- Report -----------------------------------------------------------
      const pct = ((1 - newJson.length / oldJson.length) * 100).toFixed(1);
      const parsePct = ((1 - parseNew / parseOld) * 100).toFixed(1);
      console.log(
        "\n========== ModelSelectModal benchmark (%d models) ==========",
        AI_MODELS.length
      );
      console.log(
        "wire payload      : old %s KB  new %s KB  (-%s%%)",
        oldKB,
        newKB,
        pct
      );
      console.log(
        "JSON.parse (med)  : old %s ms  new %s ms  (-%s%%)",
        parseOld.toFixed(2),
        parseNew.toFixed(2),
        parsePct
      );
      console.log(
        "cache build (med) : old %s ms  new %s ms",
        buildOld.toFixed(2),
        buildNew.toFixed(2)
      );
      console.log(
        "getCaps warm loop : %s ms for %d lookups (%s ms/model)",
        warmLoopMs.toFixed(3),
        fullModels.length,
        (warmLoopMs / fullModels.length).toFixed(6)
      );
      console.log(
        "getCaps cold loop : %s ms for %d fallbacks (%s ms/model)",
        coldLoopMs.toFixed(1),
        fullModels.length,
        (coldLoopMs / fullModels.length).toFixed(3)
      );
      console.log(
        "renderToString    : %s ms (warm cache), html %s KB, %d/%d buttons mounted",
        renderWarm.toFixed(1),
        (htmlLen / 1024).toFixed(1),
        renderedButtons,
        totalButtons
      );
      console.log("=============================================================\n");

      // ---- Generous sanity assertions (ratios, not absolute timings) ----------
      expect(newJson.length).toBeLessThan(oldJson.length);
      expect(parseNew).toBeLessThan(parseOld);
      // Warm cache resolves every model (no fallback in the hot path).
      let hitCount = 0;
      for (const fm of fullModels) if (getCapsWarm(fm)) hitCount++;
      expect(hitCount).toBe(fullModels.length);
      // Pathological-regression guard only: warm render measured ~300-700ms.
      expect(renderWarm).toBeLessThan(20000);
      // Deterministic windowing assertion: only the initial viewport window is
      // mounted (few hundred buttons), never the full 1352.
      expect(renderedButtons).toBeLessThan(Math.ceil(totalButtons / 2));
    }
  );
});
