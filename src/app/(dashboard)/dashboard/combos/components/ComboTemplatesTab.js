"use client";

import { useState } from "react";
import { Card, Button, Badge, EmptyState } from "@/shared/components";
import { COMBO_TEMPLATES } from "@/shared/constants/comboTemplates";
import { getStrategyMeta, getStrategyLabel } from "./helpers";
import { resolveProviderId } from "@/shared/constants/providers";
import { resolveTemplateModels, resolveTemplateStrategyConfig } from "./templateResolution";

// ComboTemplatesTab — redesigned template gallery with provider availability badges.
// Replaces the old ComboTemplates.js component.
export default function ComboTemplatesTab({ combos, connections, modelIndex = {}, onApply }) {
  const [applying, setApplying] = useState(null);

  const connectedProviders = new Set(
    connections?.filter((c) => c.isActive !== false).map((c) => c.provider) || [],
  );
  const existingNames = new Set((combos || []).map((c) => c.name));

  // Resolve template model refs against the connected catalog (pure logic in
  // ./templateResolution — model-name based, preferred provider is only a hint).
  const resolveModels = (template) => resolveTemplateModels(template, { modelIndex, connectedProviders });

  const handleApply = async (template) => {
    setApplying(template.id);
    try {
      // Use resolved providers, not the template's hardcoded ones. Only models
      // that resolved to a real connected provider are usable.
      const resolved = resolveModels(template);
      const usable = resolved.filter((m) => m.available);
      const models = usable.map((m) => m.full);
      if (models.length === 0) {
        alert("No connected provider has any of this template's models.");
        return;
      }

      // Resolve role models BEFORE creating the combo so the server validates
      // control roles (manager/judge/staff/audit) against the template's REAL
      // strategy — POST /api/combos runs validateComboRoles with whatever
      // strategyConfig is sent. Without this, a role-invalid combo (e.g. a
      // web-cookie provider as swarm manager) would be created silently and
      // only fail at runtime.
      const strategyConfig = resolveTemplateStrategyConfig(template, resolved);

      const res = await fetch("/api/combos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: template.name, models, kind: template.kind || "llm", strategyConfig }),
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || "Failed to create combo from template");
        return;
      }
      // Runtime merges the combo record's strategyConfig with the settings
      // override (settings wins), so mirror the strategy there too. The repo
      // deep-merges comboStrategies per combo name, so a bare PATCH preserves
      // every other combo's strategy — no need to fetch-and-merge.
      const stratRes = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comboStrategies: { [template.name]: strategyConfig } }),
      });
      if (!stratRes.ok) {
        const err = await stratRes.json().catch(() => ({}));
        alert(err.error || "Failed to apply template strategy");
        return;
      }
      if (onApply) onApply();
    } catch (err) {
      alert("Failed to apply template: " + (err?.message || String(err)));
    } finally {
      setApplying(null);
    }
  };

  if (COMBO_TEMPLATES.length === 0) {
    return (
      <EmptyState icon="dashboard_customize" title="No templates available" description="Combo templates will appear here when added." />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="mb-1">
        <h2 className="text-sm font-semibold text-text-main">Combo Templates</h2>
        <p className="text-xs text-text-muted mt-0.5">One-click prebuilt combos. Provider availability is checked automatically.</p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {COMBO_TEMPLATES.map((tpl) => {
          // Availability is model-based, not provider-based: a template model is
          // "ready" if ANY connected provider carries it (not just the preferred one).
          const resolved = resolveModels(tpl);
          const readyCount = resolved.filter((m) => m.available).length;
          const totalCount = resolved.length;
          const isCreated = existingNames.has(tpl.name);
          const meta = getStrategyMeta(tpl.strategy);
          const allConnected = readyCount === totalCount;

          return (
            <Card key={tpl.id} padding="sm" className="flex flex-col gap-3 hover:border-primary/20 transition-all">
              {/* Header */}
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: `${meta.color}15` }}>
                    <span className="material-symbols-outlined text-[18px]" style={{ color: meta.color }}>{tpl.icon || meta.icon}</span>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-text-main">{tpl.name}</p>
                    <Badge variant={meta.badge} size="sm">{getStrategyLabel(tpl.strategy)}</Badge>
                  </div>
                </div>
                {isCreated && <Badge variant="success" size="sm" dot>Created</Badge>}
              </div>

              {/* Description */}
              <p className="text-xs text-text-muted leading-relaxed">{tpl.description}</p>

              {/* Model chips — resolved to connected providers */}
              <div className="flex flex-wrap gap-1">
                {resolved.slice(0, 4).map((m, i) => (
                  <code
                    key={i}
                    className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] ${
                      m.available ? "bg-black/5 text-text-muted dark:bg-white/5" : "bg-red-500/10 text-red-500"
                    }`}
                    title={m.available ? `Resolved to ${m.provider}` : `No connected provider has ${m.modelName}`}
                  >
                    <span className={m.available ? "text-success" : "text-red-500"}>
                      {m.available ? "✓" : "✗"}
                    </span>
                    <span className="truncate max-w-[110px]">{m.modelName}</span>
                    {m.available && (
                      <span className="rounded bg-black/10 px-0.5 text-[9px] dark:bg-white/10">{m.provider}</span>
                    )}
                  </code>
                ))}
                {resolved.length > 4 && (
                  <span className="text-[10px] text-text-muted">+{resolved.length - 4} more</span>
                )}
              </div>

              {/* Resolved provider availability */}
              <div className="flex flex-wrap gap-1">
                {resolved.map((m) => {
                  const resolvedFromId = m.resolvedFrom ? resolveProviderId(m.resolvedFrom) : "";
                  const providerLabel = m.available
                    ? `${m.provider}${m.resolvedFrom && resolvedFromId !== m.provider ? ` (via ${m.resolvedFrom})` : ""}`
                    : `${m.provider || "?"} (missing)`;
                  const isConn = m.available;
                  return (
                    <span
                      key={m.ref}
                      className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                        isConn ? "bg-success/10 text-success" : "bg-surface-2 text-text-muted"
                      }`}
                    >
                      <span className="material-symbols-outlined text-[10px]">{isConn ? "check_circle" : "radio_button_unchecked"}</span>
                      {providerLabel}
                    </span>
                  );
                })}
              </div>

              {/* Apply button */}
              <div className="mt-auto pt-1">
                <Button
                  size="sm"
                  fullWidth
                  variant={isCreated ? "secondary" : "primary"}
                  icon={applying === tpl.id ? "progress_activity" : "add"}
                  disabled={isCreated || applying === tpl.id || !allConnected}
                  onClick={() => handleApply(tpl)}
                >
                  {applying === tpl.id ? "Creating..." : isCreated ? "Already Created" : allConnected ? "Apply Template" : `Missing ${totalCount - readyCount} model${totalCount - readyCount !== 1 ? "s" : ""}`}
                </Button>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
