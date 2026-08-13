import { describe, it, expect, vi } from "vitest";

// /api/models reads aliases/disabled/combos/settings from the DB layer and the
// static AI_MODELS catalog. Mock the data layers so the test is deterministic.
const mocks = vi.hoisted(() => ({
  getModelAliases: vi.fn(),
  getDisabledModels: vi.fn(),
  getCombos: vi.fn(),
  getSettings: vi.fn(),
}));

vi.mock("@/models", () => ({
  getModelAliases: mocks.getModelAliases,
  setModelAlias: vi.fn(),
}));

vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: mocks.getDisabledModels,
}));

vi.mock("@/lib/localDb", () => ({
  getCombos: mocks.getCombos,
  getSettings: mocks.getSettings,
}));

// Small static catalog for the test — member caps resolve through the real
// getCapabilitiesForModel table.
vi.mock("@/shared/constants/config", () => ({
  AI_MODELS: [
    { provider: "openai", model: "gpt-5.3" },
    { provider: "claude", model: "claude-opus-4-7" },
  ],
}));

const { GET } = await import("../../src/app/api/models/route.js");

function combo(name, models, strategyConfig, kind) {
  const c = { id: crypto.randomUUID(), name, models, strategyConfig };
  if (kind) c.kind = kind;
  return c;
}

beforeEach(() => {
  mocks.getModelAliases.mockResolvedValue({});
  mocks.getDisabledModels.mockResolvedValue([]);
  mocks.getSettings.mockResolvedValue({});
});

describe("GET /api/models combo entries", () => {
  it("emits combo entries with member-derived caps", async () => {
    mocks.getCombos.mockResolvedValue([
      combo("squad-review", ["openai/gpt-5.3", "cc/claude-opus-4-7"], { thinking: { type: "auto" } }),
    ]);

    const res = await GET();
    const { models } = await res.json();
    const entry = models.find((m) => m.provider === "combo" && m.fullModel === "squad-review");

    expect(entry).toBeDefined();
    expect(entry.model).toBe("squad-review");
    // union: both members reason + take images; claude-opus emits images
    expect(entry.caps.reasoning).toBe(true);
    expect(entry.caps.vision).toBe(true);
    // min output limit of the two members (both 128k)
    expect(entry.caps.maxOutput).toBe(128000);
  });

  it("applies the settings comboStrategies override (thinking off drops reasoning)", async () => {
    mocks.getCombos.mockResolvedValue([
      combo("off-combo", ["openai/gpt-5.3"], { thinking: { type: "auto" } }),
    ]);
    mocks.getSettings.mockResolvedValue({
      comboStrategies: { "off-combo": { thinking: { type: "off" } } },
    });

    const res = await GET();
    const { models } = await res.json();
    const entry = models.find((m) => m.provider === "combo" && m.fullModel === "off-combo");
    expect(entry.caps.reasoning).toBe(false);
  });

  it("skips media/web combos (LLM catalog only)", async () => {
    mocks.getCombos.mockResolvedValue([
      combo("img-combo", ["openai/gpt-5.3"], {}, "tts"),
      combo("search-combo", [], {}, "webSearch"),
    ]);

    const res = await GET();
    const { models } = await res.json();
    expect(models.some((m) => m.provider === "combo")).toBe(false);
  });

  it("still returns provider models alongside combo entries", async () => {
    mocks.getCombos.mockResolvedValue([]);
    const res = await GET();
    const { models } = await res.json();
    expect(models.length).toBe(2);
    expect(models.some((m) => m.fullModel === "openai/gpt-5.3")).toBe(true);
    expect(models.some((m) => m.fullModel === "claude/claude-opus-4-7")).toBe(true);
  });
});
