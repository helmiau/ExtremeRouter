import { describe, it, expect } from "vitest";
import { FILTERS } from "@/app/api/providers/suggested-models/filters.js";
import REGISTRY from "open-sse/providers/registry/index.js";

// Representative /v1/models payload using the bynara-style shape
// (context_window + vision/reasoning flags).
const META_PAYLOAD = {
  object: "list",
  data: [
    { id: "kimi-k2p7-code", context_window: 262144, vision: true, reasoning: true },
    { id: "deepseek-v4-pro", context_window: 1000000, reasoning: true },
    { id: "glm-5p1", context_window: 202752 },
  ],
};

// OpenAI-style shape using context_length / contextLength / max_model_len.
const LEN_PAYLOAD = {
  data: [
    { id: "a", context_length: 200000, vision: true },
    { id: "b", contextLength: 128000, reasoning: true },
    { id: "c", max_model_len: 32000 },
  ],
};

describe("config-driven gateway parsers (forge / tokenrouter / hcnsec)", () => {
  it.each(["forge", "tokenrouter", "hcnsec"])(
    "%s absorbs context_window/vision/reasoning from /v1/models",
    (key) => {
      const out = FILTERS[key](META_PAYLOAD);
      expect(out).toHaveLength(3);

      const kimi = out.find((m) => m.id === "kimi-k2p7-code");
      expect(kimi.contextLength).toBe(262144);
      expect(kimi.vision).toBe(true);
      expect(kimi.reasoning).toBe(true);

      const deepseek = out.find((m) => m.id === "deepseek-v4-pro");
      expect(deepseek.contextLength).toBe(1000000);
      expect(deepseek.vision).toBe(false); // absent flag coerced to false
      expect(deepseek.reasoning).toBe(true);

      const glm = out.find((m) => m.id === "glm-5p1");
      expect(glm.contextLength).toBe(202752);
      expect(glm.vision).toBe(false);
      expect(glm.reasoning).toBe(false);
    }
  );

  it("also absorbs context_length / contextLength / max_model_len variants", () => {
    for (const key of ["forge", "tokenrouter", "hcnsec"]) {
      const out = FILTERS[key](LEN_PAYLOAD);
      expect(out.find((m) => m.id === "a").contextLength).toBe(200000);
      expect(out.find((m) => m.id === "a").vision).toBe(true);
      expect(out.find((m) => m.id === "b").contextLength).toBe(128000);
      expect(out.find((m) => m.id === "b").reasoning).toBe(true);
      expect(out.find((m) => m.id === "c").contextLength).toBe(32000);
    }
  });

  it("prefers context_window over context_length when both are present", () => {
    const out = FILTERS.forge({
      data: [{ id: "m", context_window: 1000000, context_length: 200000 }],
    });
    expect(out[0].contextLength).toBe(1000000);
  });

  it("skips entries without an id and tolerates non-list payloads", () => {
    for (const key of ["forge", "tokenrouter", "hcnsec"]) {
      expect(FILTERS[key]({ data: [{ context_window: 5 }, { id: "ok", context_window: 1000 }] })).toHaveLength(1);
      expect(FILTERS[key]({})).toEqual([]);
      expect(FILTERS[key](null)).toEqual([]);
    }
  });

  it("openai-style catalogs also absorb context_window and string context values", () => {
    const out = FILTERS.openai({
      data: [
        { id: "m1", context_window: 262144 },              // bynara-style name on an openai-type catalog
        { id: "m2", context_length: "200000" },            // string number → coerced
        { id: "m3", contextLength: "200K" },               // non-numeric string → dropped (no NaNk ctx)
        { id: "m4" },
      ],
    });
    expect(out.find((m) => m.id === "m1").contextLength).toBe(262144);
    expect(out.find((m) => m.id === "m2").contextLength).toBe(200000);
    expect(out.find((m) => m.id === "m3").contextLength).toBeUndefined();
    expect(out.find((m) => m.id === "m4").contextLength).toBeUndefined();
  });

  it("registry points each gateway at its own parser type", () => {
    const cases = [
      ["forge", "forge", "https://forge-gateway-api.fly.dev/v1/models"],
      ["tokenrouter", "tokenrouter", "https://api.tokenrouter.com/v1/models"],
      ["hcnsec", "hcnsec", "https://api.hcnsec.cn/v1/models"],
    ];
    for (const [id, type, url] of cases) {
      const p = REGISTRY.find((entry) => entry.id === id);
      expect(p?.modelsFetcher?.type).toBe(type);
      expect(p?.modelsFetcher?.url).toBe(url);
    }
  });
});
