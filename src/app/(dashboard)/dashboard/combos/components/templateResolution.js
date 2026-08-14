// Pure template → combo resolution helpers, extracted from ComboTemplatesTab
// so the resolution and strategy-role logic can be unit-tested without
// rendering. No React, no DOM — imports only provider alias constants.

import { resolveProviderId, getProviderAlias } from "@/shared/constants/providers";

// Control-role keys in a combo strategyConfig that hold model refs (may be
// model-name-only in templates, resolved to provider/model before saving).
export const TEMPLATE_ROLE_KEYS = ["managerModel", "staffModel", "auditModel", "judgeModel"];

/**
 * Resolve a template's model references to ACTUAL connected providers that
 * carry the same model. The model NAME is the primary key — templates no
 * longer tether a model to one provider. An optional preferred provider is
 * only a hint: it wins when connected, otherwise we fall back to any other
 * connected provider that exposes the same model (e.g. template wants
 * "claude-opus-4-7" on cc, but the user only has kiro connected — we use
 * kiro). Supports both formats:
 *   - "claude-opus-4-7"          (model name only — preferred from template.preferredProviders)
 *   - "cc/claude-opus-4-7"       (legacy: provider/model — preferred embedded)
 *
 * @param {object} template
 * @param {object} opts
 * @param {Record<string, string[]>} opts.modelIndex - model name → provider ALIASES
 *   (built from /api/models in CombosPageInner)
 * @param {Set<string>} opts.connectedProviders - provider IDs of active connections
 * @returns {Array<{ref, modelName, provider, providerAlias, full, available, resolvedFrom?}>}
 */
export function resolveTemplateModels(template, { modelIndex = {}, connectedProviders = new Set() } = {}) {
  return (template.models || []).map((ref) => {
    const slash = ref.indexOf("/");
    const hasProviderPrefix = slash > 0;
    const modelName = hasProviderPrefix ? ref.slice(slash + 1) : ref;
    const embeddedPreferred = hasProviderPrefix ? ref.slice(0, slash) : "";
    // Preferred hint: explicit in the ref (legacy) or in preferredProviders map.
    const preferred = embeddedPreferred || (template.preferredProviders || {})[modelName] || "";
    const preferredId = preferred ? resolveProviderId(preferred) : "";
    // modelIndex is keyed by provider ALIAS; connectedProviders by provider ID.
    // Canonicalize candidates alias→id so the comparison actually matches.
    const candidates = (modelIndex[modelName] || [])
      .map((p) => resolveProviderId(p))
      .filter((p) => connectedProviders.has(p));
    if (preferredId && candidates.includes(preferredId)) {
      // Store with the app-wide ALIAS prefix (cc/claude-opus-4-7) so modelCaps
      // lookups and ModelSelectModal highlighting match other combos.
      const alias = getProviderAlias(preferredId);
      return { ref, modelName, provider: preferredId, providerAlias: alias, full: `${alias}/${modelName}`, available: true };
    }
    if (candidates.length > 0) {
      const alias = getProviderAlias(candidates[0]);
      return { ref, modelName, provider: candidates[0], providerAlias: alias, full: `${alias}/${modelName}`, available: true, resolvedFrom: preferred };
    }
    return { ref, modelName, provider: preferredId || preferred, full: hasProviderPrefix ? ref : modelName, available: false };
  });
}

/**
 * Build the strategyConfig to store for a template and resolve control-role
 * models (manager/staff/audit/judge) to the same provider/model refs the
 * members resolved to. Templates can ship a rich strategyConfig (thinking,
 * autoScale, role models); legacy templates fall back to { fallbackStrategy }.
 *
 * Unresolvable role models keep their original ref (which the server then
 * rejects with a clear validation error instead of creating a broken combo).
 *
 * @param {object} template
 * @param {Array} resolved - result of resolveTemplateModels(template, ...)
 * @returns {object} strategyConfig with role models resolved to alias/model
 */
export function resolveTemplateStrategyConfig(template, resolved) {
  const strategyConfig = template.strategyConfig
    ? { ...template.strategyConfig }
    : { fallbackStrategy: template.strategy };
  const resolvedByName = Object.fromEntries(
    resolved.filter((m) => m.available).map((m) => [m.modelName, m.full])
  );
  for (const roleKey of TEMPLATE_ROLE_KEYS) {
    const roleRef = strategyConfig[roleKey];
    if (!roleRef) continue;
    const slash = roleRef.indexOf("/");
    const roleModelName = slash > 0 ? roleRef.slice(slash + 1) : roleRef;
    if (resolvedByName[roleModelName]) {
      strategyConfig[roleKey] = resolvedByName[roleModelName];
    }
  }
  return strategyConfig;
}
