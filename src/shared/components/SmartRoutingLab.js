"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import Badge from "@/shared/components/Badge";
import { cn } from "@/shared/utils/cn";
import {
  REASON_META,
  ModelChip,
  intentDescription,
  statusVariant,
  statusLabel,
  formatDuration,
} from "@/shared/components/SmartRoutingTelemetryMonitor";

const STRATEGY_META = {
  fallback: {
    label: "Fallback",
    icon: "format_list_numbered",
    desc: "Plain ordered chain — member 1 first, then 2, … until one answers.",
    variant: "default",
  },
  "smart-routing": {
    label: "Smart Routing",
    icon: "alt_route",
    desc: "Tool-calling → API models only · Research → cookie pool first · else default chain.",
    variant: "info",
  },
  swarm: {
    label: "Hierarchical Swarm",
    icon: "hub",
    desc: "Gatekeeper triage → manager strategy → parallel workers → staff audit → manager synthesis.",
    variant: "primary",
  },
};

const TOOL_REASONS = new Set(["tool_calling", "tool_calling_pool_empty_fallback"]);

function formatUsd(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n === 0) return "$0";
  if (n < 0.001) return `$${n.toPrecision(2)}`;
  return `$${n.toFixed(4).replace(/\.?0+$/, "")}`;
}

function formatCalls(calls) {
  if (!calls) return "—";
  if (calls.min === calls.max) return `${calls.min}`;
  return `${calls.min}–${calls.max}`;
}

function formatPct(r) {
  if (r == null || !Number.isFinite(r)) return "—";
  return `${Math.round(r * 100)}%`;
}

const MATCH_META = {
  served: { label: "✓ Matched", variant: "success" },
  different: { label: "Different", variant: "warning" },
  failed: { label: "No answer", variant: "error" },
  no_data: { label: "No data", variant: null },
};

function RealityBadge({ entry }) {
  if (!entry) return null;
  const meta = MATCH_META[entry.match] || MATCH_META.no_data;
  if (!meta.variant) {
    return <span className="text-xs text-text-subtle">No data</span>;
  }
  return <Badge variant={meta.variant} size="sm">{meta.label}</Badge>;
}

export default function SmartRoutingLab({ compareRun, onRunConsumed }) {
  const [runs, setRuns] = useState([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [hadTools, setHadTools] = useState(false);
  const [inputTokens, setInputTokens] = useState(1000);
  const [strategies, setStrategies] = useState(["fallback", "smart-routing", "swarm"]);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [expandedStrategy, setExpandedStrategy] = useState(null);
  const lastRanRef = useRef(null);
  const compareRef = useRef(compareRun);

  // Load the run picker options (recent history, newest first).
  useEffect(() => {
    let cancelled = false;
    fetch("/api/smart-routing/history?pageSize=50")
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setRuns(data.runs || []);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const loadRunIntoForm = useCallback((run) => {
    if (!run) return;
    setSelectedRunId(run.runId);
    setPrompt(run.lastUserMessage || run.promptPreview || "");
    setHadTools(TOOL_REASONS.has(run.routing?.reason));
  }, []);

  const runComparison = useCallback(async (run, overrides = {}) => {
    const usePrompt =
      overrides.prompt !== undefined ? overrides.prompt
        : run ? (run.lastUserMessage || run.promptPreview || "")
        : prompt;
    const useTools =
      overrides.hadTools !== undefined ? overrides.hadTools
        : run ? TOOL_REASONS.has(run.routing?.reason)
        : hadTools;
    const strategyList = strategies.filter((s) => STRATEGY_META[s]);
    if (strategyList.length === 0) {
      setError("Select at least one strategy to compare");
      return;
    }
    if (!usePrompt.trim()) {
      setError("Enter a prompt (or pick a request from history)");
      return;
    }

    setLoading(true);
    setError(null);
    lastRanRef.current = {
      prompt: usePrompt,
      hadTools: useTools,
      inputTokens,
      runId: run?.runId || null,
    };
    try {
      const res = await fetch("/api/smart-routing/lab", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: run?.runId || null,
          prompt: usePrompt,
          hadTools: useTools,
          strategies: strategyList,
          inputTokens,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Lab comparison failed");
        setResult(null);
      } else {
        setResult(data);
      }
    } catch (err) {
      console.error("Lab comparison failed:", err);
      setError("Lab comparison failed — server unreachable");
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [prompt, hadTools, inputTokens, strategies]);

  // Compare clicked from the history table → load that run + run immediately.
  useEffect(() => {
    if (compareRun && compareRun.runId !== compareRef.current?.runId) {
      compareRef.current = compareRun;
      loadRunIntoForm(compareRun);
      runComparison(compareRun);
      onRunConsumed?.();
    }
  }, [compareRun, loadRunIntoForm, runComparison, onRunConsumed]);

  const toggleStrategy = (key) => {
    setStrategies((prev) =>
      prev.includes(key) ? prev.filter((s) => s !== key) : [...prev, key],
    );
  };

  const handleRunSelect = (runId) => {
    setSelectedRunId(runId);
    const run = runs.find((r) => r.runId === runId);
    if (run) {
      loadRunIntoForm(run);
      runComparison(run);
    }
  };

  return (
    <Card padding="lg">
      <div className="mb-4 flex items-center gap-2">
        <span className="material-symbols-outlined text-[20px] text-primary">science</span>
        <h2 className="text-base font-semibold text-text-main">A/B Lab — Strategy Comparison</h2>
        <span className="text-xs text-text-muted">Simulate fallback vs smart-routing vs swarm on the same request</span>
      </div>

      {/* Request source */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
        <div className="flex min-w-0 flex-col gap-2">
          <label htmlFor="lab-run-picker" className="text-sm font-medium text-text-main">Request from history</label>
          <select
            id="lab-run-picker"
            value={selectedRunId}
            onChange={(e) => handleRunSelect(e.target.value)}
            className="h-9 w-full cursor-pointer rounded-lg border border-border bg-surface-2 px-3 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20"
          >
            <option value="">— select a past request —</option>
            {runs.map((r) => (
              <option key={r.runId} value={r.runId}>
                {r.comboName || "unknown combo"} · {(r.promptPreview || "").slice(0, 60) || "no preview"}
              </option>
            ))}
          </select>
          {runs.length === 0 && (
            <p className="text-xs text-text-muted">No history yet — type a prompt below instead.</p>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-2">
          <label htmlFor="lab-prompt" className="text-sm font-medium text-text-main">Prompt (editable)</label>
          <textarea
            id="lab-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={2}
            placeholder="e.g. research the latest AI trends and cite sources…"
            className="w-full resize-y rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>
      </div>

      {/* Toggles */}
      <div className="mt-4 flex flex-wrap items-end gap-x-8 gap-y-3">
        <label className="flex cursor-pointer items-center gap-2 text-sm text-text-main">
          <input
            type="checkbox"
            checked={hadTools}
            onChange={(e) => setHadTools(e.target.checked)}
            className="h-4 w-4 accent-primary"
          />
          Simulate tool-calling request (tools[])
        </label>

        <label className="flex items-center gap-2 text-sm text-text-main">
          Input tokens
          <input
            type="number"
            min={1}
            value={inputTokens}
            onChange={(e) => setInputTokens(Math.max(1, Number(e.target.value) || 1))}
            className="h-9 w-24 rounded-lg border border-border bg-surface-2 px-3 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-text-main">Strategies:</span>
          {Object.entries(STRATEGY_META).map(([key, meta]) => (
            <button
              key={key}
              type="button"
              onClick={() => toggleStrategy(key)}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                strategies.includes(key)
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border bg-surface-2 text-text-muted hover:border-border-subtle",
              )}
            >
              <span className="material-symbols-outlined text-[14px]">{meta.icon}</span>
              {meta.label}
            </button>
          ))}
        </div>

        <Button onClick={() => runComparison(null)} disabled={loading} className="ml-auto">
          {loading ? "Comparing…" : "Run Comparison"}
        </Button>
      </div>

      {error && <div className="mt-4 rounded-lg border border-danger/20 bg-danger/5 px-3 py-2 text-sm text-danger">{error}</div>}

      {/* Results */}
      {result && !loading && <LabResults result={result} expanded={expandedStrategy} onToggle={setExpandedStrategy} ran={lastRanRef.current} />}
    </Card>
  );
}

function LabResults({ result, expanded, onToggle, ran }) {
  const strategies = result.strategies || [];
  if (strategies.length === 0) return null;
  const hasAnyResearch = strategies.some((s) => s.reason?.startsWith("research"));
  const reality = result.reality || null;
  const atRisk = result.atRiskModels || [];
  const reliabilityEntries = Object.entries(result.reliability || {});

  return (
    <div className="mt-6 flex flex-col gap-4">
      {/* Request context line */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border-subtle bg-surface-2/50 px-3 py-2 text-xs text-text-muted">
        <span className="max-w-[420px] truncate font-mono text-text-main">“{ran?.prompt || result.request?.prompt || ""}”</span>
        {result.comboName && <span>combo: <span className="font-mono text-text-main">{result.comboName}</span></span>}
        <span>{result.memberCount} members</span>
        <span>{result.request?.hadTools ? "tools: yes" : "tools: no"}</span>
        <span>{result.assumptions?.inputTokens} tok/call</span>
        {result.originalReason && (
          <span>
            original: <Badge variant={REASON_META[result.originalReason]?.variant || "default"} size="sm">{REASON_META[result.originalReason]?.label || result.originalReason}</Badge>
          </span>
        )}
      </div>

      {/* Comparison table: one column per strategy */}
      <div className="overflow-x-auto rounded-lg border border-border-subtle">
        <table className="w-full min-w-[720px]">
          <thead>
            <tr className="border-b border-border-subtle bg-surface-2/40">
              <th className="p-3 text-left text-sm font-semibold text-text-main">Metric</th>
              {strategies.map((s) => {
                const meta = STRATEGY_META[s.strategy] || {};
                return (
                  <th key={s.strategy} className="p-3 text-left">
                    <div className="flex items-center gap-1.5 text-sm font-semibold text-text-main">
                      <span className="material-symbols-outlined text-[16px] text-text-subtle">{meta.icon}</span>
                      {meta.label}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="align-top">
            {/* Primary / first responder */}
            <tr className="border-b border-border-subtle">
              <td className="p-3 text-sm font-medium text-text-muted">First to answer</td>
              {strategies.map((s) => (
                <td key={s.strategy} className="p-3">
                  <div className="flex flex-col items-start gap-1.5">
                    <ModelChip model={s.primaryModel || "—"} index={1} risk={atRisk.includes(s.primaryModel)} />
                    {s.strategy === "smart-routing" && s.reason && (
                      <Badge variant={REASON_META[s.reason]?.variant || "default"} size="sm">
                        {REASON_META[s.reason]?.label || s.reason}
                      </Badge>
                    )}
                  </div>
                </td>
              ))}
            </tr>

            {/* Predicted vs reality (needs a compared run) */}
            {reality && (
              <tr className="border-b border-border-subtle">
                <td className="p-3 text-sm font-medium text-text-muted">Predicted vs reality</td>
                {strategies.map((s) => {
                  const entry = reality.strategies?.find((e) => e.strategy === s.strategy);
                  return (
                    <td key={s.strategy} className="p-3">
                      <div className="flex flex-col items-start gap-1">
                        <RealityBadge entry={entry} />
                        {entry?.match === "different" && reality.servedModel && (
                          <span className="font-mono text-xs text-text-muted">→ served {reality.servedModel}</span>
                        )}
                        {entry?.match === "failed" && (
                          <span className="text-xs text-text-muted">nothing answered on the real run</span>
                        )}
                      </div>
                    </td>
                  );
                })}
              </tr>
            )}

            {/* Calls */}
            <tr className="border-b border-border-subtle">
              <td className="p-3 text-sm font-medium text-text-muted">Logical calls</td>
              {strategies.map((s) => (
                <td key={s.strategy} className="p-3 font-mono text-sm text-text-main">{formatCalls(s.calls)}</td>
              ))}
            </tr>

            {/* Cost */}
            <tr className="border-b border-border-subtle">
              <td className="p-3 text-sm font-medium text-text-muted">Est. cost / request</td>
              {strategies.map((s) => (
                <td key={s.strategy} className="p-3 font-mono text-sm text-text-main">
                  <span className="text-text-muted">{formatUsd(s.cost?.optimistic)}</span>
                  {" – "}
                  <span>{formatUsd(s.cost?.worst)}</span>
                </td>
              ))}
            </tr>

            {/* Per-call */}
            <tr className="border-b border-border-subtle">
              <td className="p-3 text-sm font-medium text-text-muted">Per call</td>
              {strategies.map((s) => (
                <td key={s.strategy} className="p-3 font-mono text-sm text-text-muted">{formatUsd(s.cost?.perCall)}</td>
              ))}
            </tr>

            {/* Pool size */}
            <tr className="border-b border-border-subtle">
              <td className="p-3 text-sm font-medium text-text-muted">Pool tried</td>
              {strategies.map((s) => (
                <td key={s.strategy} className="p-3 text-sm text-text-muted">
                  {s.order.length} model{s.order.length === 1 ? "" : "s"}
                  {s.excludedCookies?.length > 0 && (
                    <span className="text-danger"> · {s.excludedCookies.length} cookie{s.excludedCookies.length === 1 ? "" : "s"} excluded</span>
                  )}
                  {s.strategy === "swarm" && Object.keys(s.roleModels || {}).length > 0 && (
                    <span className="text-text-subtle"> · +{Object.keys(s.roleModels).length} role call{Object.keys(s.roleModels).length === 1 ? "" : "s"}</span>
                  )}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      {/* Reality strip — what actually happened on the original run */}
      {reality && reality.status && (
        <div
          className={cn(
            "flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border px-3 py-2 text-xs",
            reality.status === "error"
              ? "border-danger/20 bg-danger/5 text-danger"
              : "border-border-subtle bg-surface-2/50 text-text-muted",
          )}
        >
          <span className="flex items-center gap-1.5">
            <span className="material-symbols-outlined text-[15px]">fact_check</span>
            <span className="font-semibold text-text-main">Reality</span>
          </span>
          <Badge variant={statusVariant(reality.status)} size="sm">{statusLabel(reality.status)}</Badge>
          {reality.originalReason && (
            <span>
              original:{" "}
              <Badge variant={REASON_META[reality.originalReason]?.variant || "default"} size="sm">
                {REASON_META[reality.originalReason]?.label || reality.originalReason}
              </Badge>
            </span>
          )}
          {reality.servedModel ? (
            <span>served: <span className="font-mono text-text-main">{reality.servedModel}</span></span>
          ) : reality.status === "error" ? (
            <span>no model answered — chain failed</span>
          ) : (
            <span>no served model recorded</span>
          )}
          {reality.totalDurationMs != null && (
            <span className="font-mono">{formatDuration(reality.totalDurationMs)}</span>
          )}
          {reality.fellThrough && (
            <span className="text-warning">predicted head failed → chain fell through</span>
          )}
          {reality.status === "error" && reality.error && (
            <span className="max-w-[420px] truncate">{reality.error}</span>
          )}
        </div>
      )}

      {/* Pool split note */}
      {result.pool && (result.pool.cookie.length > 0 || hasAnyResearch) && (
        <p className="text-xs text-text-muted">
          Cookie providers in pool:{" "}
          <span className="font-mono text-text-subtle">{result.pool.cookie.length > 0 ? result.pool.cookie.join(", ") : "none"}</span>
          {" · "}normal: <span className="font-mono text-text-subtle">{result.pool.normal.map((m) => m.split("/")[0]).join(", ") || "none"}</span>
        </p>
      )}

      {/* Per-model production reliability (30d) with at-risk flags */}
      {reliabilityEntries.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-border-subtle bg-surface-2/40 px-3 py-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-text-muted">
            <span className="material-symbols-outlined text-[14px]">monitor_heart</span>
            Production reliability (30d)
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            {reliabilityEntries.map(([model, o]) => {
              const risk = atRisk.includes(model);
              return (
                <span key={model} className={cn("flex items-center gap-1 font-mono text-xs", risk ? "text-danger" : "text-text-muted")}>
                  <span className="truncate max-w-[180px]">{model}</span>
                  <span className="font-medium">{formatPct(o.successRate)}</span>
                  <span className="text-text-subtle">({o.total} req)</span>
                  {risk && <span className="material-symbols-outlined text-[13px]">warning</span>}
                </span>
              );
            })}
          </div>
          {atRisk.length > 0 && (
            <p className="text-xs text-danger">
              ⚠ {atRisk.join(", ")} fail{atRisk.length === 1 ? "s" : ""} ≥ 50% of requests (30d) — smart-routing pushes these behind
              healthier members automatically.
            </p>
          )}
        </div>
      )}

      {/* Per-strategy detail cards (expandable) */}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        {strategies.map((s) => {
          const meta = STRATEGY_META[s.strategy] || {};
          const open = expanded === s.strategy;
          return (
            <div key={s.strategy} className="overflow-hidden rounded-lg border border-border-subtle">
              <button
                type="button"
                onClick={() => onToggle(open ? null : s.strategy)}
                className="flex w-full items-center justify-between gap-2 bg-surface-2/40 px-3 py-2.5 text-left"
              >
                <span className="flex items-center gap-2 text-sm font-semibold text-text-main">
                  <span className="material-symbols-outlined text-[16px] text-text-subtle">{meta.icon}</span>
                  {meta.label}
                </span>
                <span className={cn("material-symbols-outlined text-[18px] text-text-subtle transition-transform", open && "rotate-180")}>
                  expand_more
                </span>
              </button>
              {open && <StrategyDetail s={s} atRisk={atRisk} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StrategyDetail({ s, atRisk = [] }) {
  const meta = STRATEGY_META[s.strategy] || {};
  return (
    <div className="flex flex-col gap-3 px-3 py-3">
      <p className="text-xs text-text-muted">{meta.desc}</p>

      {s.strategy === "smart-routing" && s.reason && (
        <div className="flex flex-col gap-1 rounded-md border border-border-subtle bg-surface-2/50 p-2.5">
          <div className="flex items-center gap-2">
            <Badge variant={REASON_META[s.reason]?.variant || "default"} size="sm">{REASON_META[s.reason]?.label || s.reason}</Badge>
            {s.intent && <span className="text-xs text-text-muted">{intentDescription({ ...s.intent, source: "heuristic" })}</span>}
          </div>
          <p className="text-xs text-text-muted">{REASON_META[s.reason]?.desc || ""}</p>
        </div>
      )}

      {s.strategy === "swarm" && Object.keys(s.roleModels || {}).length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-text-muted">Roles</span>
          {Object.entries(s.roleModels).map(([role, model]) => (
            <div key={role} className="flex items-center gap-2">
              <Badge variant="primary" size="sm">{role}</Badge>
              <ModelChip model={model} muted />
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-text-muted">Pool order ({s.order.length})</span>
        <div className="flex flex-wrap gap-1.5">
          {s.order.map((m, i) => (
            <ModelChip key={`${m}-${i}`} model={m} index={i + 1} risk={atRisk.includes(m)} />
          ))}
        </div>
      </div>

      {s.excludedCookies?.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-danger">Excluded for tool-calling ({s.excludedCookies.length})</span>
          <div className="flex flex-wrap gap-1.5">
            {s.excludedCookies.map((m) => (
              <ModelChip key={m} model={m} blocked />
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-x-5 gap-y-1 border-t border-border-subtle pt-2.5 text-xs text-text-muted">
        <span>Calls: <span className="font-mono text-text-main">{formatCalls(s.calls)}</span></span>
        <span>Per call: <span className="font-mono text-text-main">{formatUsd(s.cost?.perCall)}</span></span>
        <span>Cost: <span className="font-mono text-text-main">{formatUsd(s.cost?.optimistic)}–{formatUsd(s.cost?.worst)}</span></span>
      </div>
    </div>
  );
}
