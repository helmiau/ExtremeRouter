"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import Card from "@/shared/components/Card";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { getProviderIconPath } from "@/shared/utils/providerIcon";
import { LATENCY_MIN_SAMPLES, latencyDisplay } from "@/shared/utils/latencyDisplay";

function formatMs(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatCost(cost) {
  if (cost == null || cost === 0) return "$0.00";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

const PERIODS = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
];

const COLUMNS = [
  { key: "requests", label: "Requests", sortable: true },
  { key: "totalTokens", label: "Tokens", sortable: true },
  { key: "avgTtft", label: "TTFT", sortable: true },
  { key: "p95Latency", label: "P95", sortable: true },
  { key: "successRate", label: "Success", sortable: true },
  { key: "cost", label: "Cost", sortable: true },
];

export default function LeaderboardTable() {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState("7d");
  const [sortKey, setSortKey] = useState("requests");
  const [sortDir, setSortDir] = useState("desc");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/usage/leaderboard?period=${period}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled && !d.error) setData(d.leaderboard || []); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [period]);

  const sorted = useMemo(() => {
    const copy = [...data];
    copy.sort((a, b) => {
      const av = a[sortKey] ?? -1;
      const bv = b[sortKey] ?? -1;
      return sortDir === "desc" ? bv - av : av - bv;
    });
    return copy;
  }, [data, sortKey, sortDir]);

  const handleSort = (key) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  return (
    <Card
      title="Provider Leaderboard"
      subtitle="Performance ranking by requests, latency, and cost"
      icon="leaderboard"
      padding="none"
      action={
        <div className="flex items-center gap-1">
          {PERIODS.map((p) => (
            <button
              key={p.value}
              onClick={() => setPeriod(p.value)}
              className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                period === p.value
                  ? "bg-primary/10 text-primary"
                  : "text-text-muted hover:bg-surface-2"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-text-muted">
          <span className="material-symbols-outlined animate-spin text-[20px]">progress_activity</span>
          <span className="text-sm">Loading leaderboard...</span>
        </div>
      ) : sorted.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-12 text-text-muted">
          <span className="material-symbols-outlined text-[40px] opacity-20">leaderboard</span>
          <span className="text-sm">No usage data for this period</span>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left">
            <thead>
              <tr className="border-b border-border bg-surface-2/50">
                <th className="px-3 py-2 text-[10px] font-medium uppercase tracking-wide text-text-muted">
                  Provider
                </th>
                {COLUMNS.map((col) => (
                  <th
                    key={col.key}
                    onClick={() => col.sortable && handleSort(col.key)}
                    className={`px-3 py-2 text-[10px] font-medium uppercase tracking-wide ${
                      col.sortable ? "cursor-pointer select-none hover:text-text-primary" : ""
                    } ${sortKey === col.key ? "text-primary" : "text-text-muted"}`}
                  >
                    {col.label}
                    {sortKey === col.key && (
                      <span className="material-symbols-outlined ml-0.5 inline text-[12px] align-middle">
                        {sortDir === "desc" ? "arrow_downward" : "arrow_upward"}
                      </span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((row, i) => {
                const successColor =
                  row.successRate >= 95
                    ? "text-emerald-500"
                    : row.successRate >= 80
                      ? "text-amber-500"
                      : "text-red-500";
                // Guard p95: a percentile from a handful of samples is misleading.
                const p95 = latencyDisplay(row.p95Latency, row.latencySampleCount);

                return (
                  <tr
                    key={row.provider}
                    className="border-b border-border-subtle transition-colors hover:bg-surface-2/30"
                  >
                    <td className="px-3 py-2.5">
                      <Link
                        href={`/dashboard/providers/${row.provider}`}
                        className="flex items-center gap-2"
                      >
                        <span className="text-[10px] font-mono text-text-muted w-4">
                          {i + 1}
                        </span>
                        <div className="flex size-6 shrink-0 items-center justify-center rounded">
                          <ProviderIcon
                            src={getProviderIconPath(row.provider)}
                            alt={row.provider}
                            size={24}
                            className="object-contain rounded"
                            fallbackText={row.provider?.slice(0, 2).toUpperCase()}
                            fallbackColor={row.color}
                          />
                        </div>
                        <span className="truncate text-xs font-medium text-text-primary">
                          {row.displayName}
                        </span>
                      </Link>
                    </td>
                    <td className="px-3 py-2.5 text-xs tabular-nums text-text-primary">
                      {row.requests.toLocaleString()}
                    </td>
                    <td className="px-3 py-2.5 text-xs tabular-nums text-text-muted">
                      {formatTokens(row.totalTokens)}
                    </td>
                    <td className="px-3 py-2.5 text-xs tabular-nums text-text-muted">
                      {formatMs(row.avgTtft)}
                    </td>
                    <td className="px-3 py-2.5 text-xs tabular-nums">
                      {p95.insufficient ? (
                        <span
                          className="text-amber-500"
                          title={`${row.latencySampleCount} latency sample${row.latencySampleCount === 1 ? "" : "s"} this period — need at least ${LATENCY_MIN_SAMPLES}`}
                        >
                          insufficient data
                        </span>
                      ) : (
                        <span className="text-text-muted">{p95.value}</span>
                      )}
                    </td>
                    <td className={`px-3 py-2.5 text-xs font-medium tabular-nums ${successColor}`}>
                      {row.successRate.toFixed(1)}%
                    </td>
                    <td className="px-3 py-2.5 text-xs tabular-nums text-text-muted">
                      {formatCost(row.cost)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
