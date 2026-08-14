"use client";

import { useState, useEffect, useRef } from "react";
import ModelSelectModal from "@/shared/components/ModelSelectModal";
import { STRATEGY_OPTIONS, getStrategyMeta, getStrategyLabel } from "./helpers";
import { latencyDisplay, formatLatencyMs } from "@/shared/utils/latencyDisplay";

const INPUT_TOKEN_OPTIONS = [500, 1000, 2000, 5000, 10000, 25000, 50000, 100000];
const ALL_STRATEGIES = STRATEGY_OPTIONS.map((o) => o.value);

const fmtUsd = (n) => (typeof n === "number" && Number.isFinite(n) ? `$${n.toFixed(4).replace(/\.?0+$/, "")}` : "—");
const fmtPct = (n) => (typeof n === "number" && Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : "—");
const fmtCalls = (n) => (typeof n === "number" && Number.isFinite(n) ? (Number.isInteger(n) ? String(n) : n.toFixed(1)) : "—");

const AXIS_LABELS = {
  latency: "Latency",
  cost: "Cost",
  reliability: "Reliability",
};

/**
 * Combo Lab — what-if engine on top of the Combo Simulator. Compares routing
 * strategies side-by-side using historical latency + reliability + pricing
 * (server-side /api/combos/lab) and recommends the best fit for the member set.
 * Weight sliders re-tune the axis mix; the engine renormalizes over whichever
 * axes have data.
 */
export default function ComboLabPanel({ activeProviders = [] }) {
  const [modelRefs, setModelRefs] = useState([]);
  const [inputText, setInputText] = useState("");
  const [inputTokens, setInputTokens] = useState(1000);
  const [weights, setWeights] = useState({ latency: 40, cost: 40, reliability: 20 });
  const [strategies, setStrategies] = useState([...ALL_STRATEGIES]);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [showModelSelect, setShowModelSelect] = useState(false);
  const [modelAliases, setModelAliases] = useState({});
  const seqRef = useRef(0);

  // Model suggestions for the datalist (provider/model refs the user can type).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/models");
        if (!cancelled && res.ok) {
          const data = await res.json();
          // Dedupe: /api/models is deduped at the source, but stay defensive so a
          // duplicate ref can never produce duplicate <option> keys here.
          setSuggestions([...new Set((data.models || []).map((m) => m.fullModel).filter(Boolean))].sort());
        }
      } catch { /* non-fatal */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Aliases for the ModelSelectModal popup (same source ComboFormModal uses).
  useEffect(() => {
    let cancelled = false;
    fetch("/api/models/alias")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d) setModelAliases(d.aliases || {}); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const parseInput = (text) => [...new Set(text.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean))];

  // Single source of truth for both the text input and the popup: keep the
  // textarea text in sync with the ref list whenever it changes programmatically.
  const applyModelRefs = (next) => {
    setModelRefs(next);
    setInputText(next.join(", "));
  };

  const handleInputChange = (value) => {
    setInputText(value);
    setModelRefs(parseInput(value));
  };

  const removeModel = (ref) => {
    applyModelRefs(modelRefs.filter((m) => m !== ref));
  };

  const handleAddModel = (model) => {
    const value = model?.value;
    if (!value || modelRefs.includes(value)) return;
    applyModelRefs([...modelRefs, value]);
  };

  const handleDeselectModel = (model) => {
    const value = model?.value;
    if (!value) return;
    applyModelRefs(modelRefs.filter((m) => m !== value));
  };

  // Renormalize slider weights to sum to 100 before sending (engine renormalizes
  // again over active axes — this just keeps the sliders intuitive).
  const sendableWeights = () => {
    const raw = {
      latency: weights.latency,
      cost: weights.cost,
      reliability: weights.reliability,
    };
    const sum = raw.latency + raw.cost + raw.reliability;
    if (sum <= 0) return { latency: 0.4, cost: 0.4, reliability: 0.2 };
    return {
      latency: raw.latency / sum,
      cost: raw.cost / sum,
      reliability: raw.reliability / sum,
    };
  };

  const toggleStrategy = (s) => {
    setStrategies((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  };

  useEffect(() => {
    if (modelRefs.length === 0) {
      setResult(null);
      setError("");
      return;
    }
    if (strategies.length < 1) return;
    const seq = ++seqRef.current;
    setLoading(true);
    setError("");
    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/combos/lab", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            models: modelRefs,
            inputTokens,
            weights: sendableWeights(),
            strategies,
          }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data?.error || "Analysis failed");
        }
        const data = await res.json();
        if (seq === seqRef.current) setResult(data);
      } catch (e) {
        if (seq === seqRef.current) {
          setError(e?.message || "Analysis failed");
          setResult(null);
        }
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelRefs.join("|"), inputTokens, weights.latency, weights.cost, weights.reliability, strategies.join("|")]);

  const comparison = result?.comparison || [];
  const maxScore = Math.max(...comparison.map((s) => s.score || 0), 1e-9);
  const coverage = result?.dataCoverage;

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-border-subtle bg-surface-2/50 p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[16px] text-primary">science</span>
            <span className="text-xs font-medium text-text-main">Combo Lab — what-if analysis</span>
            {loading && <span className="text-[10px] text-text-muted">analyzing…</span>}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-text-muted">assumed input</span>
            <select
              value={inputTokens}
              onChange={(e) => setInputTokens(Number(e.target.value))}
              className="rounded border border-border-subtle bg-surface-1 px-1.5 py-0.5 text-[10px] text-text-main"
            >
              {INPUT_TOKEN_OPTIONS.map((t) => (
                <option key={t} value={t}>{t >= 1000 ? `${t / 1000}k` : t} tok</option>
              ))}
            </select>
          </div>
        </div>

        {/* Member refs */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-stretch gap-1.5">
            <input
              list="combo-lab-models"
              value={inputText}
              onChange={(e) => handleInputChange(e.target.value)}
              placeholder="provider/model, provider/model — e.g. cc/claude-opus-4-7, gh/gpt-5.3-codex"
              className="min-w-0 flex-1 rounded-lg border border-border-subtle bg-surface-1 px-2.5 py-1.5 font-mono text-[11px] text-text-main placeholder:text-text-muted/60 focus:border-primary/50 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => setShowModelSelect(true)}
              className="flex shrink-0 items-center gap-1 rounded-lg border border-dashed border-border px-2.5 py-1.5 text-[11px] font-medium text-primary transition-colors hover:border-primary/50 hover:bg-primary/5"
              title="Pick models from the provider catalog (same picker as Add Model in combos)"
            >
              <span className="material-symbols-outlined text-[14px]">add</span>
              Add Model
            </button>
          </div>
          <datalist id="combo-lab-models">
            {suggestions.map((s) => <option key={s} value={s} />)}
          </datalist>
          {modelRefs.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {modelRefs.map((m) => (
                <span key={m} className="flex items-center gap-1 rounded bg-surface-1 px-1.5 py-0.5 font-mono text-[10px] text-text-main">
                  {m}
                  <button onClick={() => removeModel(m)} className="text-text-muted hover:text-red-400" title="Remove">×</button>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Weights + strategies */}
        <div className="mt-2.5 flex flex-col gap-2.5 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] uppercase tracking-wide text-text-muted">Axis weights</span>
            {["latency", "cost", "reliability"].map((axis) => (
              <label key={axis} className="flex items-center gap-2 text-[11px] text-text-muted">
                <span className="w-16">{AXIS_LABELS[axis]}</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={weights[axis]}
                  onChange={(e) => setWeights((prev) => ({ ...prev, [axis]: Number(e.target.value) }))}
                  className="h-1 w-32 accent-primary"
                />
                <span className="w-8 text-right font-mono text-[10px] text-text-main">{weights[axis]}%</span>
              </label>
            ))}
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] uppercase tracking-wide text-text-muted">Compare strategies</span>
            <div className="flex flex-wrap gap-1.5">
              {STRATEGY_OPTIONS.map((opt) => {
                const on = strategies.includes(opt.value);
                const meta = getStrategyMeta(opt.value);
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => toggleStrategy(opt.value)}
                    title={opt.desc}
                    className={`flex items-center gap-1 rounded-md border px-1.5 py-1 text-[10px] transition-colors ${
                      on
                        ? "border-primary/40 bg-primary/10 text-text-main"
                        : "border-border-subtle bg-surface-1 text-text-muted/60 hover:text-text-muted"
                    }`}
                  >
                    <span className="material-symbols-outlined text-[13px]" style={{ color: on ? undefined : meta.color }}>{opt.icon}</span>
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {modelRefs.length === 0 ? (
        <p className="rounded-lg border border-border-subtle bg-surface-2/50 p-4 text-center text-[11px] text-text-muted">
          Enter at least one model (provider/model) to compare strategies against historical latency, cost and reliability.
        </p>
      ) : error ? (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">{error}</p>
      ) : !result ? (
        <p className="rounded-lg border border-border-subtle bg-surface-2/50 p-4 text-center text-[11px] text-text-muted">Analyzing…</p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {/* Recommendation */}
          {result.recommendation && (
            <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5">
              <span className="material-symbols-outlined text-[18px] text-emerald-400">recommend</span>
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-text-main">Recommended: {getStrategyLabel(result.recommendation.strategy)}</span>
                  {(() => {
                    const meta = getStrategyMeta(result.recommendation.strategy);
                    return <span className="material-symbols-outlined text-[14px]" style={{ color: meta.color }}>{meta.icon}</span>;
                  })()}
                </div>
                <p className="text-[11px] text-emerald-200/80">{result.recommendation.reason}</p>
                {result.recommendation.runnerUp && (
                  <p className="text-[10px] text-text-muted">
                    Runner-up: {getStrategyLabel(result.recommendation.runnerUp.strategy)} (score {(result.recommendation.runnerUp.score * 100).toFixed(0)})
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Live-health warning */}
          {result.atRiskProviders?.length > 0 && (
            <div className="flex items-start gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5">
              <span className="material-symbols-outlined text-[14px] text-amber-400">warning</span>
              <p className="text-[11px] text-amber-300">
                Provider{result.atRiskProviders.length > 1 ? "s" : ""} currently locked or breaker-open:{" "}
                {result.atRiskProviders.join(", ")} — expect failures on those members right now.
              </p>
            </div>
          )}

          {/* Data coverage */}
          {coverage && (
            <p className="text-[10px] text-text-muted">
              Data coverage: latency {coverage.latency.known}/{coverage.latency.total} · reliability {coverage.reliability.known}/{coverage.reliability.total} · pricing{" "}
              {coverage.cost.known}/{coverage.cost.total} member{coverage.cost.total !== 1 ? "s" : ""} (30d usage history).
              {coverage.reliability.known < coverage.reliability.total && " Members without history are assumed 90% reliable."}
            </p>
          )}

          {/* Comparison table */}
          <div className="overflow-x-auto rounded-lg border border-border-subtle bg-surface-2/50">
            <table className="w-full min-w-[640px] text-left">
              <thead>
                <tr className="border-b border-border-subtle text-[9px] uppercase tracking-wide text-text-muted">
                  <th className="px-2.5 py-1.5 font-medium">#</th>
                  <th className="px-2.5 py-1.5 font-medium">Strategy</th>
                  <th className="px-2.5 py-1.5 font-medium">Score</th>
                  <th className="px-2.5 py-1.5 font-medium">Calls (typ)</th>
                  <th className="px-2.5 py-1.5 font-medium">Latency p95</th>
                  <th className="px-2.5 py-1.5 font-medium">Cost / req</th>
                  <th className="px-2.5 py-1.5 font-medium">Reliability</th>
                </tr>
              </thead>
              <tbody>
                {comparison.map((s, i) => {
                  const meta = getStrategyMeta(s.strategy);
                  const lat = latencyDisplay(s.wallClockP95Ms, null);
                  const isTop = result.recommendation && s.strategy === result.recommendation.strategy;
                  return (
                    <tr key={s.strategy} className={`border-b border-border-subtle/50 last:border-0 ${isTop ? "bg-emerald-500/5" : ""}`}>
                      <td className="px-2.5 py-1.5 text-[11px] text-text-muted">{i + 1}</td>
                      <td className="px-2.5 py-1.5">
                        <div className="flex items-center gap-1.5">
                          <span className="material-symbols-outlined text-[15px]" style={{ color: meta.color }}>{meta.icon}</span>
                          <span className="text-[11px] font-medium text-text-main">{getStrategyLabel(s.strategy)}</span>
                          {isTop && (
                            <span className="rounded bg-emerald-500/20 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-400">
                              Best
                            </span>
                          )}
                          {s.invalid && (
                            <span className="rounded bg-red-500/20 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-red-400" title={s.invalidReasons.join(" · ")}>
                              Invalid
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-2.5 py-1.5">
                        <div className="flex items-center gap-1.5">
                          <div className="h-1.5 w-16 overflow-hidden rounded bg-surface-1">
                            <div className="h-full rounded bg-primary" style={{ width: `${Math.round((s.score / maxScore) * 100)}%` }} />
                          </div>
                          <span className="text-[10px] font-mono text-text-main">{s.score != null ? s.score.toFixed(2) : "—"}</span>
                        </div>
                      </td>
                      <td className="px-2.5 py-1.5 text-[11px] text-text-muted">
                        {fmtCalls(s.expectedCalls)}
                        {s.calls && (s.calls.min !== s.calls.max) && (
                          <span className="text-[9px] text-text-muted/70"> ({s.calls.min}–{s.calls.max})</span>
                        )}
                      </td>
                      <td className="px-2.5 py-1.5 text-[11px] text-text-main" title={s.wallClockP95Ms != null ? `${s.wallClockP95Ms}ms` : ""}>
                        {s.wallClockP95Ms != null ? formatLatencyMs(s.wallClockP95Ms) : "—"}
                      </td>
                      <td className="px-2.5 py-1.5 text-[11px] text-text-main">{fmtUsd(s.expectedCostUsd)}</td>
                      <td className="px-2.5 py-1.5 text-[11px] text-text-main">{fmtPct(s.reliability)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="text-[9px] leading-relaxed text-text-muted">
            Expected = typical request (midpoint of the runtime call range). Cost uses the same per-leaf formula as the runtime budget guard
            (output capped 4k tokens/call, input assumed {inputTokens}). Latency = expected wall-clock p95 including parallel fanout (fusion panel,
            swarm workers). Reliability = success rate from 30d usage history per model. Axis scores are normalized relative to the best strategy;
            weights renormalize over axes with data.
          </p>
        </div>
      )}

      {/* Same picker as "Add Model" in the Combo form — provider-grouped catalog
          with search, combos section, custom models, and click-to-toggle. */}
      <ModelSelectModal
        isOpen={showModelSelect}
        onClose={() => setShowModelSelect(false)}
        onSelect={handleAddModel}
        onDeselect={handleDeselectModel}
        activeProviders={activeProviders}
        modelAliases={modelAliases}
        addedModelValues={modelRefs}
        closeOnSelect={false}
        title="Add Model to Combo Lab"
      />
    </div>
  );
}
