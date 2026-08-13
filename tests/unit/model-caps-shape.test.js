import { describe, it, expect } from "vitest";
import { toClientCaps } from "../../src/shared/utils/modelCaps";
import { thinkingLevelsForCaps } from "../../src/app/(dashboard)/dashboard/playground/playgroundCore";
import { classifyComboThinking } from "../../src/shared/utils/comboThinking";

// toClientCaps is the single shape contract shared by /api/models and the
// useModelCaps fallback. It emits ONLY non-default fields (missing key ⇒
// default) to keep the 1352-model catalog small on the wire — these tests pin
// both the compactness and that every UI consumer still gets the right answer.

describe("toClientCaps compact shape", () => {
  it("always carries the badge booleans (default false)", () => {
    const c = toClientCaps({ reasoning: true });
    expect(c).toMatchObject({ vision: false, search: false, pdf: false, audioInput: false, videoInput: false, reasoning: true });
  });

  it("omits default-valued capability flags", () => {
    const c = toClientCaps({ reasoning: true, thinkingCanDisable: true, thinkingFormat: "openai" });
    // thinkingCanDisable defaults true → omitted; consumers use `!== false`.
    expect("thinkingCanDisable" in c).toBe(false);
    expect("tools" in c).toBe(false);
    expect("contextWindow" in c).toBe(false);
  });

  it("emits thinkingCanDisable only when false (model cannot turn thinking off)", () => {
    const canDisable = toClientCaps({ reasoning: true, thinkingCanDisable: true });
    const cannotDisable = toClientCaps({ reasoning: true, thinkingCanDisable: false });
    expect("thinkingCanDisable" in canDisable).toBe(false);
    expect(cannotDisable.thinkingCanDisable).toBe(false);
  });

  it("emits thinkingMaxEffort / thinkingLevels / thinkingFormat only when present", () => {
    const plain = toClientCaps({ reasoning: true, thinkingFormat: "openai" });
    expect("thinkingMaxEffort" in plain).toBe(false);
    expect("thinkingLevels" in plain).toBe(false);
    expect(plain.thinkingFormat).toBe("openai");

    const rich = toClientCaps({ reasoning: true, thinkingMaxEffort: true, thinkingLevels: ["high", "max"], thinkingFormat: "zai" });
    expect(rich.thinkingMaxEffort).toBe(true);
    expect(rich.thinkingLevels).toEqual(["high", "max"]);
  });

  it("emits maxOutput whenever the model has a real output cap", () => {
    expect(toClientCaps({ maxOutput: 65536 }).maxOutput).toBe(65536);
    expect("maxOutput" in toClientCaps({})).toBe(false);
  });

  it("is null-safe", () => {
    expect(toClientCaps(null)).toEqual({});
    expect(toClientCaps(undefined)).toEqual({});
  });
});

describe("consumer safety with the compact shape", () => {
  // ParameterPanel derives thinking levels from the compact caps.
  it("thinkingLevelsForCaps works with omitted thinkingLevels (fallback) and explicit list", () => {
    const caps = toClientCaps({ reasoning: true, thinkingFormat: "openai" });
    expect(thinkingLevelsForCaps(caps)).toEqual(["minimal", "low", "medium", "high"]);
    const capped = toClientCaps({ reasoning: true, thinkingLevels: ["high", "max"], thinkingFormat: "zai" });
    expect(thinkingLevelsForCaps(capped)).toEqual(["high", "max"]);
  });

  // ParameterPanel / ThinkingLevelPicker gate the "none" option on
  // thinkingCanDisable !== false — omitted (default true) must mean "can disable".
  it("omitted thinkingCanDisable is treated as true (can disable) by consumers", () => {
    const caps = toClientCaps({ reasoning: true, thinkingFormat: "openai" });
    expect(caps.thinkingCanDisable !== false).toBe(true);
  });

  // ComboCard classification reads thinkingFormat / thinkingMaxEffort from caps.
  it("classifyComboThinking works with the compact shape", () => {
    const claude = { model: "anthropic/claude-sonnet-5", caps: toClientCaps({ reasoning: true, thinkingFormat: "claude-adaptive" }) };
    const openai = { model: "openai/gpt-5.3", caps: toClientCaps({ reasoning: true, thinkingFormat: "openai" }) };
    const r = classifyComboThinking([claude, openai], "extended");
    expect(r.hasEffort).toBe(true);
    expect(r.hasExtended).toBe(true);
    expect(r.unsupportedForCurrent.map((m) => m.model)).toEqual(["openai/gpt-5.3"]);
  });
});
