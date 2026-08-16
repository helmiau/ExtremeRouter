const STRATEGIES = new Set(["fallback", "round-robin", "fusion", "swarm", "cascade", "smart-routing"]);
const KINDS = new Set(["llm", "image", "tts", "stt", "embedding", "imageToText", "webSearch", "webFetch"]);

export const COMBO_LIMITS = Object.freeze({
      maxMembers: 999,
  maxWorkers: 8,
  maxConcurrentRunsPerPrincipal: 2,
  maxConcurrentRunsGlobal: 8,
  maxProviderFanout: 4,
  minTimeoutMs: 1000,
  maxTimeoutMs: 120000,
  maxGraceMs: 30000,
  maxOutputChars: 120000,
  maxAggregateOutputChars: 300000,
  maxLogicalCalls: 16,
  // Use Infinity so backend normalization does not clamp user-defined max
  // estimated cost budgets to the old hard ceiling. The UI still enforces a
  // sensible numeric minimum (>= 0.01) for plain-number inputs.
  maxEstimatedCostUsd: Infinity,
});

const MODEL_REF_RE = /^[a-zA-Z0-9_.-]+\/.+$/;
const asInt = (value, fallback, min, max) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};
const asNumber = (value, fallback, min, max) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

export function normalizeStrategy(value) {
  const strategy = typeof value === "string" ? value.trim().toLowerCase() : "fallback";
  return STRATEGIES.has(strategy) ? strategy : "fallback";
}

// Normalize cascade-specific config. Cascade tries models in order, escalating
// to the next stage only when the current model's self-reported confidence is
// below the threshold. The final stage always returns its answer regardless.
function normalizeCascadeConfig(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return {
    confidenceThreshold: asInt(source.confidenceThreshold, 70, 0, 100),
    confidencePrompt: typeof source.confidencePrompt === "string" && source.confidencePrompt.trim()
      ? source.confidencePrompt.trim()
      : "Rate your confidence in this answer from 0 to 100. End your response with exactly: CONFIDENCE: <number>",
    escalatePrompt: typeof source.escalatePrompt === "string" && source.escalatePrompt.trim()
      ? source.escalatePrompt.trim()
      : "A prior model gave the following answer with low confidence. Review it, correct any issues, and provide a better answer.",
    maxStages: asInt(source.maxStages, 3, 1, 8),
  };
}

const THINKING_TYPES = new Set(["auto", "off", "extended", "effort"]);
const THINKING_EFFORTS = new Set(["low", "medium", "high", "max"]);

// Default research-intent keywords for smart-routing (lowercased). Users can
// override per-combo via strategyConfig.smartRouting.intentDetection.keywords.
// Mirrored from smartRouting.js (kept here so normalizeComboStrategyConfig stays
// self-contained — the engine imports the same list).
const DEFAULT_SMART_ROUTING_KEYWORDS = [
  "riset", "research", "cari sumber", "sumber terpercaya", "terbaru",
  "compare", "bandingkan", "cite", "summarize article", "rangkum artikel",
  "berita", "trend", "studi", "jurnal", "menurut data", "investigate",
  "look up", "search the web", "find information", "web search",
];

const DEFAULT_CLASSIFIER_MODEL = "kr/claude-haiku-4.5";
const DEFAULT_CLASSIFIER_PROMPT =
  "Classify the following user task as one of: research, coding, general. Respond with a single word.\n\nTask: {{userPrompt}}";

// Normalize a combo-level thinking config (and optional per-role overrides).
// Returns { type: "auto" } (which the runtime treats as "no override") when
// the input is missing/invalid so the rest of the pipeline always gets a well
// formed object to read.
function normalizeThinking(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const type = THINKING_TYPES.has(source.type) ? source.type : "auto";
  const out = { type };
  if (type === "effort") {
    const effort = typeof source.effort === "string" && THINKING_EFFORTS.has(source.effort) ? source.effort : "high";
    out.effort = effort;
  }
  if (type === "extended") {
    out.budgetTokens = asInt(source.budgetTokens, 4096, 1024, 128000);
  }
  if (source.roles && typeof source.roles === "object" && !Array.isArray(source.roles)) {
    out.roles = {};
    for (const [role, cfgRaw] of Object.entries(source.roles)) {
      if (!cfgRaw || typeof cfgRaw !== "object") continue;
      const rType = THINKING_TYPES.has(cfgRaw.type) ? cfgRaw.type : "inherit";
      if (rType === "inherit") {
        out.roles[role] = { type: "inherit", ...(cfgRaw.effort ? { effort: cfgRaw.effort } : {}), ...(cfgRaw.budgetTokens ? { budgetTokens: cfgRaw.budgetTokens } : {}) };
      } else if (rType === "off" || rType === "auto") {
        out.roles[role] = { type: rType };
      } else if (rType === "effort") {
        out.roles[role] = { type: "effort", effort: THINKING_EFFORTS.has(cfgRaw.effort) ? cfgRaw.effort : "high" };
      } else if (rType === "extended") {
        out.roles[role] = { type: "extended", budgetTokens: asInt(cfgRaw.budgetTokens, 4096, 1024, 128000) };
      }
    }
  }
  return out;
}

export function normalizeComboStrategyConfig(raw = {}) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const fallbackStrategy = normalizeStrategy(source.fallbackStrategy);
  const workerCount = asInt(source.workerCount, 4, 1, COMBO_LIMITS.maxWorkers);
  const swarmSource = source.swarmTuning && typeof source.swarmTuning === "object" ? source.swarmTuning : {};
  const fusionSource = source.fusionTuning && typeof source.fusionTuning === "object" ? source.fusionTuning : {};
  const budgetsSource = source.budgets && typeof source.budgets === "object" ? source.budgets : {};
  const cascadeSource = source.cascade && typeof source.cascade === "object" ? source.cascade : {};
  const adapterSource = source.capabilityAdapter && typeof source.capabilityAdapter === "object" ? source.capabilityAdapter : {};
  const smartRoutingSource = source.smartRouting && typeof source.smartRouting === "object" && !Array.isArray(source.smartRouting)
    ? source.smartRouting
    : {};
  const idSource = smartRoutingSource.intentDetection && typeof smartRoutingSource.intentDetection === "object" && !Array.isArray(smartRoutingSource.intentDetection)
    ? smartRoutingSource.intentDetection
    : {};
  const classifierSource = idSource.llmClassifierFallback && typeof idSource.llmClassifierFallback === "object" && !Array.isArray(idSource.llmClassifierFallback)
    ? idSource.llmClassifierFallback
    : {};

  return {
    fallbackStrategy,
    judgeModel: typeof source.judgeModel === "string" ? source.judgeModel.trim() : "",
    managerModel: typeof source.managerModel === "string" ? source.managerModel.trim() : "",
    staffModel: typeof source.staffModel === "string" ? source.staffModel.trim() : "",
    auditModel: typeof source.auditModel === "string" ? source.auditModel.trim() : "",
    workerCount,
    enableTelemetry: source.enableTelemetry !== false,
    thinking: normalizeThinking(source.thinking),
    cascade: normalizeCascadeConfig(cascadeSource),
    smartRouting: {
      // Whether research intents may route to the webCookie (browser) pool
      // first. Off = research behaves like the default chain. Per-combo toggle
      // exposed in the edit modal.
      cookiePoolEnabled: smartRoutingSource.cookiePoolEnabled !== false,
      intentDetection: {
        // 0..1 confidence at/above which the heuristic answer is trusted
        // without consulting the LLM classifier.
        confidenceThreshold: asNumber(idSource.confidenceThreshold, 0.6, 0, 1),
        // Lowercased keyword list; an empty array = "no keywords" (URL boost
        // still applies). Absent = the curated defaults.
        keywords: Array.isArray(idSource.keywords)
          ? idSource.keywords.filter((k) => typeof k === "string" && k.trim()).map((k) => k.trim().toLowerCase())
          : [...DEFAULT_SMART_ROUTING_KEYWORDS],
        urlPatternBoost: idSource.urlPatternBoost !== false,
        llmClassifierFallback: {
          enabled: classifierSource.enabled === true,
          model: typeof classifierSource.model === "string" && classifierSource.model.trim()
            ? classifierSource.model.trim()
            : DEFAULT_CLASSIFIER_MODEL,
          promptTemplate: typeof classifierSource.promptTemplate === "string" && classifierSource.promptTemplate.trim()
            ? classifierSource.promptTemplate.trim()
            : DEFAULT_CLASSIFIER_PROMPT,
        },
      },
    },
    capabilityAdapter: {
      // Tri-state: null = inherit the global setting (comboCapabilityAdapterEnabled),
      // so per-combo config can opt out (`false`) or force on (`true`) without
      // losing the default-on behavior for unset combos.
      enabled: typeof adapterSource.enabled === "boolean" ? adapterSource.enabled : null,
      fallbackModel: typeof adapterSource.fallbackModel === "string" ? adapterSource.fallbackModel.trim() : "",
    },
    fusionTuning: {
      minPanel: asInt(fusionSource.minPanel, 2, 2, COMBO_LIMITS.maxMembers),
      stragglerGraceMs: asInt(fusionSource.stragglerGraceMs, 8000, 0, COMBO_LIMITS.maxGraceMs),
      panelHardTimeoutMs: asInt(fusionSource.panelHardTimeoutMs, 90000, COMBO_LIMITS.minTimeoutMs, COMBO_LIMITS.maxTimeoutMs),
    },
    swarmTuning: {
      workerHardTimeoutMs: asInt(swarmSource.workerHardTimeoutMs, 90000, COMBO_LIMITS.minTimeoutMs, COMBO_LIMITS.maxTimeoutMs),
      workerQuorum: asInt(swarmSource.workerQuorum, Math.min(2, workerCount), 1, workerCount),
      stragglerGraceMs: asInt(swarmSource.stragglerGraceMs, 10000, 0, COMBO_LIMITS.maxGraceMs),
      managerTimeoutMs: asInt(swarmSource.managerTimeoutMs, 60000, COMBO_LIMITS.minTimeoutMs, COMBO_LIMITS.maxTimeoutMs),
      minWorkers: asInt(swarmSource.minWorkers, Math.min(2, workerCount), 1, workerCount),
      maxWorkers: asInt(swarmSource.maxWorkers, workerCount, 1, COMBO_LIMITS.maxWorkers),
    },
    budgets: {
      // Budget limit toggle: default OFF. When off, comboBudget.js skips all
      // cost/call/output caps so unlimited spending is allowed. When on, the
      // numeric caps below apply. Defaults to false so legacy combos stay
      // unlimited unless the user explicitly enables the guard.
      enabled: budgetsSource.enabled === true,
      maxLogicalCalls: asInt(budgetsSource.maxLogicalCalls, COMBO_LIMITS.maxLogicalCalls, 1, COMBO_LIMITS.maxLogicalCalls),
      maxOutputChars: asInt(budgetsSource.maxOutputChars, COMBO_LIMITS.maxOutputChars, 1000, COMBO_LIMITS.maxOutputChars),
      maxAggregateOutputChars: asInt(budgetsSource.maxAggregateOutputChars, COMBO_LIMITS.maxAggregateOutputChars, 5000, COMBO_LIMITS.maxAggregateOutputChars),
      maxEstimatedCostUsd: asNumber(budgetsSource.maxEstimatedCostUsd, COMBO_LIMITS.maxEstimatedCostUsd, 0.01, COMBO_LIMITS.maxEstimatedCostUsd),
    },
    autoScale: {
      enabled: source.autoScale?.enabled === true,
      minWorkers: asInt(source.autoScale?.minWorkers, 1, 1, source.autoScale?.maxWorkers || COMBO_LIMITS.maxWorkers),
      maxWorkers: asInt(source.autoScale?.maxWorkers, workerCount || COMBO_LIMITS.maxWorkers, 1, COMBO_LIMITS.maxWorkers),
    },
  };
}

export function validateComboDefinition(data, { allowPartial = false } = {}) {
  const errors = [];
  if (!allowPartial || data.name !== undefined) {
    if (typeof data.name !== "string" || !data.name.trim()) errors.push("Name is required");
    else if (!/^[a-zA-Z0-9_.-]+$/.test(data.name)) errors.push("Name can only contain letters, numbers, -, _ and .");
  }
  if (!allowPartial || data.models !== undefined) {
    if (!Array.isArray(data.models)) errors.push("Models must be an array");
    else {
      const normalized = data.models.map((m) => typeof m === "string" ? m.trim() : "");
	      if (normalized.length < 1) errors.push("At least one model is required");
	      if (normalized.some((m) => !MODEL_REF_RE.test(m))) errors.push("Every model must use provider/model format");
	      if (new Set(normalized).size !== normalized.length) errors.push("Duplicate models are not allowed");
    }
  }
  if (data.kind !== undefined && data.kind !== null && !KINDS.has(data.kind)) errors.push("Invalid combo kind");
  if (data.strategyConfig !== undefined) {
    const raw = data.strategyConfig;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) errors.push("strategyConfig must be an object");
    else {
      for (const field of ["judgeModel", "managerModel", "staffModel", "auditModel"]) {
        if (raw[field] && !MODEL_REF_RE.test(String(raw[field]).trim())) errors.push(`${field} must use provider/model format`);
      }
      const numericContainers = [raw.fusionTuning, raw.swarmTuning, raw.budgets].filter(Boolean);
      if (numericContainers.some((obj) => typeof obj !== "object" || Array.isArray(obj))) errors.push("Tuning and budgets must be objects");
    }
  }
  return { valid: errors.length === 0, errors };
}

// Worst-case logical calls for ONE request of a combo (used by the runtime
// budget call-cap — combo_call_budget_exceeded). NOT a nominal/typical
// estimate: fallback/round-robin normally succeed on the first model (1 call)
// and cascade can stop at stage 1; see estimateCallsRange for {min, max}.
// Per-strategy worst case:
//   fallback / round-robin → every member tried until one succeeds = memberCount
//   smart-routing → same worst case as fallback (ordered chain over the whole
//                   pool — cookie members + normal members = memberCount)
//   fusion  → all panel members + judge = members + 1
//   swarm   → gatekeeper(1) + manager strategy(1) + workers(N) +
//             staff audit(1) + manager synthesis(1) = workers + 4
//             (a simple request short-circuits to a single direct answer = 1)
//   cascade → one call per escalation stage, capped by maxStages
//             = min(memberCount, maxStages)
export function estimateLogicalCalls(strategyConfig, memberCount) {
  const cfg = normalizeComboStrategyConfig(strategyConfig);
  if (cfg.fallbackStrategy === "fusion") return Math.min(memberCount, COMBO_LIMITS.maxMembers) + 1;
  if (cfg.fallbackStrategy === "swarm") return Math.min(cfg.workerCount, COMBO_LIMITS.maxWorkers) + 4;
  if (cfg.fallbackStrategy === "cascade") return Math.min(memberCount, cfg.cascade?.maxStages || 3);
  return Math.max(1, Math.min(memberCount, COMBO_LIMITS.maxMembers));
}

/**
 * Nominal-to-worst call range for ONE request, for pre-save simulation UX.
 *
 * The worst bound reuses estimateLogicalCalls (so the runtime budget cap and
 * the simulator can never drift). The min bound is the short-circuit path:
 *   fallback / round-robin → first model succeeds (1)
 *   cascade                → first stage answers confidently (1)
 *   swarm                  → gatekeeper classifies the request as simple (1)
 *   fusion                 → always the full panel + judge (deterministic)
 *
 * @param {object} strategyConfig
 * @param {number} memberCount
 * @returns {{min: number, max: number}}
 */
export function estimateCallsRange(strategyConfig, memberCount) {
  const cfg = normalizeComboStrategyConfig(strategyConfig);
  const worst = estimateLogicalCalls(strategyConfig, memberCount);
  const deterministic = cfg.fallbackStrategy === "fusion";
  return deterministic ? { min: worst, max: worst } : { min: 1, max: worst };
}
