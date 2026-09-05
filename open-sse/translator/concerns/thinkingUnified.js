// Unified thinking normalization: extract client intent → apply provider-native format.
// Config-driven: thinking format/limits come from capabilities.js + registry transport,
// never hardcoded per-model here. See .docs/thinking/plan.md MATRIX VI-A.

import { getCapabilitiesForModel } from "../../providers/capabilities.js";
import { getThinkingLevels } from "../../providers/thinkingLevels.js";
import { PROVIDERS } from "../../providers/index.js";
import { LEVEL_TO_BUDGET, budgetToLevel, effortToBudget, effortToThinkingLevel } from "./thinking.js";

// Map a target wire-format to its native thinking format (when capability has none).
const FORMAT_TO_NATIVE = {
  openai: "openai",
  "openai-responses": "openai",
  "openai-response": "openai",
  codex: "openai",
  claude: "claude-budget",
  gemini: "gemini-budget",
  "gemini-cli": "gemini-budget",
  vertex: "gemini-budget",
  antigravity: "gemini-budget",
  kiro: "kiro",
};

// Parse model-name suffix "model(value)" → { cleanModel, override }.
// value: level name (high) | number (8192) | auto | none. null override when absent.
export function parseSuffix(model) {
  if (typeof model !== "string") return { cleanModel: model, override: null };
  const m = model.match(/^(.*)\(([^()]+)\)\s*$/);
  if (!m) return { cleanModel: model, override: null };
  const cleanModel = m[1].trim();
  const raw = m[2].trim().toLowerCase();
  if (raw === "none" || raw === "off") return { cleanModel, override: { mode: "none" } };
  if (raw === "auto") return { cleanModel, override: { mode: "auto" } };
  if (raw === "ultra") return { cleanModel, override: { mode: "level", level: raw } };
  if (/^\d+$/.test(raw)) return { cleanModel, override: { mode: "budget", budget: Number(raw) } };
  if (LEVEL_TO_BUDGET[raw] !== undefined) return { cleanModel, override: { mode: "level", level: raw } };
  return { cleanModel, override: null };
}

// Extract unified thinking intent from a request body (post-translation, mixed shapes).
// Returns { mode, budget?, level? } or null when no thinking intent present.
export function extractThinking(body) {
  if (!body || typeof body !== "object") return null;

  // Claude output_config.effort (explicit) — priority over adaptive thinking
  const oc = body.output_config?.effort;
  if (typeof oc === "string" && oc) {
    const e = oc.toLowerCase();
    if (e === "none" || e === "off") return { mode: "none" };
    if (e === "auto") return { mode: "auto" };
    return { mode: "level", level: e };
  }

  // Claude shape
  const t = body.thinking;
  if (t && typeof t === "object") {
    if (t.type === "disabled") return { mode: "none" };
    if (t.type === "adaptive" || t.type === "enabled") {
      const budget = Number(t.budget_tokens);
      if (Number.isFinite(budget) && budget > 0) return { mode: "budget", budget };
      return { mode: "auto" };
    }
  }

  // OpenAI chat / Responses shape
  const effort = body.reasoning_effort ?? (typeof body.reasoning === "object" ? body.reasoning?.effort : null);
  if (typeof effort === "string" && effort) {
    const e = effort.toLowerCase();
    if (e === "none" || e === "off") return { mode: "none" };
    if (e === "auto") return { mode: "auto" };
    return { mode: "level", level: e };
  }

  // Gemini shape (top-level, generationConfig, or request envelope)
  const tc = body.thinkingConfig || body.generationConfig?.thinkingConfig || body.request?.generationConfig?.thinkingConfig;
  if (tc && typeof tc === "object") {
    if (typeof tc.thinkingLevel === "string") return { mode: "level", level: tc.thinkingLevel.toLowerCase() };
    const tb = Number(tc.thinkingBudget);
    if (Number.isFinite(tb)) {
      if (tb === 0) return { mode: "none" };
      if (tb < 0) return { mode: "auto" };
      return { mode: "budget", budget: tb };
    }
  }

  // Qwen shape
  if (body.enable_thinking === false) return { mode: "none" };
  if (body.enable_thinking === true) {
    const tb = Number(body.thinking_budget);
    if (Number.isFinite(tb) && tb > 0) return { mode: "budget", budget: tb };
    return { mode: "auto" };
  }

  return null;
}

// Capture thinking intent from a body. Alias of extractThinking, named for clarity
// at the call-site where intent is snapshotted before format translation.
export const captureThinking = extractThinking;

// Resolve thinking format: provider override > capability > derive(targetFormat).
function resolveFormat(targetFormat, model, provider) {
  const providerFmt = provider ? PROVIDERS[provider]?.thinkingFormat : null;
  if (providerFmt) return providerFmt;
  const caps = getCapabilitiesForModel(provider, model);
  if (caps.thinkingFormat) return caps.thinkingFormat;
  return FORMAT_TO_NATIVE[targetFormat] || "openai";
}

// Convert unified config to a budget number (for budget-based formats).
function toBudget(cfg, range) {
  let budget;
  if (cfg.mode === "budget") budget = cfg.budget;
  else if (cfg.mode === "level") budget = effortToBudget(cfg.level);
  else if (cfg.mode === "auto") return -1;
  if (!Number.isFinite(budget)) return undefined;
  if (range) {
    if (range.min != null && budget < range.min) budget = range.min;
    if (range.max != null && budget > range.max) budget = range.max;
  }
  return budget;
}

// M8 FIX: Valid effort levels — any client-sent value outside this set is
// rejected (returns null) so it can't leak to upstream as an invalid enum.
// `ultra` (Codex GPT-5.6 Sol/Terra) joins the set; per-model support is
// enforced downstream via normalizeOpenAILevel.
const VALID_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

// Convert unified config to a discrete level string.
function toLevel(cfg) {
  if (cfg.mode === "level") {
    // Validate against known levels — reject unknown client-injected values.
    return VALID_LEVELS.has(cfg.level) ? cfg.level : null;
  }
  if (cfg.mode === "budget") return budgetToLevel(cfg.budget) || "medium";
  if (cfg.mode === "auto") return "auto";
  return null;
}

// Codex GPT-5.6 overrides (port of decolua/9router design): preserve max/ultra
// only when the target model's advertised levels include it; ultra→max when
// only max is supported (Luna); anything else max/ultra → xhigh (safe ceiling).
function normalizeOpenAILevel(level, supportedLevels) {
  if (level !== "max" && level !== "ultra") return level;
  if (supportedLevels?.includes(level)) return level;
  if (level === "ultra" && supportedLevels?.includes("max")) return "max";
  return "xhigh";
}

function toGeminiThinkingLevel(cfg) {
  const raw = cfg.mode === "auto" ? "high" : (toLevel(cfg) || "high");
  return effortToThinkingLevel(raw);
}

// Clamp a level into an explicit allowed list (caps.thinkingLevels). Picks the
// first valid level at-or-above the requested one, else the highest (e.g. kimi-k3
// [low,high,max]: minimal→low, medium→high, xhigh→max).
function clampToLevels(level, list) {
  if (!list || !Array.isArray(list) || !level || list.includes(level)) return level;
  const ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];
  const rank = ORDER.indexOf(level);
  const valid = list.filter((l) => ORDER.includes(l)).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  if (!valid.length) return level;
  return valid.find((l) => ORDER.indexOf(l) >= rank) || valid[valid.length - 1];
}

// Gemini nests thinkingConfig under generationConfig. gemini-cli / antigravity wrap
// the whole request in a { request: { generationConfig } } envelope — target the
// envelope's generationConfig when present, else the top-level one.
function setGeminiThinking(body, tc) {
  const gc = body.request?.generationConfig
    ? body.request.generationConfig
    : (body.generationConfig && typeof body.generationConfig === "object"
        ? body.generationConfig
        : (body.generationConfig = {}));
  gc.thinkingConfig = tc;
}

// Strip every known thinking field from a body (used before re-applying / when unsupported).
function stripAll(body) {
  delete body.thinking;
  delete body.reasoning_effort;
  delete body.reasoning;
  delete body.thinkingConfig;
  delete body.enable_thinking;
  delete body.thinking_budget;
  delete body.output_config;
  if (body.generationConfig) delete body.generationConfig.thinkingConfig;
  if (body.request?.generationConfig) delete body.request.generationConfig.thinkingConfig;
}

// Apply unified thinking config to body in the resolved provider-native format.
function applyFormat(fmt, body, cfg, caps, model, provider) {
  const none = cfg.mode === "none";
  const canDisable = caps.thinkingCanDisable !== false;
  // Model cannot disable thinking → clamp "none" to minimal effort instead.
  const eff = none && !canDisable ? { mode: "level", level: "minimal" } : cfg;

  switch (fmt) {
    case "openai": {
      if (none && canDisable) { body.reasoning_effort = "none"; break; }
      const level = toLevel(eff);
      if (level && level !== "auto") {
        const clamped = clampToLevels(level, caps.thinkingLevels);
        body.reasoning_effort = normalizeOpenAILevel(clamped, getThinkingLevels(provider, model));
      } else delete body.reasoning_effort;
      break;
    }
    case "claude-adaptive": {
      if (none && canDisable) { body.thinking = { type: "disabled" }; break; }
      const level = toLevel(eff);
      // output_config.effort alone does NOT turn thinking on for models that CAN
      // disable thinking (Anthropic defaults thinking off; Anthropic-compatible
      // shims too) — those need the explicit adaptive switch. Permanently adaptive
      // models (thinkingCanDisable: false, e.g. Fable 5.1) accept effort directly
      // and the redundant switch must not be sent.
      if (canDisable) body.thinking = { type: "adaptive" };
      else delete body.thinking;
      body.output_config = { effort: level === "xhigh" || level === "ultra" ? "high" : level };
      break;
    }
    case "claude-budget": {
      if (none && canDisable) { body.thinking = { type: "disabled" }; break; }
      const budget = toBudget(eff, caps.thinkingRange);
      body.thinking = budget === -1 ? { type: "enabled" } : { type: "enabled", budget_tokens: budget || 8192 };
      break;
    }
    case "gemini-level": {
      const level = none ? "minimal" : toGeminiThinkingLevel(eff);
      setGeminiThinking(body, { thinkingLevel: level, includeThoughts: level !== "minimal" });
      break;
    }
    case "gemini-budget": {
      if (none && canDisable) { setGeminiThinking(body, { thinkingBudget: 0, includeThoughts: false }); break; }
      const budget = toBudget(eff, caps.thinkingRange);
      setGeminiThinking(body, { thinkingBudget: budget ?? -1, includeThoughts: true });
      break;
    }
    case "zai": {
      // Z.ai ignores thinking.disabled → must use enable_thinking:false to turn off.
      if (none && canDisable) { body.enable_thinking = false; delete body.thinking; break; }
      body.thinking = { type: "enabled" };
      // GLM-5.2+ exposes reasoning_effort (high|max, default max) alongside deep
      // thinking (Z.ai migrate-to-glm-5.2 docs). Older GLM (4.x/5/5.1) ignore the
      // field — only set it for 5.2+ so legacy models stay clean.
      if (/(^|\/)glm-5\.(2|3|4|5)\b/i.test(model)) {
        const level = toLevel(eff);
        if (level && level !== "auto") {
          body.reasoning_effort = level === "max" || level === "xhigh" || level === "ultra" ? "max" : "high";
        }
      }
      break;
    }
    case "qwen": {
      if (none && canDisable) { body.enable_thinking = false; break; }
      body.enable_thinking = true;
      const budget = toBudget(eff, caps.thinkingRange);
      if (Number.isFinite(budget) && budget > 0) body.thinking_budget = budget;
      break;
    }
    case "deepseek": {
      if (none && canDisable) { body.thinking = { type: "disabled" }; break; }
      body.thinking = { type: "enabled" };
      // DeepSeek V4 native tiers: low / high / max. Keep "low" native for V4
      // models — v3 fallback only maps "minimal" to low and collapses the rest
      // to high (the v3 API never exposed a low tier).
      const level = toLevel(eff);
      const isV4 = /(^|\/)deepseek-v4/i.test(model);
      body.reasoning_effort =
        level === "xhigh" || level === "max" || level === "ultra" ? "max" :
        level === "high" || level === "medium" ? "high" :
        level === "low" ? "low" :
        level === "minimal" ? (isV4 ? "low" : "high") : "high";
      break;
    }
    case "kimi": {
      if (none && canDisable) { body.thinking = { type: "disabled" }; break; }
      const level = toLevel(eff);
      // Kimi accepts: low, medium, high only.
      // minimal → low, xhigh/max → high, auto → omit (let backend default).
      if (level && level !== "auto") {
        body.reasoning_effort =
          level === "minimal" ? "low" :
          level === "xhigh" || level === "max" || level === "ultra" ? "high" : level;
      }
      break;
    }
    case "minimax": {
      // M3 adaptive; M2.x cannot disable (handled via canDisable clamp).
      body.thinking = { type: none && canDisable ? "disabled" : "adaptive" };
      break;
    }
    case "hunyuan": {
      if (none && canDisable) { body.thinking = { type: "disabled" }; break; }
      const budget = toBudget(eff, caps.thinkingRange);
      body.thinking = budget === -1 ? { type: "enabled" } : { type: "enabled", budget_tokens: budget || 8192 };
      break;
    }
    case "step": {
      if (none && canDisable) break;
      const level = toLevel(eff);
      // Step accepts: low, medium, high only.
      // minimal → low, xhigh/max → high, auto → omit (let backend default).
      if (level && level !== "auto") {
        body.reasoning_effort =
          level === "minimal" ? "low" :
          level === "xhigh" || level === "max" || level === "ultra" ? "high" : level;
      }
      break;
    }
    case "kiro":
      // Kiro thinking handled via system-tag injection in openai-to-kiro.js; no body field here.
      break;
    default:
      break;
  }
}

// Public entry: normalize thinking for the resolved target format.
// Mutates and returns body. No-op when model has no reasoning capability.
// `intent` is a pre-captured config (from captureThinking on the original body);
// falls back to extracting from the current body when omitted.
export function applyThinking(targetFormat, model, body, provider = null, intent = undefined) {
  if (!body || typeof body !== "object") return body;

  const { cleanModel, override } = parseSuffix(model);
  const cfg = override || intent || extractThinking(body);
  const caps = getCapabilitiesForModel(provider, cleanModel);

  // Model cannot reason → strip any stray thinking fields.
  if (!caps.reasoning) {
    stripAll(body);
    return body;
  }
  if (!cfg) return body;

  const fmt = resolveFormat(targetFormat, cleanModel, provider);
  stripAll(body);
  applyFormat(fmt, body, cfg, caps, cleanModel, provider);
  return body;
}
