import { describe, it, expect } from "vitest";
import { AI_MODELS } from "@/shared/constants/models";
import { PROVIDER_MODELS } from "open-sse/config/providerModels.js";

// Regression: gemini legitimately lists gemini-2.5-pro/flash/flash-lite twice —
// once as LLM, once as STT (same upstream id, different kind). Those duplicates
// used to flow into the LLM catalog (/api/models → AI_MODELS) and produced
// React duplicate-key warnings in flat consumers (e.g. the Combo Lab datalist):
//   [browser] Encountered two children with the same key, `gemini/gemini-2.5-flash`
describe("catalog uniqueness", () => {
  it("AI_MODELS has no duplicate provider/model refs", () => {
    const seen = new Set();
    const dupes = [];
    for (const m of AI_MODELS) {
      const full = `${m.provider}/${m.model}`;
      if (seen.has(full)) dupes.push(full);
      seen.add(full);
    }
    expect(dupes).toEqual([]);
  });

  it("AI_MODELS still covers the full catalog (no entries lost)", () => {
    const registryCount = Object.entries(PROVIDER_MODELS).reduce(
      (n, [, models]) => n + models.length,
      0
    );
    // AI_MODELS is a deduped projection: unique refs ≤ raw registry entries.
    expect(AI_MODELS.length).toBeGreaterThan(1300);
    expect(AI_MODELS.length).toBeLessThanOrEqual(registryCount);
  });

  it("gemini refs appear exactly once each", () => {
    const gemini = AI_MODELS.filter((m) => m.provider === "gemini");
    for (const id of ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"]) {
      expect(gemini.filter((m) => m.model === id).length).toBe(1);
    }
  });
});
