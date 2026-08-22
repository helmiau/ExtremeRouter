/**
 * Regression tests for the Cline provider's model-ID format.
 *
 * Cline uses the OpenRouter-style `{vendor}/{model}` convention, where the
 * suffix is each vendor's NATIVE id verbatim. That means Anthropic entries use
 * DASHES for the version (`anthropic/claude-sonnet-4-6`, matching Anthropic's
 * own API), while OpenAI/Google/MiniMax keep their native DOTS
 * (`openai/gpt-4o`, `google/gemini-2.5-pro`, `minimax/minimax-m2.5`).
 *
 * A previous revision stored the Anthropic ids with dots
 * (`anthropic/claude-sonnet-4.6`), which the Cline API rejects. These tests
 * lock the convention so the regression cannot silently return.
 *
 * Source of truth: https://docs.cline.bot/api/models
 */

import { describe, it, expect } from "vitest";
import { PROVIDER_MODELS, getModelsByProviderId } from "../../open-sse/config/providerModels.js";
import clineRegistry from "../../open-sse/providers/registry/cline.js";

const clineModels = () => getModelsByProviderId("cline");
const ids = () => clineModels().map((m) => m.id);

describe("Cline model-ID format", () => {
  it("registers Anthropic models with dashed version ids", () => {
    const expected = [
      "anthropic/claude-opus-4-7",
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-opus-4-6",
      "anthropic/claude-3-7-sonnet",
    ];
    for (const id of expected) expect(ids()).toContain(id);
  });

  it("never emits a dotted Anthropic version id (upstream rejects these)", () => {
    const dotted = ids().filter((id) => /^anthropic\/.*\d\.\d/.test(id));
    expect(dotted).toEqual([]);
  });

  it("preserves native dots for non-Anthropic vendors", () => {
    for (const id of ["openai/gpt-4o", "google/gemini-2.5-pro", "minimax/minimax-m2.5", "deepseek/deepseek-chat"]) {
      expect(ids()).toContain(id);
    }
  });

  it("uses the {vendor}/{model} shape for every entry (bare ids are aliases with upstreamModelId)", () => {
    for (const id of ids()) {
      if (/^[a-z0-9-]+\/.+/.test(id)) continue; // canonical vendor/id form
      // Bare ids are allowed ONLY as aliases that remap to a vendor-prefixed upstream.
      const entry = clineModels().find((m) => m.id === id);
      expect(entry?.upstreamModelId, `${id} must define upstreamModelId`).toBeDefined();
      expect(entry.upstreamModelId).toMatch(/^[a-z0-9-]+\/.+/);
    }
  });

  it("keeps the documented free-tier model available", () => {
    const free = clineModels().find((m) => m.id === "minimax/minimax-m2.5");
    expect(free).toBeDefined();
    expect(free.name).toMatch(/free/i);
  });

  it("enables passthrough so rotating free/promo ids work without a release", () => {
    expect(clineRegistry.passthroughModels).toBe(true);
  });

  it("does not regress previously shipped models", () => {
    for (const id of [
      "openai/gpt-5.3-codex",
      "openai/gpt-5.4",
      "google/gemini-3.1-pro-preview",
      "google/gemini-3.1-flash-lite-preview",
      "kwaipilot/kat-coder-pro",
    ]) {
      expect(ids()).toContain(id);
    }
  });

  it("keeps clinepass separate — its open-weight ids legitimately use dots", () => {
    const cp = (PROVIDER_MODELS.clinepass || []).map((m) => m.id);
    expect(cp).toContain("cline-pass/glm-5.2");
    expect(cp.every((id) => id.startsWith("cline-pass/") || id.includes("/"))).toBe(true);
  });
});
