"use client";

import { useState, useEffect } from "react";
import Badge from "@/shared/components/Badge";
import EmptyState from "@/shared/components/EmptyState";
import { cn } from "@/shared/utils/cn";
import { smartRoutingRunsReducer } from "@/shared/components/smartRoutingReducer";

/**
 * Human-readable metadata for each routing decision the backend can emit.
 * The variant maps to Badge variants (default/primary/success/warning/error/info/cyan).
 */
export const REASON_META = {
  tool_calling: {
    label: "Tool Calling",
    variant: "cyan",
    icon: "construction",
    desc: "tools / tool_choice / functions detected → routed only to tool-capable non-cookie models",
  },
  tool_calling_pool_empty_fallback: {
    label: "Tool Pool Empty",
    variant: "warning",
    icon: "construction",
    desc: "no tool-capable member in combo → used the full pool with a warning",
  },
  research_cookie_primary: {
    label: "Research → Cookie Pool",
    variant: "info",
    icon: "travel_explore",
    desc: "research intent → cookie providers tried first, normal pool as fallback",
  },
  research_cookie_pool_empty: {
    label: "Research (No Cookies)",
    variant: "warning",
    icon: "travel_explore",
    desc: "research intent but no cookie provider in combo → default order",
  },
  general: {
    label: "General",
    variant: "default",
    icon: "route",
    desc: "no tool-calling, no research intent → default fallback chain",
  },
};

const SIGNAL_LABEL = {
  keyword: "keyword match",
  url: "URL detected",
  none: "no signal",
  empty: "empty prompt",
};

export function statusVariant(status) {
  if (status === "done") return "success";
  if (status === "running") return "info";
  if (status === "error") return "error";
  return "default";
}

export function statusLabel(status) {
  if (status === "done") return "Done";
  if (status === "running") return "Routing…";
  if (status === "error") return "Error";
  return "Pending";
}

export function formatDuration(ms) {
  if (!ms && ms !== 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTimeAgo(ts) {
  if (!ts) return "—";
  const diff = Date.now() - ts;
  if (diff < 5000) return "just now";
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return new Date(ts).toLocaleTimeString();
}

export function intentDescription(intent) {
  if (!intent) return null;
  const signal = SIGNAL_LABEL[intent.signal] || intent.signal || "no signal";
  const conf = Number.isFinite(intent.confidence) ? Math.round(intent.confidence * 100) : null;
  if (intent.source === "classifier") {
    return `classifier ${intent.classifierModel || "?"} → ${intent.intent} (heuristic: ${signal}${conf != null ? `, ${conf}%` : ""})`;
  }
  return `${signal}${conf != null ? ` (${conf}% confidence)` : ""} → ${intent.intent}`;
}

export function ModelChip({ model, index, blocked = false, muted = false, risk = false }) {
  return (
    <div
      title={risk ? `${model} fails frequently in production (30d)` : undefined}
      className={cn(
        "flex items-center gap-2 rounded-md border px-2.5 py-1.5 font-mono text-xs",
        blocked
          ? "border-danger/30 bg-danger/5 text-text-muted line-through decoration-danger/60"
          : muted
            ? "border-border-subtle bg-surface-2 text-text-subtle"
            : risk
              ? "border-danger/30 bg-danger/5 text-danger"
              : "border-border-subtle bg-surface-2 text-text-muted",
      )}
    >
      {index != null && <span className="text-[10px] text-text-subtle">#{index}</span>}
      <span className="truncate max-w-[200px]">{model}</span>
      {blocked && <span className="material-symbols-outlined text-[13px] text-danger">block</span>}
      {risk && <span className="material-symbols-outlined text-[13px] text-danger">warning</span>}
    </div>
  );
}

/**
 * The routing-decision body shared by the live monitor card and the history
 * table's expanded row: reason badge + description, intent detail, ordered
 * pool, cookie/normal split, excluded cookies and the served model.
 */
export function SmartRoutingRunDetail({ routing, servedModel, pendingLabel = "Resolving routing decision…" }) {
  if (!routing) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 text-xs text-text-muted">
        <span className="material-symbols-outlined text-[14px] animate-spin">progress_activity</span>
        {pendingLabel}
      </div>
    );
  }
  const meta = REASON_META[routing.reason] || REASON_META.general;
  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="flex items-start gap-2.5">
        <span className="material-symbols-outlined text-[18px] text-text-subtle">{meta.icon}</span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={meta.variant} size="sm">{meta.label}</Badge>
            {routing.intent && (
              <span className="text-[11px] text-text-subtle">{intentDescription(routing.intent)}</span>
            )}
          </div>
          <p className="mt-1 text-xs text-text-muted">{meta.desc}</p>
        </div>
      </div>

      {/* Ordered pool */}
      {routing.order?.length > 0 && (
        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
            Selected pool <span className="font-normal normal-case">(fallback order)</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {routing.order.map((m, i) => (
              <ModelChip key={i} model={m} index={i + 1} />
            ))}
          </div>
        </div>
      )}

      {/* Pool split for research routing */}
      {routing.reason === "research_cookie_primary" && (
        <div className="grid gap-2 sm:grid-cols-2">
          {routing.cookiePool?.length > 0 && (
            <div>
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Cookie pool (first)</div>
              <div className="flex flex-wrap gap-2">
                {routing.cookiePool.map((m, i) => <ModelChip key={i} model={m} />)}
              </div>
            </div>
          )}
          {routing.normalPool?.length > 0 && (
            <div>
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Normal pool (fallback)</div>
              <div className="flex flex-wrap gap-2">
                {routing.normalPool.map((m, i) => <ModelChip key={i} model={m} muted />)}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Excluded cookies (tool-calling request) */}
      {routing.excludedCookies?.length > 0 && (
        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
            Excluded cookie providers <span className="font-normal normal-case">(no tool calling)</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {routing.excludedCookies.map((m, i) => <ModelChip key={i} model={m} blocked />)}
          </div>
        </div>
      )}

      {/* Served model */}
      {servedModel && (
        <div className="flex items-center gap-2 border-t border-border-subtle pt-2.5">
          <span className="material-symbols-outlined text-[16px] text-success">check_circle</span>
          <span className="text-xs text-text-muted">Served by</span>
          <span className="truncate font-mono text-xs font-medium text-text-main">{servedModel}</span>
        </div>
      )}
    </div>
  );
}

export default function SmartRoutingTelemetryMonitor() {
  const [runs, setRuns] = useState([]);
  const [connected, setConnected] = useState(false);
  const [, forceRender] = useState(0);

  useEffect(() => {
    const es = new EventSource("/api/smart-routing/stream");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setRuns((prev) => smartRoutingRunsReducer(prev, data));
      } catch {
        // ignore parse errors
      }
    };
    return () => es.close();
  }, []);

  // Re-render every 30s so relative timestamps stay fresh without new events.
  useEffect(() => {
    const t = setInterval(() => forceRender((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  const activeRuns = runs.filter((r) => r.status === "running");
  const completedRuns = runs.filter((r) => r.status !== "running");

  return (
    <div className="flex flex-col gap-5">
      {/* Connection status */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-text-muted">
          <span className={cn("size-2 rounded-full", connected ? "bg-success animate-pulse" : "bg-danger")} />
          {connected ? "Live" : "Reconnecting…"}
        </div>
        {activeRuns.length > 0 && (
          <Badge variant="info" dot>{activeRuns.length} active run{activeRuns.length > 1 ? "s" : ""}</Badge>
        )}
      </div>

      {runs.length === 0 ? (
        <EmptyState
          icon="alt_route"
          title="No smart-routing runs yet"
          description="Routing decisions will appear here in real time. Send a request to a combo with the 'Smart Routing' strategy to see the reason, selected pool and excluded cookie providers per request."
        />
      ) : (
        <>
          {activeRuns.length > 0 && (
            <div className="flex flex-col gap-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">Active</h3>
              {activeRuns.map((run) => (
                <SmartRoutingRunCard key={run.runId} run={run} expanded />
              ))}
            </div>
          )}

          {completedRuns.length > 0 && (
            <div className="flex flex-col gap-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">Recent</h3>
              {completedRuns.slice(0, 10).map((run) => (
                <SmartRoutingRunCard key={run.runId} run={run} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SmartRoutingRunCard({ run, expanded = false }) {
  return (
    <div className={cn(
      "rounded-panel border bg-panel shadow-[var(--shadow-soft)]",
      run.status === "error" ? "border-danger/30" : "border-border-subtle"
    )}>
      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Badge variant={statusVariant(run.status)} dot size="sm">{statusLabel(run.status)}</Badge>
          <div className="min-w-0">
            <div className="truncate font-mono text-sm font-medium text-text-main">{run.comboName || "smart-routing"}</div>
            <div className="truncate text-xs text-text-muted">{formatTimeAgo(run.startedAt)}</div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-xs text-text-muted">
          {run.totalDurationMs && <span className="font-mono">{formatDuration(run.totalDurationMs)}</span>}
          {run.routing?.order?.length > 0 && (
            <span className="flex items-center gap-1">
              <span className="material-symbols-outlined text-[14px]">alt_route</span>
              {run.routing.order.length} pool
            </span>
          )}
        </div>
      </div>

      {/* Prompt preview */}
      {run.promptPreview && (
        <div className="border-b border-border-subtle px-4 py-2">
          <p className="truncate text-xs text-text-muted">{run.promptPreview}</p>
        </div>
      )}

      {/* Routing decision */}
      <SmartRoutingRunDetail routing={run.routing} servedModel={run.servedModel} />

      {/* Error detail */}
      {run.status === "error" && run.error && (
        <div className="border-t border-danger/20 bg-danger/5 px-4 py-2">
          <p className="text-xs text-danger">{run.error}</p>
        </div>
      )}
    </div>
  );
}
