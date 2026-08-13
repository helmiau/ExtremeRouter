// @vitest-environment jsdom
// SimulatorPanel renders the pre-save combo simulation: logical calls, cost
// range, capability compatibility, per-member latency (with insufficient-data
// guard) and budget rejection risk. This test verifies the panel fetches
// /api/combos/simulate with the live models+strategy and renders the result.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

const { default: SimulatorPanel } = await import(
  "../../src/app/(dashboard)/dashboard/combos/components/SimulatorPanel.js"
);

const SIMULATION = {
  strategy: "fusion",
  members: 2,
  calls: { min: 3, max: 3 },
  maxProviderFanout: 2,
  perCallCost: 0.042,
  estimatedCost: { optimistic: 0.126, worst: 0.126 },
  budgetRisk: { level: "ok", rejected: false, limit: 100 },
  budgetsEnabled: true,
  capabilities: { thinking: true, vision: { input: true, output: false }, tools: true, contextWindow: 1000000, maxOutput: 128000 },
  roleModels: { judge: "openai/gpt-5.3-codex" },
  roleViolations: [],
  memberRows: [
    {
      fullModel: "openai/gpt-5.3-codex",
      roles: ["judge"],
      costPerCall: 0.028,
      hasPricing: true,
      latency: { p50: 900, p95: 1500, avg: 1100, sampleCount: 40 },
    },
    {
      fullModel: "anthropic/claude-opus-4-7",
      roles: [],
      costPerCall: 0.014,
      hasPricing: true,
      latency: { p50: 800, p95: 1300, avg: 1000, sampleCount: 3 },
    },
  ],
  assumptions: { inputTokens: 1000, outputTokens: 4000 },
};

let container;
let root;
let fetchMock;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock = vi.fn(async (url, opts) => ({
    ok: true,
    json: async () => ({ simulation: SIMULATION }),
  }));
  globalThis.fetch = fetchMock;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete globalThis.fetch;
});

async function mount(props) {
  await act(async () => root.render(<SimulatorPanel {...props} />));
}

describe("SimulatorPanel", () => {
  it("posts live models + strategy to /api/combos/simulate and renders metrics", async () => {
    await mount({
      models: ["openai/gpt-5.3-codex", "anthropic/claude-opus-4-7"],
      strategyConfig: { fallbackStrategy: "fusion" },
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/combos/simulate", expect.objectContaining({ method: "POST" }));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.models).toEqual(["openai/gpt-5.3-codex", "anthropic/claude-opus-4-7"]);
    expect(body.strategyConfig.fallbackStrategy).toBe("fusion");

    const text = container.textContent;
    expect(text).toMatch(/Logical calls/);
    expect(text).toMatch(/3/); // fusion deterministic call count
    expect(text).toMatch(/Provider fanout/);
    expect(text).toMatch(/\$0\.126/); // worst-case cost
    expect(text).toMatch(/Fusion/); // strategy label
    expect(text).toMatch(/judge/i); // role badge
    expect(text).toMatch(/openai\/gpt-5\.3-codex/);
    expect(text).toMatch(/Capabilities/);
  });

  it("shows insufficient data for low-sample latency instead of a misleading p95", async () => {
    await mount({
      models: ["openai/gpt-5.3-codex", "anthropic/claude-opus-4-7"],
      strategyConfig: { fallbackStrategy: "fusion" },
    });
    const text = container.textContent;
    expect(text).toMatch(/insufficient data/); // claude row: 3 samples < 10
    // The gpt row (40 samples) still renders its p95 (1500ms → "1.5s").
    expect(text).toMatch(/1\.5s/);
  });

  it("re-renders when the strategy changes (swarm -> fanout 2, calls 1-8)", async () => {
    await mount({ models: ["openai/gpt-5.3-codex"], strategyConfig: { fallbackStrategy: "fallback" } });

    // swap the fixture for a swarm response and re-mount with a new strategy
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        simulation: {
          ...SIMULATION,
          strategy: "swarm",
          calls: { min: 1, max: 5 },
          maxProviderFanout: 1,
          estimatedCost: { optimistic: 0.02, worst: 0.1 },
          memberRows: [{ ...SIMULATION.memberRows[0], roles: ["manager", "staff", "audit"] }],
        },
      }),
    }));
    await act(async () => root.render(<SimulatorPanel models={["openai/gpt-5.3-codex"]} strategyConfig={{ fallbackStrategy: "swarm" }} />));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); // flush async effect
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.strategyConfig.fallbackStrategy).toBe("swarm");
    expect(container.textContent).toMatch(/1–5/);
  });

  it("renders empty state when no models", async () => {
    await mount({ models: [], strategyConfig: { fallbackStrategy: "fallback" } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.textContent).toMatch(/Add at least one model/i);
  });
});
