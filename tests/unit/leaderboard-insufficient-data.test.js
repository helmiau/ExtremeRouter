// @vitest-environment jsdom
// LeaderboardTable must show an "insufficient data" warning instead of a p95
// backed by too few latency samples, and the real value once samples are
// sufficient.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

const { default: LeaderboardTable } = await import(
  "../../src/app/(dashboard)/dashboard/overview/components/LeaderboardTable.js"
);

function leaderboardPayload(rows) {
  return { leaderboard: rows, period: "7d" };
}

let container;
let root;
let fetchMock;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock = vi.fn();
  global.fetch = fetchMock;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function mount() {
  await act(async () => root.render(<LeaderboardTable />));
}

describe("LeaderboardTable insufficient-data guard", () => {
  it("shows 'insufficient data' for a p95 backed by too few samples", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve(
          leaderboardPayload([
            { provider: "openai", displayName: "OpenAI", requests: 5, totalTokens: 100, avgTtft: 300, p95Latency: 1500, latencySampleCount: 3, successRate: 100, cost: 0.01 },
          ])
        ),
    });
    await mount();
    expect(container.textContent).toMatch(/insufficient data/i);
    expect(container.textContent).not.toMatch(/1\.5s/);
  });

  it("shows the real p95 when samples are sufficient", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve(
          leaderboardPayload([
            { provider: "openai", displayName: "OpenAI", requests: 500, totalTokens: 1000, avgTtft: 300, p95Latency: 1500, latencySampleCount: 500, successRate: 100, cost: 0.01 },
          ])
        ),
    });
    await mount();
    expect(container.textContent).toMatch(/1\.5s/);
    expect(container.textContent).not.toMatch(/insufficient data/i);
  });

  it("still shows the value when sampleCount is missing (backward compat)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve(
          leaderboardPayload([
            { provider: "openai", displayName: "OpenAI", requests: 50, totalTokens: 100, avgTtft: 300, p95Latency: 800, successRate: 100, cost: 0.01 },
          ])
        ),
    });
    await mount();
    expect(container.textContent).toMatch(/800ms/);
    expect(container.textContent).not.toMatch(/insufficient data/i);
  });
});
