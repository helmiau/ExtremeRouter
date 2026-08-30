"use client";

import ProviderIcon from "@/shared/components/ProviderIcon";
import { getProviderIconPath } from "@/shared/utils/providerIcon";
import Toggle from "@/shared/components/Toggle";
import Tooltip from "@/shared/components/Tooltip";
import Card from "@/shared/components/Card";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import QuotaTable from "./QuotaTable";
import {
  getConnectionLabel,
  getConnectionSecondaryLabel,
  kiroMethodLabel,
  kiroRegion,
  getCodexResetCreditCount,
  AUTO_PING_SETTINGS_KEYS,
  AUTO_PING_TOOLTIPS,
} from "./utils";

export default function ProviderCard({
  conn,
  quota,
  isLoading,
  error,
  autoPingMaps,
  quotaSortMode,
  resettingLimitId,
  deletingId,
  togglingId,
  onRefresh,
  onEdit,
  onDelete,
  onToggleActive,
  onRequestReset,
  onViewResetCredits,
  onToggleAutoPing,
}) {
  const { copied, copy } = useCopyToClipboard();

  const isInactive = conn.isActive === false;
  const isCodex = conn.provider === "codex";
  const resetCreditCount = getCodexResetCreditCount(quota);
  const isResettingLimit = resettingLimitId === conn.id;
  const rowBusy = deletingId === conn.id || togglingId === conn.id || isResettingLimit;

  return (
    <Card
      padding="none"
      className={`min-w-0 ${isInactive ? "opacity-60" : ""}`}
    >
      <div className="px-3 py-2 border-b border-border">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 shrink-0 rounded-md flex items-center justify-center overflow-hidden">
              <ProviderIcon
                src={getProviderIconPath(conn.provider)}
                alt={conn.provider}
                size={32}
                className="object-contain"
                fallbackText={
                  conn.provider?.slice(0, 2).toUpperCase() || "PR"
                }
              />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-text-primary capitalize truncate">
                {conn.provider}
              </h3>
              {getConnectionLabel(conn) ? (
                <p className="text-xs text-text-muted truncate">
                  {getConnectionLabel(conn)}
                </p>
              ) : null}
              {getConnectionSecondaryLabel(conn) ? (
                <p className="text-[11px] text-text-muted/80 truncate">
                  {getConnectionSecondaryLabel(conn)}
                </p>
              ) : null}
              {conn.provider === "kiro" && (
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  <span className="rounded-full bg-brand-500/10 px-2 py-0.5 text-[10px] font-semibold text-brand-600 dark:text-brand-300">
                    {kiroMethodLabel(conn)}
                  </span>
                  {kiroRegion(conn) && (
                    <span className="rounded-full bg-info/10 px-2 py-0.5 text-[10px] font-semibold text-info">
                      {kiroRegion(conn)}
                    </span>
                  )}
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      isInactive
                        ? "bg-surface-2 text-text-muted"
                        : conn.testStatus === "active" || conn.testStatus === "success"
                          ? "bg-green-500/10 text-success"
                          : conn.testStatus === "error" || conn.testStatus === "expired" || conn.testStatus === "unavailable"
                            ? "bg-red-500/10 text-danger"
                            : "bg-surface-2 text-text-muted"
                    }`}
                  >
                    {isInactive ? "disabled" : conn.testStatus || "unknown"}
                  </span>
                  {conn.providerSpecificData?.profileArn && (
                    <button
                      type="button"
                      onClick={() => copy(conn.providerSpecificData.profileArn, conn.id)}
                      title={conn.providerSpecificData.profileArn}
                      className="inline-flex max-w-full items-center gap-1 rounded-full border border-border-subtle px-2 py-0.5 text-[10px] text-text-muted transition-colors hover:text-primary"
                    >
                      <span className="material-symbols-outlined text-[12px]">
                        {copied === conn.id ? "check" : "content_copy"}
                      </span>
                      <code className="truncate font-mono">
                        {conn.providerSpecificData.profileArn}
                      </code>
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {isCodex && (
              <>
                <Tooltip
                  text={
                    resetCreditCount > 0
                      ? `Use one Codex reset credit. Available: ${resetCreditCount}`
                      : "No Codex reset credits available"
                  }
                >
                  <button
                    type="button"
                    onClick={() => onRequestReset(conn, resetCreditCount)}
                    disabled={resetCreditCount <= 0 || isLoading || rowBusy}
                    aria-label={
                      resetCreditCount > 0
                        ? `Use one Codex reset credit. ${resetCreditCount} available.`
                        : "No Codex reset credits available"
                    }
                    className={`flex h-8 min-w-10 items-center justify-center gap-1 rounded-lg border px-2 text-[11px] font-medium tabular-nums transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/60 disabled:cursor-not-allowed disabled:opacity-60 ${
                      resetCreditCount > 0
                        ? "border-primary/30 bg-primary/5 text-primary hover:bg-primary/10"
                        : "border-border bg-black/[0.02] text-text-muted dark:border-white/10 dark:bg-white/[0.03]"
                    }`}
                  >
                    <span className={`material-symbols-outlined text-[15px] ${isResettingLimit ? "animate-spin" : ""}`}>
                      {isResettingLimit ? "progress_activity" : "restart_alt"}
                    </span>
                    <span>{resetCreditCount}</span>
                  </button>
                </Tooltip>
                <Tooltip text="View Codex reset credit expiry">
                  <button
                    type="button"
                    onClick={() => onViewResetCredits(conn)}
                    disabled={isLoading || rowBusy}
                    aria-label="View Codex reset credit expiry"
                    className="flex h-8 w-8 items-center justify-center rounded-lg border border-border text-text-muted transition-colors hover:bg-surface-2 hover:text-primary disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:hover:bg-white/5"
                  >
                    <span className="material-symbols-outlined text-[17px]">schedule</span>
                  </button>
                </Tooltip>
              </>
            )}
            {AUTO_PING_SETTINGS_KEYS[conn.provider] && conn.authType === "oauth" && (
              <Tooltip text={AUTO_PING_TOOLTIPS[conn.provider]}>
                <button
                  type="button"
                  onClick={() => onToggleAutoPing(conn.id, conn.provider, !(autoPingMaps[conn.provider]?.[conn.id] === true))}
                  aria-label="Toggle auto-ping"
                  className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:hover:bg-surface-3 ${autoPingMaps[conn.provider]?.[conn.id] === true ? "text-primary" : "text-text-muted"}`}
                >
                  <span className="material-symbols-outlined text-[18px]">bolt</span>
                </button>
              </Tooltip>
            )}
            <Tooltip text="Refresh quota">
              <button
                type="button"
                onClick={() => onRefresh(conn.id, conn.provider)}
                disabled={isLoading || rowBusy}
                aria-label="Refresh quota"
                className="flex h-8 w-8 items-center justify-center rounded-lg hover:hover:bg-surface-3 transition-colors disabled:opacity-50"
              >
                <span
                  className={`material-symbols-outlined text-[18px] text-text-muted ${isLoading ? "animate-spin" : ""}`}
                >
                  refresh
                </span>
              </button>
            </Tooltip>
            <Tooltip text="Edit connection">
              <button
                type="button"
                onClick={() => onEdit(conn)}
                disabled={rowBusy}
                aria-label="Edit connection"
                className="flex h-8 w-8 items-center justify-center rounded-lg hover:hover:bg-surface-3 text-text-muted hover:text-primary transition-colors disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-[18px]">
                  edit
                </span>
              </button>
            </Tooltip>
            <Tooltip text="Delete connection">
              <button
                type="button"
                onClick={() => onDelete(conn.id)}
                disabled={rowBusy}
                aria-label="Delete connection"
                className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-danger/10 text-danger transition-colors disabled:opacity-50"
              >
                <span
                  className={`material-symbols-outlined text-[18px] ${deletingId === conn.id ? "animate-pulse" : ""}`}
                >
                  delete
                </span>
              </button>
            </Tooltip>
            <div
              className="inline-flex items-center pl-0.5"
              title={
                (conn.isActive ?? true)
                  ? "Disable connection"
                  : "Enable connection"
              }
            >
              <Toggle
                size="sm"
                checked={conn.isActive ?? true}
                disabled={rowBusy}
                onChange={(nextActive) =>
                  onToggleActive(conn.id, nextActive)
                }
              />
            </div>
          </div>
        </div>
      </div>

      <div className="px-2 py-1.5">
        {isLoading ? (
          <div className="text-center py-5 text-text-muted">
            <span className="material-symbols-outlined text-[28px] animate-spin">
              progress_activity
            </span>
          </div>
        ) : error ? (
          <div className="text-center py-5">
            <span className="material-symbols-outlined text-[28px] text-danger">
              error
            </span>
            <p className="mt-1.5 text-xs text-text-muted">{error}</p>
          </div>
        ) : (
          <>
            <QuotaTable
              quotas={quota?.quotas}
              compact
              sortMode="default"
              showSortLabel={
                conn.provider === "codex" && quotaSortMode !== "default"
              }
            />
            {/* Non-blocking notes (e.g. Zed token-billing / overdue-invoice
                notices) render alongside the quota rows instead of replacing
                them. */}
            {quota?.message && (
              <p className="mt-2 px-1 text-[10px] leading-relaxed text-text-muted">
                {quota.message}
              </p>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
