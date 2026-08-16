"use client";

import { useState, useEffect, useCallback } from "react";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import Pagination from "@/shared/components/Pagination";
import Badge from "@/shared/components/Badge";
import { cn } from "@/shared/utils/cn";
import {
  REASON_META,
  SmartRoutingRunDetail,
  statusVariant,
  statusLabel,
  formatDuration,
} from "@/shared/components/SmartRoutingTelemetryMonitor";

const REASON_OPTIONS = Object.keys(REASON_META);
const STATUS_OPTIONS = ["running", "done", "error"];
const PAGE_SIZES = [10, 20, 50, 100];

const EMPTY_FILTERS = { reason: "", comboName: "", status: "", startDate: "", endDate: "" };

export default function SmartRoutingHistory({ onCompare }) {
  const [runs, setRuns] = useState([]);
  const [combos, setCombos] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, totalItems: 0, totalPages: 0 });
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [loading, setLoading] = useState(false);
  const [expandedRunId, setExpandedRunId] = useState(null);
  const [error, setError] = useState(null);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        page: pagination.page.toString(),
        pageSize: pagination.pageSize.toString(),
      });
      if (filters.reason) params.append("reason", filters.reason);
      if (filters.comboName) params.append("comboName", filters.comboName);
      if (filters.status) params.append("status", filters.status);
      if (filters.startDate) params.append("startDate", filters.startDate);
      if (filters.endDate) params.append("endDate", filters.endDate);

      const res = await fetch(`/api/smart-routing/history?${params}`);
      const data = await res.json();
      setRuns(data.runs || []);
      setCombos(data.combos || []);
      setPagination((prev) => ({ ...prev, ...data.pagination }));
    } catch (err) {
      console.error("Failed to fetch smart-routing history:", err);
      setError("Failed to load history");
    } finally {
      setLoading(false);
    }
  }, [pagination.page, pagination.pageSize, filters]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  const updateFilter = (key, value) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPagination((prev) => ({ ...prev, page: 1 }));
  };

  const handleClearFilters = () => {
    setFilters(EMPTY_FILTERS);
    setPagination((prev) => ({ ...prev, page: 1 }));
  };

  const hasFilters = Object.values(filters).some(Boolean);

  return (
    <div className="flex flex-col gap-5">
      {/* Filters */}
      <Card padding="md">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <div className="flex min-w-0 flex-col gap-2">
            <label htmlFor="sr-reason-filter" className="text-sm font-medium text-text-main">Reason</label>
            <select
              id="sr-reason-filter"
              value={filters.reason}
              onChange={(e) => updateFilter("reason", e.target.value)}
              className="h-9 w-full min-w-0 cursor-pointer rounded-lg border border-border bg-surface-2 px-3 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20"
            >
              <option value="">All Reasons</option>
              {REASON_OPTIONS.map((r) => (
                <option key={r} value={r}>{REASON_META[r].label}</option>
              ))}
            </select>
          </div>

          <div className="flex min-w-0 flex-col gap-2">
            <label htmlFor="sr-combo-filter" className="text-sm font-medium text-text-main">Combo</label>
            <select
              id="sr-combo-filter"
              value={filters.comboName}
              onChange={(e) => updateFilter("comboName", e.target.value)}
              className="h-9 w-full min-w-0 cursor-pointer rounded-lg border border-border bg-surface-2 px-3 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20"
            >
              <option value="">All Combos</option>
              {combos.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>

          <div className="flex min-w-0 flex-col gap-2">
            <label htmlFor="sr-status-filter" className="text-sm font-medium text-text-main">Status</label>
            <select
              id="sr-status-filter"
              value={filters.status}
              onChange={(e) => updateFilter("status", e.target.value)}
              className="h-9 w-full min-w-0 cursor-pointer rounded-lg border border-border bg-surface-2 px-3 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20"
            >
              <option value="">All Statuses</option>
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>

          <div className="flex min-w-0 flex-col gap-2">
            <label htmlFor="sr-start-filter" className="text-sm font-medium text-text-main">From</label>
            <input
              id="sr-start-filter"
              type="datetime-local"
              value={filters.startDate}
              onChange={(e) => updateFilter("startDate", e.target.value)}
              className="h-9 w-full min-w-0 rounded-lg border border-border bg-surface-2 px-3 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20"
              style={{ colorScheme: "auto" }}
            />
          </div>

          <div className="flex min-w-0 flex-col gap-2">
            <label htmlFor="sr-end-filter" className="text-sm font-medium text-text-main">To</label>
            <input
              id="sr-end-filter"
              type="datetime-local"
              value={filters.endDate}
              onChange={(e) => updateFilter("endDate", e.target.value)}
              className="h-9 w-full min-w-0 rounded-lg border border-border bg-surface-2 px-3 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20"
              style={{ colorScheme: "auto" }}
            />
          </div>
        </div>

        <div className="mt-4 flex items-center justify-end">
          <Button variant="ghost" onClick={handleClearFilters} disabled={!hasFilters}>
            Clear Filters
          </Button>
        </div>
      </Card>

      {/* Table */}
      <Card padding="none">
        {error ? (
          <div className="p-8 text-center text-sm text-danger">{error}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px]">
              <thead>
                <tr className="border-b border-border-subtle">
                  <th className="p-4 text-left text-sm font-semibold text-text-main">Time</th>
                  <th className="p-4 text-left text-sm font-semibold text-text-main">Combo</th>
                  <th className="p-4 text-left text-sm font-semibold text-text-main">Reason</th>
                  <th className="p-4 text-left text-sm font-semibold text-text-main">Pool</th>
                  <th className="p-4 text-left text-sm font-semibold text-text-main">Served</th>
                  <th className="p-4 text-left text-sm font-semibold text-text-main">Status</th>
                  <th className="p-4 text-right text-sm font-semibold text-text-main">Duration</th>
                  <th className="p-4 text-right text-sm font-semibold text-text-main">Compare</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan="8" className="p-8 text-center text-text-muted">
                      <div className="flex items-center justify-center gap-2">
                        <span className="material-symbols-outlined animate-spin text-[20px]">progress_activity</span>
                        Loading…
                      </div>
                    </td>
                  </tr>
                ) : runs.length === 0 ? (
                  <tr>
                    <td colSpan="8" className="p-8 text-center text-text-muted">
                      No smart-routing history found
                      {hasFilters && " for the selected filters"}
                    </td>
                  </tr>
                ) : (
                  runs.map((run) => {
                    const meta = REASON_META[run.routing?.reason] || REASON_META.general;
                    const expanded = expandedRunId === run.runId;
                    return (
                      <HistoryRow
                        key={run.runId}
                        run={run}
                        meta={meta}
                        expanded={expanded}
                        onToggle={() => setExpandedRunId(expanded ? null : run.runId)}
                        onCompare={onCompare}
                      />
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}

        {!loading && runs.length > 0 && (
          <div className="border-t border-border-subtle">
            <Pagination
              currentPage={pagination.page}
              pageSize={pagination.pageSize}
              totalItems={pagination.totalItems}
              onPageChange={(page) => setPagination((prev) => ({ ...prev, page }))}
              onPageSizeChange={(size) => setPagination((prev) => ({ ...prev, pageSize: size, page: 1 }))}
            />
          </div>
        )}
      </Card>
    </div>
  );
}

function HistoryRow({ run, meta, expanded, onToggle, onCompare }) {
  const poolPreview = (run.routing?.order || []).slice(0, 3).join(", ");
  const poolExtra = (run.routing?.order?.length || 0) - 3;

  return (
    <>
      <tr
        onClick={onToggle}
        className="cursor-pointer border-b border-border-subtle transition-colors last:border-b-0 hover:bg-black/[0.02] dark:hover:bg-white/[0.02]"
      >
        <td className="whitespace-nowrap p-4 text-sm text-text-muted">
          {run.startedAt ? new Date(run.startedAt).toLocaleString() : "—"}
        </td>
        <td className="max-w-[200px] truncate p-4 font-mono text-sm text-text-main">{run.comboName || "—"}</td>
        <td className="p-4">
          <Badge variant={meta.variant} size="sm">{meta.label}</Badge>
        </td>
        <td className="max-w-[280px] p-4">
          <div className="truncate font-mono text-xs text-text-muted">
            {poolPreview}
            {poolExtra > 0 && <span className="text-text-subtle"> +{poolExtra} more</span>}
            {!poolPreview && "—"}
          </div>
        </td>
        <td className="max-w-[200px] truncate p-4 font-mono text-xs text-text-muted">
          {run.servedModel || "—"}
        </td>
        <td className="p-4">
          <Badge variant={statusVariant(run.status)} size="sm">{statusLabel(run.status)}</Badge>
        </td>
        <td className="whitespace-nowrap p-4 text-right font-mono text-sm text-text-muted">
          {formatDuration(run.totalDurationMs)}
        </td>
        <td className="whitespace-nowrap p-4 text-right">
          {typeof onCompare === "function" && (
            <button
              type="button"
              title="A/B compare strategies on this request"
              onClick={(e) => {
                e.stopPropagation();
                onCompare(run);
              }}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-surface-2 text-text-muted transition-colors hover:border-primary/40 hover:text-primary"
            >
              <span className="material-symbols-outlined text-[16px]">science</span>
            </button>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-border-subtle bg-surface-2/40 last:border-b-0">
          <td colSpan="8" className="p-0">
            <div className="flex flex-col">
              {run.promptPreview && (
                <div className="border-b border-border-subtle px-4 py-2">
                  <p className="truncate text-xs text-text-muted">{run.promptPreview}</p>
                </div>
              )}
              <SmartRoutingRunDetail routing={run.routing} servedModel={run.servedModel} pendingLabel="No routing decision recorded" />
              {run.status === "error" && run.error && (
                <div className="border-t border-danger/20 bg-danger/5 px-4 py-2">
                  <p className="text-xs text-danger">{run.error}</p>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
