"use client";

import { useState, useEffect, useRef } from "react";
import { getStrategyLabel } from "./helpers";
import { latencyDisplay } from "@/shared/utils/latencyDisplay";
import CapacityBadges from "@/shared/components/CapacityBadges";

const INPUT_TOKEN_OPTIONS = [500, 1000, 2000, 5000, 10000, 25000, 50000, 100000];

const fmtUsd = (n) => (typeof n === "number" && Number.isFinite(n) ? `$${n.toFixed(3).replace(/\.?0+$/, "")}` : "—");

// Combo Simulator — pre-save preview of what the runtime will actually do:
// logical calls (estimateCallsRange), cost (estimateLeafCostUsd — the exact
// formula combo_cost_budget_exceeded uses), capability compatibility
// (deriveComboCapabilities), per-member latency (aggregateModelLatency) and
// control-role violations (validateComboRoles). All composed server-side by
// /api/combos/simulate from the runtime's own pure functions — zero drift
// between the preview and the enforcement.
export default function SimulatorPanel({ models = [], strategyConfig = {}, onStrategyChange }) {
  const [inputTokens, setInputTokens] = useState(1000);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const seqRef = useRef(0);

  const strategy = strategyConfig?.fallbackStrategy || "fallback";

  useEffect(() => {
    if (!Array.isArray(models) || models.length === 0) {
      setResult(null);
      setError("");
      return;
    }
    const seq = ++seqRef.current;
    setLoading(true);
    setError("");
    (async () => {
      try {
        const res = await fetch("/api/combos/simulate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            models,
            strategyConfig,
            inputTokens,
            includeLatency: true,
          }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data?.error || "Simulation failed");
        }
        const data = await res.json();
        if (seq === seqRef.current) setResult(data.simulation);
      } catch (e) {
        if (seq === seqRef.current) {
          setError(e?.message || "Simulation failed");
          setResult(null);
        }
      } finally {
        if (seq === seqRef.current) setLoading(false);
      }
    })();
  }, [models, strategyConfig, inputTokens]);

  // Debounce: only update when the panel is open — parent renders it only when
  // models.length > 0, so this effect is cheap during model editing.
  const sim = result;

  const card = (label, value, sub, tone = "") => (
    <div className={`rounded-lg border border-border-subtle bg-surface-2/50 px-2.5 py-2 ${tone}`}>
      <div className="text-[10px] uppercase tracking-wide text-text-muted">{label}</div>
      <div className="mt-0.5 text-sm font-semibold text-text-main">{value}</div>
      {sub ? <div className="text-[10px] text-text-muted">{sub}</div> : null}
    </div>
  );

  return (
    <div className="rounded-lg border border-border-subtle bg-surface-2/50 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-[16px] text-primary">query_stats</span>
          <span className="text-xs font-medium text-text-main">Combo Simulator</span>
          {loading && <span className="text-[10px] text-text-muted">simulating…</span>}
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

      {!sim ? (
        <p className="py-2 text-center text-[11px] text-text-muted">
          {error || "Add at least one model to preview the simulation."}
        </p>
      ) : (
        <div className="flex flex-col gap-2.5">
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            {card("Strategy", getStrategyLabel(sim.strategy), `${sim.members} member${sim.members !== 1 ? "s" : ""}`)}
            {card(
              "Logical calls",
              sim.calls.min === sim.calls.max ? `${sim.calls.max}` : `${sim.calls.min}–${sim.calls.max}`,
              `per request · max ${sim.calls.max}`,
            )}
            {card("Provider fanout", String(sim.maxProviderFanout), "parallel calls at peak")}
            {card(
              "Est. cost",
              sim.calls.min === sim.calls.max
                ? fmtUsd(sim.estimatedCost.worst)
                : `${fmtUsd(sim.estimatedCost.optimistic)}–${fmtUsd(sim.estimatedCost.worst)}`,
              `${fmtUsd(sim.perCallCost)} / call`,
            )}
          </div>

          {/* Budget rejection risk */}
          {sim.budgetRisk?.rejected ? (
            <div className="flex items-start gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1.5">
              <span className="material-symbols-outlined text-[14px] text-red-400">error</span>
              <p className="text-[11px] text-red-300">
                Will be rejected at runtime: worst-case cost {fmtUsd(sim.budgetRisk.estimatedCostUsd)} exceeds the
                budget limit {fmtUsd(sim.budgetRisk.limit)} (combo_cost_budget_exceeded).
              </p>
            </div>
          ) : sim.budgetsEnabled ? (
            <div className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5">
              <span className="material-symbols-outlined text-[14px] text-emerald-400">check_circle</span>
              <p className="text-[11px] text-emerald-300">
                Within the configured budget limit ({fmtUsd(sim.budgetRisk.limit)}).
              </p>
            </div>
          ) : (
            <p className="text-[10px] text-text-muted">Budgets are off — unlimited cost/calls allowed.</p>
          )}

          {/* Role violations */}
          {sim.roleViolations.length > 0 && (
            <div className="flex items-start gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5">
              <span className="material-symbols-outlined text-[14px] text-amber-400">warning</span>
              <div className="text-[11px] text-amber-300">
                {sim.roleViolations.map((v) => (
                  <p key={`${v.role}-${v.model}`}>{v.reason}</p>
                ))}
              </div>
            </div>
          )}

          {/* Capability compatibility */}
          <div className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-1/60 px-2.5 py-1.5">
            <span className="text-[10px] uppercase tracking-wide text-text-muted">Capabilities</span>
            <CapacityBadges
              caps={{
                thinking: sim.capabilities?.thinking,
                vision: sim.capabilities?.vision?.input,
                tools: sim.capabilities?.tools,
                pdf: sim.capabilities?.pdf,
                audio: sim.capabilities?.audio?.input,
              }}
              size={13}
            />
            {sim.capabilities?.contextWindow ? (
              <span className="ml-auto text-[10px] text-text-muted">
                ctx {(sim.capabilities.contextWindow / 1000).toFixed(0)}k · max out{" "}
                {sim.capabilities.maxOutput ? `${Math.round(sim.capabilities.maxOutput / 1000)}k` : "—"}
              </span>
            ) : null}
          </div>

          {/* Member rows */}
          <div className="flex flex-col gap-1">
            {sim.memberRows.map((m) => {
              const lat = latencyDisplay(m.latency?.p95, m.latency?.sampleCount);
              return (
                <div key={m.fullModel} className="flex items-center gap-2 rounded-md border border-border-subtle bg-surface-1/40 px-2 py-1.5">
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-text-main">{m.fullModel}</span>
                  {m.roles.length > 0 && (
                    <span className="rounded bg-primary/15 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-primary">
                      {m.roles.join("+")}
                    </span>
                  )}
                  <span className="text-[10px] text-text-muted">{fmtUsd(m.costPerCall)}/call</span>
                  <span
                    className={`w-24 text-right text-[10px] ${lat.insufficient ? "text-amber-400" : "text-text-muted"}`}
                    title={lat.insufficient ? `${m.latency?.sampleCount ?? 0} latency samples — need ≥ 10` : ""}
                  >
                    {lat.value}
                  </span>
                </div>
              );
            })}
          </div>

          <p className="text-[9px] leading-relaxed text-text-muted">
            Worst-case calls match the runtime call-cap budget; cost uses the same per-leaf formula as the runtime
            budget guard (output capped at 4k tokens/call, input assumed above). Latency = p95 over the last 30d of
            usage for that model.
          </p>
        </div>
      )}
    </div>
  );
}
