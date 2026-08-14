"use client";

import { ACCOUNT_PAGE_SIZE_OPTIONS, ACCOUNT_PAGE_SIZE_MAX } from "./utils";

export default function PaginationControls({
  pagination,
  pageSize,
  customPageSizeInput,
  connectionsLoading,
  refreshingAll,
  connectionsPageSummary,
  setPage,
  onPageSizeSelect,
  onCustomPageSizeInputChange,
  onCommitCustomPageSize,
}) {
  const isCustomPageSize = !ACCOUNT_PAGE_SIZE_OPTIONS.includes(pageSize);

  return (
    <div className="rounded-xl border border-border bg-black/[0.02] px-3 py-2 dark:border-white/10 dark:bg-white/[0.03]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-text-muted">{connectionsPageSummary}</span>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={isCustomPageSize ? "custom" : String(pageSize)}
            onChange={(event) => onPageSizeSelect(event.target.value)}
            className="h-8 rounded-lg border border-border bg-black/[0.02] px-2 text-xs text-text-primary outline-none transition-colors hover:bg-surface-2 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/10"
            aria-label="Accounts per page"
          >
            {ACCOUNT_PAGE_SIZE_OPTIONS.map((option) => (
              <option key={option} value={String(option)}>
                {option} / page
              </option>
            ))}
            <option value="custom">Custom</option>
          </select>
          <input
            type="number"
            min="1"
            max={String(ACCOUNT_PAGE_SIZE_MAX)}
            inputMode="numeric"
            value={customPageSizeInput}
            onChange={(event) => onCustomPageSizeInputChange(event.target.value)}
            onBlur={onCommitCustomPageSize}
            onKeyDown={(event) => {
              if (event.key === "Enter") onCommitCustomPageSize();
            }}
            className="h-8 w-20 rounded-lg border border-border bg-black/[0.02] px-2 text-xs text-text-primary outline-none transition-colors hover:bg-surface-2 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/10"
            aria-label="Custom accounts per page"
            placeholder="Custom"
          />
          <span className="text-xs text-text-muted">Page {pagination.page} / {pagination.totalPages}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setPage(1)}
            disabled={
              pagination.page <= 1 || connectionsLoading || refreshingAll
            }
            className="flex h-8 items-center rounded-lg border border-border px-3 text-xs text-text-primary transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/5"
          >
            First Page
          </button>
          <button
            type="button"
            onClick={() =>
              setPage((currentPage) => Math.max(1, currentPage - 1))
            }
            disabled={
              pagination.page <= 1 || connectionsLoading || refreshingAll
            }
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-border text-text-primary transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/5"
            aria-label="Previous accounts page"
          >
            <span className="material-symbols-outlined text-[16px]">
              chevron_left
            </span>
          </button>
          <button
            type="button"
            onClick={() =>
              setPage((currentPage) =>
                Math.min(pagination.totalPages, currentPage + 1),
              )
            }
            disabled={
              pagination.page >= pagination.totalPages ||
              connectionsLoading ||
              refreshingAll
            }
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-border text-text-primary transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/5"
            aria-label="Next accounts page"
          >
            <span className="material-symbols-outlined text-[16px]">
              chevron_right
            </span>
          </button>
          <button
            type="button"
            onClick={() => setPage(pagination.totalPages)}
            disabled={
              pagination.page >= pagination.totalPages ||
              connectionsLoading ||
              refreshingAll
            }
            className="flex h-8 items-center rounded-lg border border-border px-3 text-xs text-text-primary transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/5"
          >
            Last Page
          </button>
        </div>
      </div>
    </div>
  );
}
