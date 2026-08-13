// @vitest-environment jsdom
// Interaction test for the windowed provider-group list in ModelSelectModal:
// mounting renders only the initial viewport window, scrolling moves the
// window, and the spacer-based scrollbar keeps its height.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { AI_MODELS } from "@/shared/constants/config";
import { getProviderAlias } from "@/shared/constants/providers";

const warm = vi.hoisted(() => ({ byFull: {}, byId: {} }));

vi.mock("@/shared/hooks/useModelCaps", () => ({
  useModelCaps: () => ({
    getCaps: (key) => {
      if (!key) return null;
      const k = typeof key === "string" ? key : String(key);
      if (warm.byFull[k]) return warm.byFull[k];
      const bare = k.includes("/") ? k.slice(k.indexOf("/") + 1) : k;
      if (warm.byId[bare]) return warm.byId[bare];
      return {};
    },
  }),
}));

const { default: ModelSelectModal } = await import(
  "@/shared/components/ModelSelectModal"
);

const BUTTON_RE =
  /px-2 py-1 rounded-xl text-xs font-medium transition-all border hover:cursor-pointer/g;

const countButtons = (root) => (root.innerHTML.match(BUTTON_RE) || []).length;

describe("ModelSelectModal windowing", () => {
  let container;
  let root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const fullModels = AI_MODELS.map((m) => `${m.provider}/${m.model}`);
    for (const fm of fullModels) {
      const bare = fm.slice(fm.indexOf("/") + 1);
      warm.byFull[fm] = { vision: true };
      warm.byId[bare] = { vision: true };
    }
  });

  const renderModal = () => {
    const providers = [...new Set(AI_MODELS.map((m) => m.provider))];
    const modelAliases = {};
    for (const m of AI_MODELS) {
      const fm = `${m.provider}/${m.model}`;
      modelAliases[m.model] = fm;
    }
    return act(async () => {
      root.render(
        React.createElement(ModelSelectModal, {
          isOpen: true,
          onClose: () => {},
          onSelect: () => {},
          title: "Select Model",
          activeProviders: providers.map((p) => ({
            provider: p,
            name: p,
            providerSpecificData: { prefix: getProviderAlias(p) || p },
          })),
          modelAliases,
        })
      );
    });
  };

  it("mounts only the initial viewport window, then moves it on scroll", async () => {
    await renderModal();

    const total = AI_MODELS.length;
    const scroller = container.querySelector(".max-h-\\[400px\\]");
    expect(scroller).toBeTruthy();

    const initialButtons = countButtons(container);
    expect(initialButtons).toBeGreaterThan(0);
    expect(initialButtons).toBeLessThan(Math.ceil(total / 2));
    // Spacers preserve scrollbar height: at the top only a bottom spacer exists
    // (jsdom does no layout, so scrollHeight/offsetHeight are always 0).
    const spacers = container.querySelectorAll('div[aria-hidden]');
    expect(spacers.length).toBeGreaterThan(0);

    // First provider header is visible initially.
    const firstHeader = container.querySelector(
      '.sticky.top-0 span[class*="text-xs font-medium text-primary"]'
    );
    const firstHeaderText = firstHeader?.textContent || "";
    expect(firstHeaderText.length).toBeGreaterThan(0);

    // Scroll far down: the window must move (first header disappears), the
    // button count stays windowed, and the scrollbar height is preserved.
    await act(async () => {
      scroller.scrollTop = 10 ** 6;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    const scrolledButtons = countButtons(container);
    expect(scrolledButtons).toBeGreaterThan(0);
    expect(scrolledButtons).toBeLessThan(Math.ceil(total / 2));

    const firstHeaderAfter = container.querySelector(
      '.sticky.top-0 span[class*="text-xs font-medium text-primary"]'
    );
    // The window moved past the first group.
    expect(firstHeaderAfter?.textContent || "").not.toBe(firstHeaderText);

    // Spacers still hold the scrollbar after the window moved.
    expect(container.querySelectorAll('div[aria-hidden]').length).toBeGreaterThan(0);
  });
});
