"use client";

import { useState, useEffect, useCallback } from "react";
import Badge from "@/shared/components/Badge";
import EmptyState from "@/shared/components/EmptyState";
import { cn } from "@/shared/utils/cn";
import { AI_PROVIDERS } from "@/shared/constants/providers";

function formatProviderName(providerId) {
  const info = AI_PROVIDERS[providerId];
  if (info?.name) return info.name;
  return String(providerId || "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatLatency(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatCooldown(ms) {
  if (ms == null) return "";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

// Success-rate cell: green → red by value (0 = red, 1 = green).
function successHeat(rate) {
  if (rate == null) return { bg: "transparent", fg: "text-text-subtle" };
  const hue = Math.max(0, Math.min(120, Math.round(rate * 120)));
  return { bg: `hsl(${hue} 80% 45% / 0.20)`, fg: "text-text-main" };
}

// Latency cell: fast = green, slow = red, scaled to `max` ms.
function latencyHeat(ms, max = 15000) {
  if (ms == null) return { bg: "transparent", fg: "text-text-subtle" };
  const t = Math.min(ms / max, 1);
  const hue = Math.max(0, Math.min(120, Math.round((1 - t) * 120)));
  return { bg: `hsl(${hue} 80% 45% / 0.16)`, fg: "text-text-main" };
}

const BREAKER_META = {
  closed: { label: "Closed", variant: "success" },
  halfOpen: { label: "Probing", variant: "warning" },
  open: { label: "Open", variant: "error" },
};

export default function ProviderHealthHeatmap() {
  const [rows, setRows] = useState([]);
  const [connected, setConnected] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/health/overview");
      if (!res.ok) return;
      const data = await res.json();
      setRows(Array.isArray(data.providers) ? data.providers : []);
      setConnected(true);
    } catch {
      setConnected(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm text-text-muted">
          <span className={cn("size-2 rounded-full", connected ? "bg-success animate-pulse" : "bg-danger")} />
          {connected ? "Live · refreshes every 3s" : "Reconnecting…"}
        </div>
        {rows.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 text-xs text-text-muted">
            <span className="flex items-center gap-1"><span className="size-2 rounded-full bg-success" /> Healthy</span>
            <span className="flex items-center gap-1"><span className="size-2 rounded-full bg-warning" /> Degraded</span>
            <span className="flex items-center gap-1"><span className="size-2 rounded-full bg-danger" /> Unhealthy</span>
          </div>
        )}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon="grid_view"
          title="No provider health data"
          description="Send a request to any provider (or connect an account) and the heatmap will appear here with success rate, latency percentiles, breaker state, and connection cooldowns."
        />
      ) : (
        <div className="overflow-x-auto rounded-panel border border-border-subtle bg-panel shadow-[var(--shadow-soft)]">
          <table className="w-full min-w-[760px] border-collapse text-xs">
            <thead>
              <tr className="border-b border-border-subtle text-left text-[11px] uppercase tracking-wider text-text-subtle">
                <th className="px-3 py-2.5 font-medium">Provider</th>
                <th className="px-3 py-2.5 text-center font-medium">Success rate</th>
                <th className="px-3 py-2.5 text-center font-medium">p50</th>
                <th className="px-3 py-2.5 text-center font-medium">p95</th>
                <th className="px-3 py-2.5 text-center font-medium">p99</th>
                <th className="px-3 py-2.5 text-center font-medium">Errors</th>
                <th className="px-3 py-2.5 text-center font-medium">Breaker</th>
                <th className="px-3 py-2.5 text-center font-medium">Connections</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const h = r.health || {};
                const rate = h.successRate ?? null;
                const pct = rate != null ? Math.round(rate * 100) : null;
                const sHeat = successHeat(rate);
                const breakerMeta = r.breaker ? (BREAKER_META[r.breaker.state] || BREAKER_META.closed) : null;
                const connSummary = r.connections.length > 0
                  ? `${r.connections.length}${r.lockedConnections > 0 ? ` · ${r.lockedConnections} locked` : ""}`
                  : "—";
                const connTooltip = r.connections.length > 0
                  ? r.connections.map((c) => `${c.label}${c.cooldownActive ? " (cooldown)" : c.testStatus ? ` (${c.testStatus})` : ""}${c.lastError ? ` — ${c.lastError}` : ""}`).join("\n")
                  : "";

                return (
                  <tr key={r.id} className="border-b border-border-subtle/60 last:border-b-0 hover:bg-surface-2/40">
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-semibold text-text-main">{formatProviderName(r.id)}</span>
                        {r.cooldownActive && (
                          <span className="material-symbols-outlined text-[13px] text-danger" title="At least one connection is in cooldown">lock_clock</span>
                        )}
                      </div>
                      <div className="text-[10px] text-text-subtle">{r.id}</div>
                    </td>

                    <td className="px-3 py-2 text-center">
                      <span className={cn("inline-block min-w-[52px] rounded-md px-2 py-1 font-mono font-semibold", sHeat.fg)} style={{ background: sHeat.bg }}>
                        {pct != null ? `${pct}%` : "—"}
                      </span>
                    </td>

                    {["p50LatencyMs", "p95LatencyMs", "p99LatencyMs"].map((key) => {
                      const v = h[key];
                      const heat = latencyHeat(v);
                      return (
                        <td key={key} className="px-3 py-2 text-center">
                          <span className={cn("inline-block min-w-[52px] rounded-md px-2 py-1 font-mono", heat.fg)} style={{ background: heat.bg }}>
                            {formatLatency(v)}
                          </span>
                        </td>
                      );
                    })}

                    <td className="px-3 py-2 text-center">
                      <span className={cn("inline-block min-w-[40px] rounded-md px-2 py-1 font-mono font-semibold", h.failures > 0 ? "bg-danger/15 text-danger" : "text-text-subtle")}>
                        {h.failures || 0}
                      </span>
                    </td>

                    <td className="px-3 py-2 text-center">
                      {breakerMeta ? (
                        <Badge variant={breakerMeta.variant} dot size="sm">{breakerMeta.label}</Badge>
                      ) : (
                        <span className="text-text-subtle">—</span>
                      )}
                      {r.breaker?.state === "open" && r.breaker.cooldownRemainingMs != null && (
                        <div className="mt-0.5 text-[10px] text-text-muted">cooldown {formatCooldown(r.breaker.cooldownRemainingMs)}</div>
                      )}
                    </td>

                    <td className="px-3 py-2 text-center">
                      <span
                        className={cn(
                          "inline-block min-w-[52px] rounded-md px-2 py-1 font-mono",
                          r.lockedConnections > 0 ? "bg-danger/15 text-danger" : r.worstStatus === "active" ? "bg-success/15 text-success" : "text-text-subtle",
                        )}
                        title={connTooltip || undefined}
                      >
                        {connSummary}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
