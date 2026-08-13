import { describe, it, expect } from "vitest";
import {
  deriveComboCapabilities,
  memberCapabilitiesForRef,
  UNKNOWN_MEMBER_FLOOR,
} from "../../open-sse/providers/comboCapabilities.js";

// Real members resolved through getCapabilitiesForModel:
//   gpt-5.3           → reasoning, vision.input, search, tools, 400k ctx, 128k out
//   claude-opus-4-7   → reasoning, vision.input, search, tools, 1M ctx, 128k out (text/image-input only — not an image-gen model)
//   llama-4-scout     → vision.input, tools, NO reasoning, 1M ctx, 64k out
//   gpt-image-1       → imageOutput (output modality), NO tools, 200k ctx, 64k out
const A = memberCapabilitiesForRef("openai/gpt-5.3");
const B = memberCapabilitiesForRef("cc/claude-opus-4-7");
const C = memberCapabilitiesForRef("meta/llama-4-scout");
const IMG = memberCapabilitiesForRef("openai/gpt-image-1");

describe("memberCapabilitiesForRef", () => {
  it("resolves alias-prefixed refs", () => {
    expect(memberCapabilitiesForRef("cc/claude-opus-4-7").reasoning).toBe(true);
    expect(memberCapabilitiesForRef("openai/gpt-5.3").reasoning).toBe(true);
  });

  it("resolves bare model names through patterns", () => {
    expect(memberCapabilitiesForRef("claude-sonnet-4.5").reasoning).toBe(true);
    expect(memberCapabilitiesForRef("llama-4-scout").vision).toBe(true);
  });

  it("returns null for empty refs", () => {
    expect(memberCapabilitiesForRef("")).toBeNull();
    expect(memberCapabilitiesForRef(null)).toBeNull();
    expect(memberCapabilitiesForRef("  ")).toBeNull();
  });
});

describe("deriveComboCapabilities", () => {
  it("unions modalities and takes min limits (fusion example)", () => {
    const caps = deriveComboCapabilities([A, B]);
    expect(caps.source).toBe("combo");
    expect(caps.thinking).toBe(true);            // A and B reason
    // claude-opus is text/image-input only in this catalog → output stays false
    expect(caps.vision).toEqual({ input: true, output: false });
    expect(caps.audio).toEqual({ input: false, output: false });
    expect(caps.tools).toBe(true);               // A and B
    expect(caps.contextWindow).toBe(400000);     // min(400k, 1M)
    expect(caps.maxOutput).toBe(128000);         // min(128k, 128k)
  });

  it("unions output modalities when a member generates images", () => {
    const caps = deriveComboCapabilities([A, IMG]);
    expect(caps.vision).toEqual({ input: true, output: true }); // IMG emits
    expect(caps.tools).toBe(true);               // A supports tools (IMG does not)
    expect(caps.contextWindow).toBe(200000);     // min(400k, 200k) — weakest member
    expect(caps.maxOutput).toBe(64000);          // min(128k, 64k)
  });

  it("takes the weakest member's output limit (cascade example)", () => {
    const caps = deriveComboCapabilities([A, B, C]);
    expect(caps.thinking).toBe(true);            // A/B reason even though C does not
    expect(caps.vision).toEqual({ input: true, output: false }); // no image-gen member
    // weakest member wins: llama-4-scout resolves to 64k out in this catalog
    expect(caps.maxOutput).toBe(64000);          // min(128k, 128k, 64k)
    expect(caps.contextWindow).toBe(400000);     // min(400k, 1M, 1M)
  });

  it("strategy off disables thinking even with reasoning members", () => {
    const caps = deriveComboCapabilities([A], { thinking: { type: "off" } });
    expect(caps.thinking).toBe(false);
  });

  it("strategy effort keeps member-derived thinking", () => {
    const caps = deriveComboCapabilities([A], { thinking: { type: "effort", effort: "high" } });
    expect(caps.thinking).toBe(true);
  });

  it("never claims thinking for non-reasoning members (config error stays honest)", () => {
    const caps = deriveComboCapabilities([C], { thinking: { type: "effort", effort: "high" } });
    expect(caps.thinking).toBe(false);
  });

  it("unknown members (null) contribute nothing and drop the limits", () => {
    const caps = deriveComboCapabilities([A, null]);
    expect(caps.thinking).toBe(true);            // A reasons
    expect(caps.vision).toEqual({ input: true, output: false }); // A only
    expect(caps.contextWindow).toBeUndefined();  // unknown member → no verifiable limit
    expect(caps.maxOutput).toBeUndefined();
  });

  it("empty members derive to an empty (false) capability set", () => {
    const caps = deriveComboCapabilities([]);
    expect(caps.thinking).toBe(false);
    expect(caps.vision).toEqual({ input: false, output: false });
    expect(caps.tools).toBe(false);
    expect(caps.contextWindow).toBeUndefined();
    expect(caps.maxOutput).toBeUndefined();
    expect(caps.source).toBe("combo");
  });

  it("propagates agentic/search/pdf/video unions when members carry them", () => {
    const agenticMember = { ...A, agentic: true, pdf: true, videoInput: true };
    const caps = deriveComboCapabilities([agenticMember, C]);
    expect(caps.agentic).toBe(true);
    expect(caps.pdf).toBe(true);
    expect(caps.videoInput).toBe(true);
    expect(caps.search).toBe(true); // A has search
  });

  it("exposes UNKNOWN_MEMBER_FLOOR for callers that know a member is unknown", () => {
    expect(UNKNOWN_MEMBER_FLOOR.reasoning).toBe(false);
    expect(UNKNOWN_MEMBER_FLOOR.tools).toBe(false);
    expect(UNKNOWN_MEMBER_FLOOR.contextWindow).toBeNull();
    expect(UNKNOWN_MEMBER_FLOOR.maxOutput).toBeNull();
  });
});
