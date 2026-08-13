/**
 * Capability adapter: routes requests needing hard input modalities
 * (vision/pdf/audio/video) to a combo member that covers them, or prepends the
 * configured fallback (default "oc/mimo-v2.5-free") when none does — but ONLY
 * when the fallback's capabilities are KNOWN to satisfy the request (unknown
 * capability ≠ capable). Enrichment happens before graph build, so the fallback
 * leaf goes through the same per-key ACL as regular members.
 */

import { describe, it, expect } from "vitest";
import {
  detectRequiredCapabilities,
  applyCapabilityAdapter,
  DEFAULT_CAPABILITY_FALLBACK_MODEL,
} from "../../open-sse/services/combo.js";
import { normalizeComboStrategyConfig } from "../../open-sse/services/comboConfig.js";
import { resolveComboStrategyConfig, buildComboExecutionGraph, authorizeComboExecution } from "../../src/sse/services/comboExecutionPolicy.js";

// oc/mimo-v2.5-free is vision-capable per the `*mimo*v2.5*` pattern (and
// audio/video capable since the audit fix aligned MiMo-V2.5 with models.dev).
// For the refusal test we need a fallback that genuinely lacks audio/video.
const VISION_FALLBACK = DEFAULT_CAPABILITY_FALLBACK_MODEL;
const TEXT_ONLY_FALLBACK = "openai/gpt-4o"; // vision+search, no audio/video caps

describe("detectRequiredCapabilities — audio/video", () => {
  it("detects audio blocks (openai/antropic shapes)", () => {
    for (const type of ["audio_url", "audio", "input_audio"]) {
      const r = detectRequiredCapabilities({ messages: [{ role: "user", content: [{ type }] }] });
      expect(r.has("audioInput")).toBe(true);
    }
  });

  it("detects video blocks", () => {
    for (const type of ["video_url", "video", "input_video"]) {
      const r = detectRequiredCapabilities({ messages: [{ role: "user", content: [{ type }] }] });
      expect(r.has("videoInput")).toBe(true);
    }
  });

  it("detects gemini audio/video mimes (inlineData)", () => {
    const audio = detectRequiredCapabilities({ contents: [{ role: "user", parts: [{ inlineData: { mimeType: "audio/mp3" } }] }] });
    expect(audio.has("audioInput")).toBe(true);
    const video = detectRequiredCapabilities({ contents: [{ role: "user", parts: [{ inlineData: { mimeType: "video/mp4" } }] }] });
    expect(video.has("videoInput")).toBe(true);
    const ogg = detectRequiredCapabilities({ messages: [{ role: "user", content: [{ type: "file", fileData: { mimeType: "application/ogg" } }] }] });
    expect(ogg.has("audioInput")).toBe(true);
  });

  it("does not raise audio/video for plain text or images", () => {
    const r = detectRequiredCapabilities({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] });
    expect(r.has("audioInput")).toBe(false);
    expect(r.has("videoInput")).toBe(false);
    expect(r.has("vision")).toBe(true);
  });

  it("scans only the current (trailing) user turn", () => {
    const r = detectRequiredCapabilities({
      messages: [
        { role: "user", content: [{ type: "audio_url" }] },   // old turn → ignored
        { role: "assistant", content: "ok" },
        { role: "user", content: "plain text" },              // current turn → no media
      ],
    });
    expect(r.has("audioInput")).toBe(false);
  });
});

describe("applyCapabilityAdapter", () => {
  const members = ["deepseek/deepseek-chat", "deepseek/deepseek-reasoner"]; // both lack vision

  it("returns the same array when no hard capability is required", () => {
    expect(applyCapabilityAdapter(members, new Set(), VISION_FALLBACK)).toBe(members);
  });

  it("returns the same array when a member already covers the modalities", () => {
    const withVision = ["anthropic/claude-sonnet-4-6", "deepseek/deepseek-chat"];
    expect(applyCapabilityAdapter(withVision, new Set(["vision"]), VISION_FALLBACK)).toBe(withVision);
  });

  it("prepends the fallback when no member covers vision and the fallback is known-capable", () => {
    const out = applyCapabilityAdapter(members, new Set(["vision"]), VISION_FALLBACK);
    expect(out).not.toBe(members);
    expect(out[0]).toBe(VISION_FALLBACK);
    expect(out.slice(1)).toEqual(members); // original order preserved after
  });

  it("refuses to insert the fallback for audio/video when the fallback cannot handle them", () => {
    // mimo-v2.5-free IS audio/video capable now (models.dev), so it WOULD be
    // inserted for audio/video — the refusal must be tested with a fallback
    // whose capabilities genuinely lack audio/video (unknown ≠ capable).
    expect(applyCapabilityAdapter(members, new Set(["audioInput"]), TEXT_ONLY_FALLBACK)).toBe(members);
    expect(applyCapabilityAdapter(members, new Set(["videoInput"]), TEXT_ONLY_FALLBACK)).toBe(members);
  });

  it("returns the same array when the fallback is already a member", () => {
    const withFallback = [VISION_FALLBACK, "deepseek/deepseek-chat"];
    expect(applyCapabilityAdapter(withFallback, new Set(["vision"]), VISION_FALLBACK)).toBe(withFallback);
  });

  it("adapts single-model combos (no <2 guard)", () => {
    const out = applyCapabilityAdapter(["deepseek/deepseek-chat"], new Set(["vision"]), VISION_FALLBACK);
    expect(out).toEqual([VISION_FALLBACK, "deepseek/deepseek-chat"]);
  });

  it("returns the same array when no fallback is configured", () => {
    expect(applyCapabilityAdapter(members, new Set(["vision"]), "")).toBe(members);
  });
});

describe("comboConfig capabilityAdapter normalization", () => {
  it("defaults enabled to null (inherit global) and fallbackModel to empty", () => {
    const cfg = normalizeComboStrategyConfig({});
    expect(cfg.capabilityAdapter.enabled).toBe(null);
    expect(cfg.capabilityAdapter.fallbackModel).toBe("");
  });

  it("keeps explicit boolean + trims fallbackModel", () => {
    const cfg = normalizeComboStrategyConfig({ capabilityAdapter: { enabled: false, fallbackModel: "  forge/mimo-v2.5  " } });
    expect(cfg.capabilityAdapter.enabled).toBe(false);
    expect(cfg.capabilityAdapter.fallbackModel).toBe("forge/mimo-v2.5");
  });

  it("resolveComboStrategyConfig merges combo config with settings override", () => {
    const combo = { strategyConfig: { fallbackStrategy: "fusion", capabilityAdapter: { enabled: false } } };
    const settings = { capabilityAdapter: { enabled: true, fallbackModel: "x/y" } };
    const cfg = resolveComboStrategyConfig(combo, settings);
    expect(cfg.fallbackStrategy).toBe("fusion");
    expect(cfg.capabilityAdapter.enabled).toBe(true); // settings field wins
    expect(cfg.capabilityAdapter.fallbackModel).toBe("x/y");
  });
});

describe("graph + ACL integration", () => {
  it("fallback leaf flows through authorizeComboExecution (denied when not allowed)", async () => {
    const combo = {
      name: "vision-combo",
      models: ["deepseek/deepseek-chat"], // lacks vision → adapter prepends oc/mimo-v2.5-free
      strategyConfig: { fallbackStrategy: "fallback" },
    };
    const enriched = applyCapabilityAdapter(combo.models, new Set(["vision"]), VISION_FALLBACK);
    expect(enriched[0]).toBe(VISION_FALLBACK);

    const graph = await buildComboExecutionGraph({ ...combo, models: enriched });
    // Fallback is a real leaf (resolves via passthrough registry).
    expect(graph.leaves.some((l) => l.ref === VISION_FALLBACK)).toBe(true);

    // Key allowed combo name + deepseek prefix, but NOT oc/ → the ONLY denied
    // leaf must be the adapter-inserted fallback (proves ACL coverage precisely).
    const authz = authorizeComboExecution({ allowedModels: ["vision-combo", "deepseek/"] }, graph);
    expect(authz.allowed).toBe(false);
    expect(authz.denied).toEqual([VISION_FALLBACK]);
  });

  it("grants when the fallback IS allowed for the key", async () => {
    const combo = {
      name: "vision-combo",
      models: ["deepseek/deepseek-chat"],
      strategyConfig: { fallbackStrategy: "fallback" },
    };
    const enriched = applyCapabilityAdapter(combo.models, new Set(["vision"]), VISION_FALLBACK);
    const graph = await buildComboExecutionGraph({ ...combo, models: enriched });
    const authz = authorizeComboExecution({ allowedModels: ["vision-combo", "deepseek/", "oc/"] }, graph);
    expect(authz.allowed).toBe(true);
  });
});
