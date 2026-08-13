import { describe, it, expect } from "vitest";
import { FILTERS } from "@/app/api/providers/suggested-models/filters.js";
import REGISTRY from "open-sse/providers/registry/index.js";

// Real /v1/models payload shape returned by router.bynara.id.
const BYNARA_PAYLOAD = {
  object: "list",
  data: [
    { id: "agnes-2.0-flash", object: "model", owned_by: "byNara", context_window: 512000, weight: 0.1, vision: true, reasoning: true },
    { id: "agnes-2.5-flash", object: "model", owned_by: "byNara", context_window: 512000, weight: 0.2, vision: true, reasoning: true },
    { id: "grok-4.5-free", object: "model", owned_by: "byNara", context_window: 212000, weight: 1, vision: true },
    { id: "laguna-s-2.1", object: "model", owned_by: "byNara", context_window: 262000, weight: 0.5, reasoning: true },
    { id: "ling-3.0-flash-free", object: "model", owned_by: "byNara", context_window: 262000, weight: 1, reasoning: true },
    { id: "mistral-large", object: "model", owned_by: "byNara", context_window: 252000, weight: 1 },
    { id: "mistral-medium-3-5", object: "model", owned_by: "byNara", context_window: 256000, weight: 1, vision: true },
    { id: "nemotron-3-ultra", object: "model", owned_by: "byNara", context_window: 1000000, weight: 0.5 },
    { id: "stepfun-3.7-flash", object: "model", owned_by: "byNara", context_window: 262000, weight: 1, vision: true, reasoning: true },
    { id: "tencent-hy3-free", object: "model", owned_by: "byNara", context_window: 262000, weight: 1 },
  ],
};

describe("bynara modelsFetcher parser", () => {
  it("absorbs context_window, vision and reasoning from /v1/models", () => {
    const out = FILTERS.bynara(BYNARA_PAYLOAD);
    expect(out).toHaveLength(10);

    const agnes = out.find((m) => m.id === "agnes-2.0-flash");
    expect(agnes.contextLength).toBe(512000);
    expect(agnes.vision).toBe(true);
    expect(agnes.reasoning).toBe(true);
    expect(agnes.weight).toBe(0.1);

    const nemotron = out.find((m) => m.id === "nemotron-3-ultra");
    expect(nemotron.contextLength).toBe(1000000);
    expect(nemotron.vision).toBe(false);
    expect(nemotron.reasoning).toBe(false);

    const grok = out.find((m) => m.id === "grok-4.5-free");
    expect(grok.contextLength).toBe(212000);
    expect(grok.vision).toBe(true);
    expect(grok.reasoning).toBe(false);
  });

  it("skips entries without an id", () => {
    const out = FILTERS.bynara({ data: [{ id: "ok-model", context_window: 100000 }, { object: "model" }, { context_window: 5 }] });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("ok-model");
    expect(out[0].contextLength).toBe(100000);
  });

  it("tolerates non-list payloads", () => {
    expect(FILTERS.bynara({})).toEqual([]);
    expect(FILTERS.bynara(null)).toEqual([]);
    expect(FILTERS.bynara(undefined)).toEqual([]);
  });

  it("registry points bynara at the bynara parser", () => {
    const bynara = REGISTRY.find((p) => p.id === "bynara");
    expect(bynara?.modelsFetcher?.url).toBe("https://router.bynara.id/v1/models");
    expect(bynara?.modelsFetcher?.type).toBe("bynara");
  });
});
