"use client";

import ProviderFilterMenu from "./ProviderFilterMenu";
import { ACCOUNT_FILTER_OPTIONS, QUOTA_SORT_OPTIONS } from "./utils";

export default function HeaderControls({
  providerFilter,
  providerOptions,
  providerMenuOpen,
  onToggleProviderMenu,
  onSelectProvider,
  accountFilter,
  onAccountFilterChange,
  quotaSortMode,
  onQuotaSortModeChange,
  expiringFirst,
  onToggleExpiringFirst,
  autoRefresh,
  onToggleAutoRefresh,
  countdown,
  bulkToggling,
  onDisableDepleted,
  onEnableAvailable,
  refreshingAll,
  onRefreshAll,
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-end">
      <div className="flex flex-wrap items-center gap-1.5">
        <ProviderFilterMenu
          providerFilter={providerFilter}
          providerOptions={providerOptions}
          providerMenuOpen={providerMenuOpen}
          onToggleMenu={onToggleProviderMenu}
          onSelectProvider={onSelectProvider}
        />
        <select
          value={accountFilter}
          onChange={(event) => onAccountFilterChange(event.target.value)}
          className="h-8 rounded-lg border border-border bg-black/[0.02] px-2 text-xs text-text-primary outline-none transition-colors hover:bg-surface-2 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/10"
          aria-label="Filter accounts by status"
        >
          {ACCOUNT_FILTER_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        {providerFilter === "codex" && (
          <select
            value={quotaSortMode}
            onChange={(event) => onQuotaSortModeChange(event.target.value)}
            className="h-8 rounded-lg border border-border bg-black/[0.02] px-2 text-xs text-text-primary outline-none transition-colors hover:bg-surface-2 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/10"
            aria-label="Sort Codex quotas by remaining"
          >
            {QUOTA_SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        )}

        <button
          type="button"
          onClick={onToggleExpiringFirst}
          aria-pressed={expiringFirst}
          className={`flex h-8 shrink-0 items-center gap-1 rounded-lg border px-2 text-xs transition-colors ${expiringFirst ? "border-amber-500/40 bg-warning/10 text-warning" : "border-border text-text-primary hover:bg-surface-2 dark:border-white/10 dark:hover:bg-white/5"}`}
          title="Sort accounts by earliest quota reset time"
        >
          <span className="material-symbols-outlined text-[14px]">
            hourglass_top
          </span>
          <span className="hidden sm:inline">Expiring first</span>
        </button>

        {/* Bulk: disable depleted */}
        <button
          type="button"
          onClick={onDisableDepleted}
          disabled={bulkToggling}
          className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-red-500/30 px-2 text-xs text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
          title="Disable connections with depleted quota on the current page"
        >
          <span className="material-symbols-outlined text-[14px]">block</span>
          <span className="hidden sm:inline">Turn off Empty</span>
        </button>

        {/* Bulk: enable available */}
        <button
          type="button"
          onClick={onEnableAvailable}
          disabled={bulkToggling}
          className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-emerald-500/30 px-2 text-xs text-emerald-500 transition-colors hover:bg-emerald-500/10 disabled:opacity-50"
          title="Enable connections that still have quota on the current page"
        >
          <span className="material-symbols-outlined text-[14px]">
            check_circle
          </span>
          <span className="hidden sm:inline">Turn on Available</span>
        </button>

        {/* Auto-refresh toggle */}
        <button
          onClick={onToggleAutoRefresh}
          className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-border px-2 text-xs transition-colors hover:bg-surface-2 dark:border-white/10 dark:hover:bg-white/5"
          title={autoRefresh ? "Disable auto-refresh" : "Enable auto-refresh"}
        >
          <span
            className={`material-symbols-outlined text-[14px] ${
              autoRefresh ? "text-primary" : "text-text-muted"
            }`}
          >
            {autoRefresh ? "toggle_on" : "toggle_off"}
          </span>
          <span className="hidden text-text-primary sm:inline">
            Auto-refresh
          </span>
          {autoRefresh && (
            <span className="text-[10px] text-text-muted tabular-nums">
              ({countdown}s)
            </span>
          )}
        </button>

        {/* Refresh all button */}
        <button
          type="button"
          onClick={() => onRefreshAll(true)}
          disabled={refreshingAll}
          className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-border px-2 text-xs text-text-primary transition-colors hover:bg-surface-2 dark:border-white/10 dark:hover:bg-white/5 disabled:opacity-50"
          title="Refresh all"
        >
          <span
            className={`material-symbols-outlined text-[14px] ${refreshingAll ? "animate-spin" : ""}`}
          >
            refresh
          </span>
        </button>
      </div>
    </div>
  );
}
