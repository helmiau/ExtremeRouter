// @vitest-environment jsdom
// The Freebuff connect modal is a pure paste flow: no browser authorize
// endpoint — the user copies their authToken from freebuff.llm.pm (opened in
// a new tab) or imports it from the CLI credentials file. This test verifies
// the modal renders the token page URL, the import button fills the paste
// box, and manual Connect POSTs the bare token to /api/oauth/freebuff/exchange.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

const { default: OAuthModal } = await import("../../src/shared/components/OAuthModal.js");

const providerInfo = { name: "Freebuff" };

let container;
let root;
let fetchMock;
let openMock;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock = vi.fn(async (url, opts) => {
    const u = String(url);
    if (u.includes("/api/oauth/freebuff/authorize")) {
      return { ok: true, json: async () => ({ authUrl: "https://freebuff.llm.pm" }) };
    }
    if (u.includes("/api/oauth/freebuff/import")) {
      return { ok: true, json: async () => ({ tokenFound: true, token: "cli-token-abc" }) };
    }
    if (u.includes("/api/oauth/freebuff/exchange")) {
      return { ok: true, json: async () => ({ success: true }) };
    }
    return { ok: false, json: async () => ({ error: "unexpected fetch " + u }) };
  });
  globalThis.fetch = fetchMock;
  openMock = vi.fn();
  window.open = openMock;
});

afterEach(() => {
  act(() => root.unmount());
  document.body.removeChild(container);
  vi.clearAllMocks();
});

async function renderModal(props = {}) {
  await act(async () => {
    root.render(
      React.createElement(OAuthModal, {
        isOpen: true,
        provider: "freebuff",
        providerInfo,
        onSuccess: vi.fn(),
        onClose: vi.fn(),
        ...props,
      })
    );
  });
  // Flush the async authorize fetch continuation (startOAuthFlow → setStep).
  await new Promise((resolve) => setTimeout(resolve, 30));
  await act(async () => {});
}

async function findByText(text) {
  return [...container.querySelectorAll("*")].find((el) => el.textContent === text);
}

describe("OAuthModal — freebuff (browser_token paste flow)", () => {
  it("renders the token page URL and goes straight to the paste box", async () => {
    await renderModal();
    // The token page is opened in a new tab.
    expect(openMock).toHaveBeenCalledWith("https://freebuff.llm.pm", "_blank");
    // Paste box + Connect button visible.
    expect(await findByText("Connect")).toBeTruthy();
    const inputs = container.querySelectorAll("input");
    expect(inputs.length).toBeGreaterThan(0);
    // The token page URL is shown as the step-1 copy target.
    const valueInputs = [...inputs].filter((i) => i.value === "https://freebuff.llm.pm");
    expect(valueInputs.length).toBe(1);
  });

  it("imports the CLI token and fills the paste box", async () => {
    await renderModal();
    const importBtn = [...container.querySelectorAll("button")].find((b) =>
      b.textContent.includes("Import token from Freebuff CLI")
    );
    expect(importBtn).toBeTruthy();

    await act(async () => {
      importBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Import GET hit, token landed in the input.
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/oauth/freebuff/import"));
    const input = [...container.querySelectorAll("input")].find((i) => i.value === "cli-token-abc");
    expect(input).toBeTruthy();
  });

  it("submits the pasted bare token to the exchange route", async () => {
    await renderModal();

    // Type a raw token into the paste box.
    const inputs = container.querySelectorAll("input");
    const pasteInput = [...inputs].find((i) => i.placeholder.includes("authToken"));
    expect(pasteInput).toBeTruthy();
    await act(async () => {
      // React tracks the value via the native setter — use it so onChange fires.
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(pasteInput, "tok-manual-1");
      pasteInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const connectBtn = [...container.querySelectorAll("button")].find((b) => b.textContent === "Connect");
    await act(async () => {
      connectBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Bare token POSTed — no URL parsing, no JWT decode branch.
    const exchangeCall = fetchMock.mock.calls.find(([u]) => u.endsWith("/api/oauth/freebuff/exchange"));
    expect(exchangeCall).toBeTruthy();
    const body = JSON.parse(exchangeCall[1].body);
    expect(body.code).toBe("tok-manual-1");
  });

  it("renders nothing when provider info is missing", async () => {
    await renderModal({ providerInfo: null });
    expect(container.textContent).toBe("");
  });
});
