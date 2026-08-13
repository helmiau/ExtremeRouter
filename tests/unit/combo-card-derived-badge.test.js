// @vitest-environment jsdom
// ComboCard shows a combo-level capability badge derived from members
// (modelCaps[combo.name], served by /api/models combo entries). This test
// verifies the badge renders with the derived caps and that missing caps do
// not crash the card.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

const { default: ComboCard } = await import(
  "../../src/app/(dashboard)/dashboard/combos/components/ComboCard.js"
);

function baseProps(overrides = {}) {
  return {
    combo: { id: "c1", name: "squad-review", models: ["openai/gpt-5.3", "cc/claude-opus-4-7"] },
    modelCaps: {
      "squad-review": { vision: true, reasoning: true, audioInput: false, videoInput: false, pdf: false, search: true },
      "openai/gpt-5.3": { vision: true, reasoning: true, search: true },
      "cc/claude-opus-4-7": { vision: true, reasoning: true, search: true },
    },
    activeProviders: [],
    copied: null,
    onCopy: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    strategy: { fallbackStrategy: "fusion" },
    onSetStrategy: vi.fn(),
    ...overrides,
  };
}

let container;
let root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function mount(props) {
  await act(async () => root.render(<ComboCard {...props} />));
}

describe("ComboCard derived capability badge", () => {
  it("renders the aggregate badge with a derived hint when combo caps exist", async () => {
    await mount(baseProps());
    const text = container.textContent;
    expect(text).toMatch(/derived/i);
    // The collapsed header holds the aggregate badge icons (vision + reasoning
    // + search from the derived caps) — at least the three monochrome icons.
    expect(text).toMatch(/squad-review/);
  });

  it("renders without crashing when the combo has no caps entry", async () => {
    await mount(baseProps({ modelCaps: {} }));
    expect(container.textContent).toMatch(/squad-review/);
    expect(container.textContent).not.toMatch(/derived/i);
  });

  it("renders without crashing for a combo with no models", async () => {
    await mount(baseProps({ combo: { id: "c2", name: "empty", models: [] } }));
    expect(container.textContent).toMatch(/empty/);
  });
});
