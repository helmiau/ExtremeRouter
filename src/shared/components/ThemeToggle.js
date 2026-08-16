"use client";

import { useTheme } from "@/shared/hooks/useTheme";
import { cn } from "@/shared/utils/cn";

// light → dark → glass → light. "system" resolves to its effective theme
// first so the cycle always starts from what the user currently sees.
const CYCLE = ["light", "dark", "glass"];
const ICONS = { light: "light_mode", dark: "dark_mode", glass: "blur_on" };

export default function ThemeToggle({ className, variant = "default" }) {
  const { effectiveTheme, setTheme } = useTheme();

  const nextTheme = CYCLE[(CYCLE.indexOf(effectiveTheme) + 1) % CYCLE.length];

  const variants = {
    default: cn(
      "flex items-center justify-center size-10 rounded-full",
      "text-text-muted hover:text-text-main",
      "hover:bg-surface-2 transition-colors"
    ),
    card: cn(
      "flex items-center justify-center size-11 rounded-full",
      "bg-surface/60 hover:bg-surface",
      "border border-border",
      "backdrop-blur-md shadow-sm hover:shadow-[var(--shadow-warm)]",
      "text-text-muted hover:text-brand-500",
      "transition-all group"
    ),
  };

  return (
    <button
      onClick={() => setTheme(nextTheme)}
      className={cn(variants[variant], className)}
      aria-label={`Switch to ${nextTheme} mode`}
      title={`Switch to ${nextTheme} mode`}
    >
      <span
        className={cn(
          "material-symbols-outlined text-[22px]",
          variant === "card" && "transition-transform duration-300 group-hover:rotate-12"
        )}
      >
        {ICONS[effectiveTheme] || "dark_mode"}
      </span>
    </button>
  );
}
