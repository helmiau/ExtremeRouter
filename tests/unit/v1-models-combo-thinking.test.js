import { describe, it, expect, vi } from "vitest";

// The route reads combos/settings from the live DB. Mock the data layer so the
// test is deterministic and does not depend on the machine's combos.
const mocks = vi.hoisted(() => ({
  getCombos: vi.fn(),
  getSettings: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getCombos: mocks.getCombos,
  getSettings: mocks.getSettings,
  getProviderConnections: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
}));

vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: vi.fn(async () => []),
}));

const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");

function comboEntry(name, strategyConfig, models) {
  return {
    id: crypto.randomUUID(),
    name,
    models: models || ["anthropic/claude-sonnet-4.5"], // reasoning member by default
    strategyConfig,
  };
}

describe("v1/models combo thinking exposure", () => {
  it("derives thinking from a reasoning member even with an auto strategy", async () => {
    mocks.getCombos.mockResolvedValue([
      comboEntry("extremecombos", { thinking: { type: "auto" } }),
    ]);
    mocks.getSettings.mockResolvedValue({});

    const list = await buildModelsList(["llm"]);
    const combo = list.find((m) => m.owned_by === "combo" && m.id === "extremecombos");
    expect(combo).toBeDefined();
    expect(combo.capabilities).toEqual({ thinking: true, agentic: false });
    // auto = no strategy override → no strategy field
    expect(combo.strategy).toBeUndefined();
  });

  it("keeps thinking true for a non-auto strategy with reasoning members and exposes strategy intent", async () => {
    mocks.getCombos.mockResolvedValue([
      comboEntry("extremecombos", { thinking: { type: "effort", effort: "high" } }),
    ]);
    mocks.getSettings.mockResolvedValue({});

    const list = await buildModelsList(["llm"]);
    const combo = list.find((m) => m.owned_by === "combo" && m.id === "extremecombos");
    expect(combo.capabilities).toEqual({ thinking: true, agentic: false });
    expect(combo.strategy).toEqual({ thinking: { type: "effort" } });
  });

  it("applies the settings comboStrategies override when merging", async () => {
    mocks.getCombos.mockResolvedValue([
      comboEntry("extremecombos", { thinking: { type: "auto" } }),
    ]);
    mocks.getSettings.mockResolvedValue({
      comboStrategies: { extremecombos: { thinking: { type: "effort", effort: "max" } } },
    });

    const list = await buildModelsList(["llm"]);
    const combo = list.find((m) => m.owned_by === "combo" && m.id === "extremecombos");
    expect(combo).toBeDefined();
    expect(combo.capabilities).toEqual({ thinking: true, agentic: false });
    expect(combo.strategy).toEqual({ thinking: { type: "effort" } });
  });

  it("does NOT advertise thinking when the strategy explicitly disables it (off)", async () => {
    mocks.getCombos.mockResolvedValue([
      comboEntry("off-combo", { thinking: { type: "off" } }),
    ]);
    mocks.getSettings.mockResolvedValue({});

    const list = await buildModelsList(["llm"]);
    const combo = list.find((m) => m.owned_by === "combo" && m.id === "off-combo");
    expect(combo.capabilities).toEqual({ thinking: false, agentic: false });
    expect(combo.strategy).toEqual({ thinking: { type: "off" } });
  });

  it("never advertises thinking for combos whose members cannot reason (config error stays honest)", async () => {
    mocks.getCombos.mockResolvedValue([
      comboEntry("text-only", { thinking: { type: "effort", effort: "high" } }, ["openai/gpt-3.5-turbo"]),
    ]);
    mocks.getSettings.mockResolvedValue({});

    const list = await buildModelsList(["llm"]);
    const combo = list.find((m) => m.owned_by === "combo" && m.id === "text-only");
    expect(combo.capabilities).toEqual({ thinking: false, agentic: false });
    // strategy intent still visible — the client sees the mismatch instead of a lie
    expect(combo.strategy).toEqual({ thinking: { type: "effort" } });
  });

  it("reports thinking false for auto-strategy combos with only non-reasoning members", async () => {
    mocks.getCombos.mockResolvedValue([
      comboEntry("plain", {}, ["openai/gpt-3.5-turbo"]),
    ]);
    mocks.getSettings.mockResolvedValue({});

    const list = await buildModelsList(["llm"]);
    const combo = list.find((m) => m.owned_by === "combo" && m.id === "plain");
    expect(combo.capabilities).toEqual({ thinking: false, agentic: false });
    expect(combo.strategy).toBeUndefined();
  });

  it("resolves bare model names (no provider prefix) through the pattern fallback", async () => {
    mocks.getCombos.mockResolvedValue([
      comboEntry("bare", {}, ["claude-sonnet-4.5"]),
    ]);
    mocks.getSettings.mockResolvedValue({});

    const list = await buildModelsList(["llm"]);
    const combo = list.find((m) => m.owned_by === "combo" && m.id === "bare");
    expect(combo.capabilities).toEqual({ thinking: true, agentic: false });
  });
});
