// @vitest-environment jsdom
// Windowing behavior of CompatibleModelsSection: long user-imported model
// catalogs mount only the visible slice; short lists keep the inline layout.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { describe, it, expect, beforeEach } from "vitest";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

const { default: CompatibleModelsSection } = await import(
  "@/app/(dashboard)/dashboard/providers/[id]/CompatibleModelsSection"
);

const ROW_RE = /text-sm font-medium truncate/g;
const countRows = (root) => (root.innerHTML.match(ROW_RE) || []).length;

const makeProps = (count) => ({
  providerStorageAlias: "myprov",
  providerDisplayAlias: "myprov",
  modelAliases: {},
  customModels: Array.from({ length: count }, (_, i) => ({
    id: `model-${i}`,
    name: `Model ${i}`,
    providerAlias: "myprov",
  })),
  copied: "",
  onCopy: () => {},
  onDeleteAlias: () => {},
  onAddCustomModel: async () => {},
  onDeleteCustomModel: async () => {},
  connections: [],
  isAnthropic: false,
});

describe("CompatibleModelsSection windowing", () => {
  let container;
  let root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  const renderSection = (props) =>
    act(async () => {
      root.render(React.createElement(CompatibleModelsSection, props));
    });

  it("mounts only the visible window for a long list, then moves it on scroll", async () => {
    await renderSection(makeProps(200));

    const mounted = countRows(container);
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(100); // windowed, not all 200
    // Long list → contained scroll area exists.
    const scroller = container.querySelector(".max-h-\\[480px\\]");
    expect(scroller).toBeTruthy();

    // First row visible initially.
    expect(container.innerHTML).toContain("model-0");

    // Scroll to the bottom: window moves to the last rows, still windowed.
    await act(async () => {
      scroller.scrollTop = 10 ** 6;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    const after = countRows(container);
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(100);
    expect(container.innerHTML).toContain("model-199");
    expect(container.innerHTML).not.toContain("model-0");
    // Spacers preserve the scrollbar (clamped to the estimated total).
    expect(container.querySelectorAll("div[aria-hidden]").length).toBeGreaterThan(0);
  });

  it("renders short lists inline (no scroll container, no windowing)", async () => {
    await renderSection(makeProps(10));
    expect(countRows(container)).toBe(10);
    expect(container.querySelector(".max-h-\\[480px\\]")).toBeNull();
  });
});
