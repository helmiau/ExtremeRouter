"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { THEME_CONFIG } from "@/shared/constants/config";

const useThemeStore = create(
  persist(
    (set, get) => ({
      theme: THEME_CONFIG.defaultTheme,

      setTheme: (theme) => {
        set({ theme });
        applyTheme(theme);
      },

      toggleTheme: () => {
        const currentTheme = get().theme;
        // Glass is dark-based: toggling from glass lands on light (and vice
        // versa) so the binary toggle always flips the effective brightness.
        const systemDark =
          typeof window !== "undefined" &&
          window.matchMedia("(prefers-color-scheme: dark)").matches;
        const isDarkLike =
          currentTheme === "dark" ||
          currentTheme === "glass" ||
          (currentTheme === "system" && systemDark);
        const newTheme = isDarkLike ? "light" : "dark";
        set({ theme: newTheme });
        applyTheme(newTheme);
      },

      initTheme: () => {
        const theme = get().theme;
        applyTheme(theme);
      },
    }),
    {
      name: THEME_CONFIG.storageKey,
    }
  )
);

// Apply theme to document
function applyTheme(theme) {
  if (typeof window === "undefined") return;

  const root = document.documentElement;
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";

  const effectiveTheme = theme === "system" ? systemTheme : theme;

  root.classList.remove("dark", "glass");
  if (effectiveTheme === "dark") {
    root.classList.add("dark");
  } else if (effectiveTheme === "glass") {
    // Glass is dark-based: keep every `.dark` rule alive and layer the
    // frosted tokens on top (.glass overrides in globals.css).
    root.classList.add("dark", "glass");
  }
}

export default useThemeStore;

