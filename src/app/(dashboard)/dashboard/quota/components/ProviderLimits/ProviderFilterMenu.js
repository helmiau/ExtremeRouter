"use client";

import ProviderIcon from "@/shared/components/ProviderIcon";
import { getProviderIconPath } from "@/shared/utils/providerIcon";

export default function ProviderFilterMenu({
  providerFilter,
  providerOptions,
  providerMenuOpen,
  onToggleMenu,
  onSelectProvider,
}) {
  const selectedProviderLabel =
    providerFilter === "all" ? "All providers" : providerFilter;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggleMenu}
        className="flex h-8 items-center justify-between gap-1 rounded-lg border border-border bg-black/[0.02] px-2 text-xs text-text-primary transition-colors hover:bg-surface-2 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/10"
        aria-haspopup="menu"
        aria-expanded={providerMenuOpen}
        title="Filter quota providers"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {providerFilter === "all" ? (
            <span className="material-symbols-outlined text-[14px] text-text-muted">
              apps
            </span>
          ) : (
            <ProviderIcon
              src={getProviderIconPath(providerFilter)}
              alt={providerFilter}
              size={18}
              className="size-[18px] rounded object-contain"
              fallbackText={providerFilter.slice(0, 2).toUpperCase()}
            />
          )}
          <span className="truncate capitalize hidden lg:inline">
            {selectedProviderLabel}
          </span>
        </span>
        <span className="material-symbols-outlined text-[14px] text-text-muted">
          expand_more
        </span>
      </button>

      {providerMenuOpen && (
        <>
          <button
            type="button"
            className="fixed inset-0 z-30 bg-transparent"
            aria-label="Close provider filter"
            onClick={onToggleMenu}
          />
          <div className="absolute left-0 z-40 mt-2 w-64 overflow-hidden rounded-2xl border border-border bg-surface/95 p-1.5 shadow-xl shadow-black/10 backdrop-blur dark:border-white/10 dark:bg-surface/95 sm:w-72">
            <button
              type="button"
              onClick={() => onSelectProvider("all")}
              className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors ${providerFilter === "all" ? "bg-primary/10 text-primary" : "text-text-primary hover:hover:bg-surface-3"}`}
            >
              <span className="material-symbols-outlined text-[22px]">
                apps
              </span>
              <span className="font-medium">All providers</span>
              {providerFilter === "all" && (
                <span className="material-symbols-outlined ml-auto text-[20px]">
                  check
                </span>
              )}
            </button>
            <div className="my-1 h-px bg-black/10 dark:bg-white/10" />
            <div className="max-h-72 overflow-y-auto pr-1">
              {providerOptions.map((provider) => (
                <button
                  key={provider}
                  type="button"
                  onClick={() => onSelectProvider(provider)}
                  className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors ${providerFilter === provider ? "bg-primary/10 text-primary" : "text-text-primary hover:hover:bg-surface-3"}`}
                >
                  <ProviderIcon
                    src={getProviderIconPath(provider)}
                    alt={provider}
                    size={24}
                    className="size-6 rounded-md object-contain"
                    fallbackText={provider.slice(0, 2).toUpperCase()}
                  />
                  <span className="font-medium capitalize">{provider}</span>
                  {providerFilter === provider && (
                    <span className="material-symbols-outlined ml-auto text-[20px]">
                      check
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
