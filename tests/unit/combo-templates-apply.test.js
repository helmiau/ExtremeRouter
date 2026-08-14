// @vitest-environment jsdom
// Regression: applying a template must POST the RESOLVED strategyConfig (role
// models → alias/model) so /api/combos runs validateComboRoles against the
// template's real strategy. Before the fix, the POST carried no strategyConfig,
// so a role-invalid combo (e.g. web-cookie swarm manager) was created silently
// and only failed at runtime. Also verifies the settings PATCH payload shape.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

const { default: ComboTemplatesTab } = await import(
  "../../src/app/(dashboard)/dashboard/combos/components/ComboTemplatesTab.js"
);

let container;
let root;
let fetchMock;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock = vi.fn(async (url, opts) => {
    if (String(url).startsWith("/api/combos") && opts?.method === "POST") {
      return { ok: true, json: async () => ({ id: "new-combo" }) };
    }
    if (String(url).startsWith("/api/settings") && opts?.method === "PATCH") {
      return { ok: true, json: async () => ({}) };
    }
    return { ok: false, json: async () => ({ error: `unexpected fetch ${url}` }) };
  });
  globalThis.fetch = fetchMock;
  globalThis.alert = vi.fn();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete globalThis.fetch;
  delete globalThis.alert;
});

async function mount(props) {
  await act(async () => root.render(<ComboTemplatesTab {...props} />));
}

describe("ComboTemplatesTab apply flow", () => {
  it("posts the resolved strategyConfig so the server validates control roles", async () => {
    const onApply = vi.fn();
    await mount({
      combos: [],
      connections: [
        { provider: "claude", isActive: true },
        { provider: "codex", isActive: true },
        { provider: "glm", isActive: true },
        { provider: "kiro", isActive: true },
      ],
      modelIndex: {
        "claude-opus-4-7": ["cc"],
        "gpt-5.4": ["cx"],
        "glm-5.1": ["glm"],
        "claude-sonnet-4.5": ["kr"],
      },
      onApply,
    });

    // Only Max Reasoning Swarm is fully available with these connections, so
    // exactly one enabled "Apply Template" button exists.
    const applyBtn = [...container.querySelectorAll("button")].find(
      (b) => b.textContent.includes("Apply Template") && !b.disabled
    );
    expect(applyBtn).toBeTruthy();
    await act(async () => applyBtn.click());

    const postCall = fetchMock.mock.calls.find(
      ([url, opts]) => String(url).startsWith("/api/combos") && opts?.method === "POST"
    );
    expect(postCall).toBeTruthy();
    const body = JSON.parse(postCall[1].body);
    expect(body.name).toBe("Max Reasoning Swarm");
    expect(body.kind).toBe("llm");
    expect(body.models).toEqual([
      "cc/claude-opus-4-7",
      "cx/gpt-5.4",
      "glm/glm-5.1",
      "kr/claude-sonnet-4.5",
    ]);
    // The regression: role models must be resolved (alias/model) in the POST so
    // POST /api/combos → validateComboRoles checks them with the real strategy.
    expect(body.strategyConfig).toBeDefined();
    expect(body.strategyConfig.fallbackStrategy).toBe("swarm");
    expect(body.strategyConfig.managerModel).toBe("cc/claude-opus-4-7");
    expect(body.strategyConfig.auditModel).toBe("kr/claude-sonnet-4.5");
    expect(body.strategyConfig.autoScale).toEqual({ enabled: true, minWorkers: 2, maxWorkers: 4 });

    // Settings PATCH mirrors the strategy (deep-merged per combo name server-side).
    const patchCall = fetchMock.mock.calls.find(
      ([url, opts]) => String(url).startsWith("/api/settings") && opts?.method === "PATCH"
    );
    expect(patchCall).toBeTruthy();
    const patchBody = JSON.parse(patchCall[1].body);
    expect(patchBody).toEqual({
      comboStrategies: { "Max Reasoning Swarm": body.strategyConfig },
    });

    expect(onApply).toHaveBeenCalled();
  });
});
