// @vitest-environment jsdom
// Regression: the edit modal must show the EFFECTIVE strategy — settings
// comboStrategies[name] override wins over the combo record's strategyConfig,
// mirroring resolveComboStrategyConfig in comboExecutionPolicy. Previously the
// modal read only combo.strategyConfig.fallbackStrategy, so a combo switched to
// swarm via the ComboCard picker (which writes ONLY settings) kept showing
// "Fallback" when the edit popup opened.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

const { default: ComboFormModal } = await import(
  "../../src/app/(dashboard)/dashboard/combos/components/ComboFormModal.js"
);

const BASE_COMBO = {
  id: "c1",
  name: "swarm-combo",
  models: ["openai/gpt-5.3-codex", "anthropic/claude-opus-4-7"],
  strategyConfig: { fallbackStrategy: "fallback" },
};

let container;
let root;
let fetchMock;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ aliases: {} }) }));
  globalThis.fetch = fetchMock;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete globalThis.fetch;
});

async function mount(props) {
  await act(async () =>
    root.render(
      <ComboFormModal
        isOpen
        onClose={() => {}}
        onSave={vi.fn()}
        activeProviders={[]}
        modelCaps={{}}
        {...props}
      />
    )
  );
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); // flush alias fetch
}

const strategyButton = (label) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent.trim().includes(label));
const isActive = (btn) =>
  btn && btn.className.includes("border-primary/50") && btn.className.includes("bg-primary/10");
const saveButton = () =>
  [...container.querySelectorAll("button")].find((b) => b.textContent.trim().includes("Save Changes"));

describe("ComboFormModal strategy picker (edit)", () => {
  it("shows the settings comboStrategies override (swarm), not the stale record fallback", async () => {
    await mount({
      combo: BASE_COMBO,
      comboStrategies: { "swarm-combo": { fallbackStrategy: "swarm", managerModel: "openai/gpt-5.3-codex" } },
    });
    expect(isActive(strategyButton("Swarm"))).toBe(true);
    expect(isActive(strategyButton("Fallback"))).toBe(false);
  });

  it("falls back to the record strategyConfig when no settings override exists", async () => {
    await mount({
      combo: { ...BASE_COMBO, strategyConfig: { fallbackStrategy: "fusion" } },
      comboStrategies: {},
    });
    expect(isActive(strategyButton("Fusion"))).toBe(true);
  });

  it("defaults to fallback when neither source carries a strategy", async () => {
    await mount({ combo: { ...BASE_COMBO, strategyConfig: {} }, comboStrategies: {} });
    expect(isActive(strategyButton("Fallback"))).toBe(true);
  });

  it("saves a MERGED strategyConfig — record role models/thinking survive — with the chosen strategy", async () => {
    const onSave = vi.fn();
    const recordCfg = {
      fallbackStrategy: "fusion",
      thinking: { type: "high" },
      judgeModel: "openai/gpt-5.3-codex",
    };
    await mount({ combo: { ...BASE_COMBO, strategyConfig: recordCfg }, comboStrategies: {}, onSave });

    await act(async () => strategyButton("Cascade").click());
    await act(async () => saveButton().click());

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "swarm-combo",
        strategyConfig: expect.objectContaining({
          fallbackStrategy: "cascade",
          thinking: { type: "high" }, // record-level config preserved, not wiped
          judgeModel: "openai/gpt-5.3-codex",
        }),
      })
    );
  });
});
