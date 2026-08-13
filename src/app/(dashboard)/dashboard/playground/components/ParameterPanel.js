"use client";

import PropTypes from "prop-types";
import { useState } from "react";
import { useModelCaps } from "@/shared/hooks/useModelCaps";
import { thinkingLevelsForCaps, maxTokensBound } from "../playgroundCore";

export default function ParameterPanel({ params, onChange, selectedModel = "" }) {
  const [expanded, setExpanded] = useState(true);
  const { getCaps } = useModelCaps();

  const update = (key, val) => onChange({ ...params, [key]: val });

  // Thinking picker: only show for reasoning-capable models. The advertised
  // level list is derived from the model's capabilities (thinkingLevels /
  // thinkingMaxEffort, exposed via /api/models) — a static list advertised
  // levels models don't support (e.g. GLM-5.2 only accepts high/max).
  const caps = getCaps?.(selectedModel);
  const thinkingSupported = !!caps?.reasoning;
  const levels = thinkingLevelsForCaps(caps) || [];
  const maxTokensCap = maxTokensBound(caps);

  const hasSystemPrompt = !!(params.systemPrompt && params.systemPrompt.trim());

  return (
    <div className="rounded-brand border border-border-subtle bg-panel p-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="mb-3 flex w-full items-center justify-between"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-text-main">
          <span className="material-symbols-outlined text-[18px] text-primary">tune</span>
          Parameters
          {hasSystemPrompt && (
            <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              system
            </span>
          )}
        </span>
        <span className={`material-symbols-outlined text-[18px] text-text-muted transition-transform ${expanded ? "rotate-90" : ""}`}>
          chevron_right
        </span>
      </button>

      {expanded && (
        <div className="flex flex-col gap-4">
          {/* System prompt */}
          <div>
            <label className="mb-1 block text-xs font-medium text-text-muted">System Prompt</label>
            <textarea
              value={params.systemPrompt || ""}
              onChange={(e) => update("systemPrompt", e.target.value)}
              placeholder="You are a helpful assistant..."
              rows={3}
              className="custom-scrollbar w-full resize-none rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-sm text-text-main placeholder:text-text-muted focus:border-primary focus:outline-none"
            />
          </div>

          {/* Thinking level — only for reasoning-capable models */}
          {thinkingSupported && (
            <div>
              <label className="mb-1 block text-xs font-medium text-text-muted">Thinking Level</label>
              <div className="flex flex-wrap gap-1">
                {/* Auto = don't send any reasoning_effort (provider default) */}
                <button
                  onClick={() => update("reasoningEffort", "")}
                  className={`rounded-lg px-2.5 py-1 text-xs font-medium capitalize transition-colors ${
                    !params.reasoningEffort
                      ? "bg-primary text-white"
                      : "bg-surface-2 text-text-muted hover:bg-surface-3"
                  }`}
                >
                  auto
                </button>
                {levels.map((lvl) => {
                  const active = params.reasoningEffort === lvl;
                  return (
                    <button
                      key={lvl}
                      onClick={() => update("reasoningEffort", active ? "" : lvl)}
                      className={`rounded-lg px-2.5 py-1 text-xs font-medium capitalize transition-colors ${
                        active
                          ? "bg-primary text-white"
                          : "bg-surface-2 text-text-muted hover:bg-surface-3"
                      }`}
                    >
                      {lvl}
                    </button>
                  );
                })}
                {caps?.thinkingCanDisable !== false && (
                  <button
                    onClick={() => update("reasoningEffort", "none")}
                    className={`rounded-lg px-2.5 py-1 text-xs font-medium capitalize transition-colors ${
                      params.reasoningEffort === "none"
                        ? "bg-primary text-white"
                        : "bg-surface-2 text-text-muted hover:bg-surface-3"
                    }`}
                  >
                    none
                  </button>
                )}
              </div>
              <p className="mt-1 text-[10px] text-text-muted">
                Reasoning effort. Auto = provider default.
              </p>
            </div>
          )}

          {/* Temperature */}
          <SliderRow
            label="Temperature"
            value={params.temperature ?? 0.7}
            min={0} max={2} step={0.05}
            onChange={(v) => update("temperature", v)}
          />

          {/* Top P */}
          <SliderRow
            label="Top P"
            value={params.topP ?? 1}
            min={0} max={1} step={0.05}
            onChange={(v) => update("topP", v)}
          />

          {/* Frequency penalty */}
          <SliderRow
            label="Frequency Penalty"
            value={params.frequencyPenalty ?? 0}
            min={0} max={2} step={0.1}
            onChange={(v) => update("frequencyPenalty", v)}
          />

          {/* Presence penalty */}
          <SliderRow
            label="Presence Penalty"
            value={params.presencePenalty ?? 0}
            min={0} max={2} step={0.1}
            onChange={(v) => update("presencePenalty", v)}
          />

          {/* Max tokens — upper bound follows the model's max output limit */}
          <div>
            <label className="mb-1 block text-xs font-medium text-text-muted">Max Tokens</label>
            <input
              type="number"
              min="1"
              max={maxTokensCap}
              value={params.maxTokens ?? 4096}
              onChange={(e) => {
                const v = parseInt(e.target.value);
                update("maxTokens", Number.isFinite(v) && v > 0 ? Math.min(v, maxTokensCap) : 4096);
              }}
              className="w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-1.5 text-sm text-text-main focus:border-primary focus:outline-none"
            />
          </div>

          {/* Top K */}
          <div>
            <label className="mb-1 block text-xs font-medium text-text-muted">Top K</label>
            <input
              type="number"
              min="1"
              max="1000"
              placeholder="unset"
              value={params.topK ?? ""}
              onChange={(e) => update("topK", e.target.value === "" ? null : parseInt(e.target.value))}
              className="w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-1.5 text-sm text-text-main placeholder:text-text-muted focus:border-primary focus:outline-none"
            />
          </div>

          {/* Seed */}
          <div>
            <label className="mb-1 block text-xs font-medium text-text-muted">Seed</label>
            <input
              type="number"
              placeholder="unset"
              value={params.seed ?? ""}
              onChange={(e) => update("seed", e.target.value === "" ? null : parseInt(e.target.value))}
              className="w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-1.5 text-sm text-text-main placeholder:text-text-muted focus:border-primary focus:outline-none"
            />
          </div>
        </div>
      )}
    </div>
  );
}

function SliderRow({ label, value, min, max, step, onChange }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <label className="text-xs font-medium text-text-muted">{label}</label>
        <span className="text-xs font-mono text-text-main">{Number(value).toFixed(2)}</span>
      </div>
      <input
        type="range"
        min={min} max={max} step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-primary"
      />
    </div>
  );
}

ParameterPanel.propTypes = {
  params: PropTypes.shape({
    systemPrompt: PropTypes.string,
    reasoningEffort: PropTypes.string,
    temperature: PropTypes.number,
    maxTokens: PropTypes.number,
    topP: PropTypes.number,
    frequencyPenalty: PropTypes.number,
    presencePenalty: PropTypes.number,
    topK: PropTypes.number,
    seed: PropTypes.number,
  }).isRequired,
  onChange: PropTypes.func.isRequired,
  selectedModel: PropTypes.string,
};

SliderRow.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.number.isRequired,
  min: PropTypes.number.isRequired,
  max: PropTypes.number.isRequired,
  step: PropTypes.number.isRequired,
  onChange: PropTypes.func.isRequired,
};
