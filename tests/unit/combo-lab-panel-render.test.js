// @vitest-environment jsdom
// ComboLabPanel renders the what-if strategy comparison. This test guards the
// debounce→fetch path: the normalized weights must be sent as an OBJECT, not a
// function call — regression for "sendableWeights is not a function" (the
// weights were computed via an IIFE but invoked with (), throwing a TypeError
// inside the effect's try/catch and showing the error instead of results).
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

const { default: ComboLabPanel } = await import(
  "../../src/app/(dashboard)/dashboard/combos/components/ComboLabPanel.js"
);

const LAB_RESULT = {
  comparison: [
    {
      strategy: "fusion",
      score: 0.9,
      expectedCalls: 3,
      calls: { min: 3, max: 3 },
      wallClockP95Ms: 1500,
      expectedCostUsd: 0.126,
      reliability: 0.95,
    },
    {
      strategy: "fallback",
      score: 0.6,
      expectedCalls: 1,
      calls: { min: 1, max: 1 },
      wallClockP95Ms: 1200,
      expectedCostUsd: 0.05,
      reliability: 0.9,
    },
  ],
  recommendation: {
    strategy: "fusion",
    score: 0.9,
    reason: "Best on all axes",
    runnerUp: { strategy: "fallback", score: 0.6 },
  },
  dataCoverage: {
    latency: { known: 2, total: 2 },
    reliability: { known: 2, total: 2 },
    cost: { known: 2, total: 2 },
  },
  atRiskProviders: [],
};

let container;
let root;
let fetchMock;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock = vi.fn(async (url) => {
    const u = String(url);
    if (u.startsWith("/api/models/alias")) {
      return { ok: true, json: async () => ({ aliases: {} }) };
    }
    if (u === "/api/models") {
      return {
        ok: true,
        json: async () => ({
          models: [
            { fullModel: "openai/gpt-5.3-codex" },
            { fullModel: "anthropic/claude-opus-4-7" },
          ],
        }),
      };
    }
    if (u === "/api/combos/lab") {
      return { ok: true, json: async () => LAB_RESULT };
    }
    return { ok: false, json: async () => ({ error: `unexpected fetch ${u}` }) };
  });
  globalThis.fetch = fetchMock;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete globalThis.fetch;
});

async function mount(props) {
  await act(async () => root.render(<ComboLabPanel {...props} />));
}

// The panel debounces the lab request by 350ms — wait past it with real timers.
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 400));
  });

describe("ComboLabPanel", () => {
  it("sends weights as an object (no 'sendableWeights is not a function') and renders the comparison", async () => {
    await mount({ activeProviders: [] });

    const input = container.querySelector("input");
    expect(input).toBeTruthy();
    // Use the native value setter so React's value tracker sees the change,
    // then dispatch a real input event (same as fireEvent.input).
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    await act(async () => {
      setValue.call(input, "openai/gpt-5.3-codex, anthropic/claude-opus-4-7");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();

    const labCall = fetchMock.mock.calls.find(([url]) => url === "/api/combos/lab");
    expect(labCall).toBeTruthy();
    const body = JSON.parse(labCall[1].body);
    expect(body.models).toEqual(["openai/gpt-5.3-codex", "anthropic/claude-opus-4-7"]);
    // The regression: weights were an IIFE result invoked as a function.
    expect(typeof body.weights).toBe("object");
    expect(body.weights).toHaveProperty("latency");
    expect(body.weights).toHaveProperty("cost");
    expect(body.weights).toHaveProperty("reliability");

    const text = container.textContent;
    expect(text).not.toMatch(/sendableWeights/);
    expect(text).toMatch(/Recommended/i);
    expect(text).toMatch(/Fusion/);
  });

  it("shows the empty state before any model is entered (no lab request)", async () => {
    await mount({ activeProviders: [] });
    await flush();
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/combos/lab")).toBe(false);
    expect(container.textContent).toMatch(/Enter at least one model/i);
  });
});
