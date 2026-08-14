// @vitest-environment jsdom
// The Freebuff connect modal uses the guided browser-login (device_code) flow:
// it asks /api/oauth/freebuff/device-code for a fingerprint-bound login URL,
// opens it in the browser, and polls /api/oauth/freebuff/poll until the user
// authenticates on freebuff.com. A paste/import fallback stays visible so
// users with an existing authToken (CLI credentials or freebuff.llm.pm) can
// connect without re-logging.
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

const LOGIN_URL = "https://freebuff.com/login?auth_code=xyz";

function deviceCodeResponse(overrides = {}) {
  return {
    device_code: "freebuff-go-abc123",
    user_code: "",
    verification_uri: LOGIN_URL,
    verification_uri_complete: LOGIN_URL,
    expires_in: 300,
    interval: 1,
    fingerprintHash: "hash-1",
    expiresAt: 1786669488159,
    ...overrides,
  };
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock = vi.fn(async (url, opts) => {
    const u = String(url);
    if (u.includes("/api/oauth/freebuff/device-code")) {
      return { ok: true, json: async () => deviceCodeResponse() };
    }
    if (u.includes("/api/oauth/freebuff/poll")) {
      return { ok: true, json: async () => ({ success: true }) };
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
  // Flush the async device-code fetch continuation (startOAuthFlow → setStep).
  await new Promise((resolve) => setTimeout(resolve, 30));
  await act(async () => {});
}

async function findByText(text) {
  return [...container.querySelectorAll("*")].find((el) => el.textContent === text);
}

describe("OAuthModal — freebuff (guided browser-login flow)", () => {
  it("opens the browser login URL and shows the paste fallback", async () => {
    await renderModal();
    // The login URL (freebuff.com, not the token page) is auto-opened.
    expect(openMock).toHaveBeenCalledWith(LOGIN_URL, "_blank", "noopener,noreferrer");
    // The login URL is rendered with an Open button (icon glyph included in text).
    const openBtn = [...container.querySelectorAll("button")].find((b) => b.textContent.includes("Open"));
    expect(openBtn).toBeTruthy();
    const urlCodes = [...container.querySelectorAll("code")].filter((c) => c.textContent === LOGIN_URL);
    expect(urlCodes.length).toBeGreaterThan(0);
    // Paste fallback + Connect button visible for users with an existing token.
    expect(await findByText("Connect")).toBeTruthy();
    const importBtn = [...container.querySelectorAll("button")].find((b) => b.textContent.includes("Import token from Freebuff CLI"));
    expect(importBtn).toBeTruthy();
  });

  it("connects automatically once the browser login completes", async () => {
    const onSuccess = vi.fn();
    await renderModal({ onSuccess });
    // Poll succeeds on the first call after the interval sleep.
    await new Promise((resolve) => setTimeout(resolve, 1300));
    await act(async () => {});

    const pollCall = fetchMock.mock.calls.find(([u]) => u.includes("/api/oauth/freebuff/poll"));
    expect(pollCall).toBeTruthy();
    const body = JSON.parse(pollCall[1].body);
    expect(body.deviceCode).toBe("freebuff-go-abc123");
    expect(body.extraData).toEqual({ _fingerprintHash: "hash-1", _expiresAt: 1786669488159 });

    expect(onSuccess).toHaveBeenCalled();
    expect(await findByText("Connected Successfully!")).toBeTruthy();
  });

  it("imports the CLI token and connects via the exchange route", async () => {
    // Keep the guided login pending so the fallback stays visible.
    fetchMock.mockImplementation(async (url, opts) => {
      const u = String(url);
      if (u.includes("/api/oauth/freebuff/device-code")) {
        return { ok: true, json: async () => deviceCodeResponse({ interval: 60 }) };
      }
      if (u.includes("/api/oauth/freebuff/poll")) {
        return { ok: true, json: async () => ({ success: false, error: "authorization_pending", pending: true }) };
      }
      if (u.includes("/api/oauth/freebuff/import")) {
        return { ok: true, json: async () => ({ tokenFound: true, token: "cli-token-abc" }) };
      }
      if (u.includes("/api/oauth/freebuff/exchange")) {
        return { ok: true, json: async () => ({ success: true }) };
      }
      return { ok: false, json: async () => ({ error: "unexpected fetch " + u }) };
    });

    await renderModal();

    const importBtn = [...container.querySelectorAll("button")].find((b) =>
      b.textContent.includes("Import token from Freebuff CLI")
    );
    expect(importBtn).toBeTruthy();

    await act(async () => {
      importBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Import GET hit, token landed in the paste box.
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/oauth/freebuff/import"));
    const input = [...container.querySelectorAll("input")].find((i) => i.value === "cli-token-abc");
    expect(input).toBeTruthy();

    const connectBtn = [...container.querySelectorAll("button")].find((b) => b.textContent === "Connect");
    await act(async () => {
      connectBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Bare token POSTed to the exchange route — no URL parsing, no JWT branch.
    const exchangeCall = fetchMock.mock.calls.find(([u]) => u.endsWith("/api/oauth/freebuff/exchange"));
    expect(exchangeCall).toBeTruthy();
    const body = JSON.parse(exchangeCall[1].body);
    expect(body.code).toBe("cli-token-abc");
  });

  it("renders nothing when provider info is missing", async () => {
    await renderModal({ providerInfo: null });
    expect(container.textContent).toBe("");
  });
});
