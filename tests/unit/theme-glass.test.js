// @vitest-environment jsdom
// Glass Mode theme system: glass is a dark-based modifier class (.dark.glass).
// applyTheme("glass") must keep every .dark rule alive (both classes on <html>)
// so all existing dark: utilities keep working, and useTheme must expose
// isGlass/effectiveTheme while isDark stays true — existing contrast/icon
// consumers must not notice the third theme.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

// jsdom lacks matchMedia — stub BEFORE the store module loads (useTheme
// subscribes via useSyncExternalStore at render time).
window.matchMedia = vi.fn((query) => ({
  matches: false, // system resolves to light in these tests
  media: query,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
}));

const { default: useThemeStore } = await import("../../src/store/themeStore.js");
const { useTheme } = await import("../../src/shared/hooks/useTheme.js");

function rootClasses() {
  return document.documentElement.classList;
}

describe("themeStore applyTheme — glass keeps dark alive", () => {
  beforeEach(() => {
    document.documentElement.className = "";
    localStorage.clear();
    useThemeStore.setState({ theme: "system" });
  });

  it("glass applies BOTH dark and glass classes", () => {
    act(() => useThemeStore.getState().setTheme("glass"));
    expect(rootClasses().contains("dark")).toBe(true);
    expect(rootClasses().contains("glass")).toBe(true);
  });

  it("dark adds only the dark class", () => {
    act(() => useThemeStore.getState().setTheme("dark"));
    expect(rootClasses().contains("dark")).toBe(true);
    expect(rootClasses().contains("glass")).toBe(false);
  });

  it("light removes both classes", () => {
    act(() => useThemeStore.getState().setTheme("glass"));
    act(() => useThemeStore.getState().setTheme("light"));
    expect(rootClasses().contains("dark")).toBe(false);
    expect(rootClasses().contains("glass")).toBe(false);
  });

  it("switching glass → dark strips the glass layer but keeps dark", () => {
    act(() => useThemeStore.getState().setTheme("glass"));
    act(() => useThemeStore.getState().setTheme("dark"));
    expect(rootClasses().contains("dark")).toBe(true);
    expect(rootClasses().contains("glass")).toBe(false);
  });
});

describe("themeStore toggleTheme — binary flip by effective brightness", () => {
  beforeEach(() => {
    document.documentElement.className = "";
    localStorage.clear();
  });

  it("toggling from glass lands on light (glass is dark-based)", () => {
    useThemeStore.setState({ theme: "glass" });
    act(() => useThemeStore.getState().toggleTheme());
    expect(useThemeStore.getState().theme).toBe("light");
    expect(rootClasses().contains("dark")).toBe(false);
    expect(rootClasses().contains("glass")).toBe(false);
  });

  it("toggling from light lands on dark", () => {
    useThemeStore.setState({ theme: "light" });
    act(() => useThemeStore.getState().toggleTheme());
    expect(useThemeStore.getState().theme).toBe("dark");
    expect(rootClasses().contains("dark")).toBe(true);
  });
});

describe("useTheme — glass flags for consumers", () => {
  function Probe() {
    const { isDark, isGlass, effectiveTheme } = useTheme();
    return <div data-testid="probe">{`${isDark}|${isGlass}|${effectiveTheme}`}</div>;
  }

  let container;
  let root;

  beforeEach(() => {
    document.documentElement.className = "";
    localStorage.clear();
    useThemeStore.setState({ theme: "system" });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  it("glass: isDark stays true, isGlass true, effectiveTheme glass", async () => {
    await act(async () => {
      root.render(<Probe />);
    });
    await act(async () => {
      useThemeStore.getState().setTheme("glass");
    });
    expect(container.textContent).toBe("true|true|glass");
  });

  it("light: all glass flags false", async () => {
    await act(async () => {
      root.render(<Probe />);
    });
    await act(async () => {
      useThemeStore.getState().setTheme("light");
    });
    expect(container.textContent).toBe("false|false|light");
  });

  it("system (prefers light): resolves to light, never glass", async () => {
    await act(async () => {
      root.render(<Probe />);
    });
    await act(async () => {
      useThemeStore.getState().setTheme("system");
    });
    expect(container.textContent).toBe("false|false|light");
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
});
