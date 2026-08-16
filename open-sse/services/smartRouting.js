/**
 * Smart Routing — combo strategy that routes each request based on two signals:
 *
 *   1. Tool-calling need (deterministic, read straight from the request payload)
 *   2. Research intent (fuzzy: keyword/URL heuristic, with an optional cheap LLM
 *      classifier fallback when the heuristic is ambiguous)
 *
 * Decision order (spec): the tool_calling check runs FIRST because it is
 * deterministic, then the research-intent check. The result is an ORDERED pool
 * handed to the fallback chain (handleComboChat), so runtime failures (cookie
 * provider down / Cloudflare 403) automatically fall through to the next pool
 * member — a cookie provider at the head of a research pool can never kill the
 * request.
 *
 * Pool rules:
 *   - tool_calling request → only members whose provider supports tool calling
 *     (i.e. NOT webCookie providers). Empty pool → full pool with a warning.
 *   - research intent      → cookie members first, then the normal pool. Empty
 *     cookie pool → default order (no error).
 *   - otherwise            → default combo order (fallback chain).
 *
 * This module is intentionally side-effect free except for the injected
 * `resolveIntent` callback (the classifier call), so the ordering logic is
 * trivially unit-testable.
 */
import REGISTRY from "../providers/registry/index.js";
import { resolveProviderAlias } from "./model.js";

/** Curated research-intent keywords (lowercased). Overridable per-combo. */
export const DEFAULT_RESEARCH_KEYWORDS = [
  "riset", "research", "cari sumber", "sumber terpercaya", "terbaru",
  "compare", "bandingkan", "cite", "summarize article", "rangkum artikel",
  "berita", "trend", "studi", "jurnal", "menurut data", "investigate",
  "look up", "search the web", "find information", "web search",
];

/** Cheap classifier model used when the heuristic is ambiguous. */
export const DEFAULT_CLASSIFIER_MODEL = "kr/claude-haiku-4.5";

export const DEFAULT_CLASSIFIER_PROMPT =
  "Classify the following user task as one of: research, coding, general. Respond with a single word.\n\nTask: {{userPrompt}}";

/** Classifier call budget — must never stall the main request for long. */
export const CLASSIFIER_TIMEOUT_MS = 15000;

/** Provider ids whose category is webCookie (browser-backed chat scrapers). */
const COOKIE_PROVIDER_IDS = new Set(
  REGISTRY.filter((entry) => entry.category === "webCookie").map((entry) => entry.id),
);

/**
 * True when a "provider/model" string belongs to a webCookie (browser chat)
 * provider. Aliases are resolved first (e.g. "felo/deepseek-v4-flash" and
 * "felo-web/deepseek-v4-flash" both resolve to felo-web).
 */
export function isCookieModel(modelStr) {
  if (typeof modelStr !== "string" || !modelStr) return false;
  const slash = modelStr.indexOf("/");
  const prefix = slash > 0 ? modelStr.slice(0, slash) : modelStr;
  return COOKIE_PROVIDER_IDS.has(resolveProviderAlias(prefix));
}

/**
 * Whether a model can execute function/tool calls. Defaults to true for every
 * non-cookie provider; webCookie providers are browser scrapers (text in →
 * text out) and never receive tools. Per spec: cookie ⇒ supportsToolCalling
 * false unless individually verified.
 */
export function supportsToolCalling(modelStr) {
  return !isCookieModel(modelStr);
}

/**
 * Deterministic tool-calling detection — no model call, just the payload.
 * Covers OpenAI chat (`tools`/`functions`/`tool_choice`), the Responses API
 * (same top-level keys) and Gemini-style wrapped requests (`request.tools`).
 */
export function requiresToolCalling(body) {
  if (!body || typeof body !== "object") return false;
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const hasWrappedTools = Array.isArray(body.request?.tools) && body.request.tools.length > 0;
  const toolChoice = body.tool_choice;
  const hasToolChoice = toolChoice != null && toolChoice !== "none" && toolChoice !== false && toolChoice !== "null";
  const hasFunctions = Array.isArray(body.functions) && body.functions.length > 0;
  return hasTools || hasWrappedTools || hasToolChoice || hasFunctions;
}

/** Flatten a content value (string | block array) into plain text. */
function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (!block || typeof block !== "object") return "";
        if (typeof block.text === "string") return block.text;
        if (typeof block.content === "string") return block.content;
        return "";
      })
      .join("\n");
  }
  return "";
}

/**
 * Extract the LAST user message's text across supported request shapes
 * (messages[] / input[] / contents[]). Used as the research-intent signal.
 */
export function lastUserMessageText(body) {
  if (!body || typeof body !== "object") return "";
  const messages = body.messages || body.input || (Array.isArray(body.contents) ? body.contents : null);
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || typeof message !== "object") continue;
    if (message.role === "user" || message.role === "human") {
      const text = textOf(message.content);
      if (text.trim()) return text;
    }
  }
  return "";
}

/**
 * Cheap keyword/URL heuristic. Returns { intent, confidence }:
 *   - research with 0.75 on a keyword hit or a URL (when urlPatternBoost on)
 *   - general with 0.4 otherwise (low confidence → may escalate to the LLM
 *     classifier when one is configured)
 */
export function detectResearchHeuristic(promptText, opts = {}) {
  const keywords = Array.isArray(opts.keywords) ? opts.keywords : DEFAULT_RESEARCH_KEYWORDS;
  const urlPatternBoost = opts.urlPatternBoost !== false;
  const text = typeof promptText === "string" ? promptText.toLowerCase() : "";
  if (!text.trim()) return { intent: "general", confidence: 0.4, signal: "empty" };

  const hasUrl = /https?:\/\/[^\s]+/.test(text);
  const keywordHit = keywords.some((keyword) => text.includes(keyword));

  if (keywordHit || (urlPatternBoost && hasUrl)) {
    return { intent: "research", confidence: 0.75, signal: keywordHit ? "keyword" : "url" };
  }
  return { intent: "general", confidence: 0.4, signal: "none" };
}

/**
 * Run the classifier model with a minimal non-streaming prompt. Returns
 * "research" | "general". Throws on failure so callers degrade gracefully.
 */
async function classifyWithModel(handleSingleModel, model, prompt) {
  const classifierBody = {
    model,
    messages: [{ role: "user", content: prompt }],
    stream: false,
  };
  const res = await handleSingleModel(classifierBody, model, {
    role: "classifier",
    isPanel: true, // skipBreaker: classifier failures must not trip the breaker
    signal: AbortSignal.timeout(CLASSIFIER_TIMEOUT_MS),
  });
  if (!res?.ok) throw new Error(`classifier returned status ${res?.status}`);
  const json = await res.clone().json();
  const content =
    json?.choices?.[0]?.message?.content ??
    json?.choices?.[0]?.text ??
    json?.content ??
    json?.output?.[0]?.content?.[0]?.text ??
    "";
  const label = String(content).trim().toLowerCase();
  const firstWord = (label.match(/[a-z]+/) || [""])[0];
  return firstWord === "research" ? "research" : "general";
}

/**
 * Build an async intent resolver for the runtime: heuristic first, LLM
 * classifier only when the heuristic is ambiguous AND enabled. Any classifier
 * failure degrades to the heuristic answer — never blocks the main request.
 *
 * @param {object} opts
 * @param {object} [opts.config] - normalized smartRouting config
 * @param {Function} opts.handleSingleModel - (body, model, opts) => Promise<Response>
 * @param {object} [opts.log] - logger with .info/.warn
 * @param {Function} [opts.onIntent] - optional reporting hook called after the
 *   intent decision with { intent, source, signal, confidence, classifierModel };
 *   used by telemetry to show HOW the decision was made. Never throws.
 * @returns {(promptText: string) => Promise<"research"|"general">}
 */
export function buildIntentResolver({ config, handleSingleModel, log, onIntent }) {
  const idCfg = (config && config.intentDetection) || {};
  const classifier = idCfg.llmClassifierFallback || {};
  const threshold = Number.isFinite(idCfg.confidenceThreshold) ? idCfg.confidenceThreshold : 0.6;

  const report = (detail) => {
    try {
      onIntent?.(detail);
    } catch {
      // Reporting must never affect routing.
    }
  };

  return async (promptText) => {
    const heuristic = detectResearchHeuristic(promptText, idCfg);
    if (heuristic.confidence >= threshold) {
      report({ intent: heuristic.intent, source: "heuristic", signal: heuristic.signal, confidence: heuristic.confidence, classifierModel: null });
      return heuristic.intent;
    }
    if (!classifier.enabled || !handleSingleModel || !String(promptText || "").trim()) {
      report({ intent: heuristic.intent, source: "heuristic", signal: heuristic.signal, confidence: heuristic.confidence, classifierModel: null });
      return heuristic.intent;
    }

    const model = classifier.model || DEFAULT_CLASSIFIER_MODEL;
    const prompt = (classifier.promptTemplate || DEFAULT_CLASSIFIER_PROMPT).replace("{{userPrompt}}", String(promptText));
    try {
      const label = await classifyWithModel(handleSingleModel, model, prompt);
      if (label === "research") {
        log?.info?.("SMART", `intent classifier (${model}) → research`);
        report({ intent: "research", source: "classifier", signal: heuristic.signal, confidence: heuristic.confidence, classifierModel: model });
        return "research";
      }
      report({ intent: "general", source: "classifier", signal: heuristic.signal, confidence: heuristic.confidence, classifierModel: model });
      return "general";
    } catch (error) {
      log?.warn?.("SMART", `intent classifier failed (${error?.message || error}) — treating as ${heuristic.intent}`);
      report({ intent: heuristic.intent, source: "heuristic", signal: heuristic.signal, confidence: heuristic.confidence, classifierModel: null });
      return heuristic.intent;
    }
  };
}

/**
 * Build the ordered member pool for ONE request. Pure ordering logic.
 *
 * @param {object} opts
 * @param {object} opts.body - request body
 * @param {string[]} opts.members - combo member refs ("provider/model")
 * @param {object} [opts.config] - normalized smartRouting config
 * @param {Function} [opts.resolveIntent] - async (promptText) => "research"|"general";
 *   falls back to the raw heuristic when omitted or when it throws
 * @returns {Promise<{order: string[], reason: string, details: object}>}
 *   reason ∈ tool_calling | tool_calling_pool_empty_fallback |
 *            research_cookie_primary | research_cookie_pool_empty | general
 */
export async function buildSmartRoutingOrder({ body, members, config, resolveIntent }) {
  const ordered = Array.isArray(members) ? members.filter(Boolean) : [];
  if (ordered.length === 0) return { order: [], reason: "general", details: {} };

  // STEP 1 — deterministic tool-calling check (wins over everything).
  if (requiresToolCalling(body)) {
    const toolPool = ordered.filter((model) => supportsToolCalling(model));
    if (toolPool.length > 0) {
      return {
        order: toolPool,
        reason: "tool_calling",
        details: { excludedCookies: ordered.filter((model) => !supportsToolCalling(model)) },
      };
    }
    // No tool-capable member: fall back to the full pool with a warning flag.
    return {
      order: ordered,
      reason: "tool_calling_pool_empty_fallback",
      details: { note: "no tool-calling-capable model in combo" },
    };
  }

  // STEP 2 — fuzzy research-intent check.
  const promptText = lastUserMessageText(body);
  let intent = "general";
  if (typeof resolveIntent === "function") {
    try {
      intent = await resolveIntent(promptText);
    } catch (error) {
      // Classifier blow-ups must never block the request — treat as general.
      intent = "general";
    }
  } else {
    const idCfg = (config && config.intentDetection) || {};
    const heuristic = detectResearchHeuristic(promptText, idCfg);
    intent = heuristic.confidence >= (idCfg.confidenceThreshold ?? 0.6) ? heuristic.intent : "general";
  }

  if (intent === "research") {
    const cookiePoolEnabled = (config && config.cookiePoolEnabled) !== false;
    const cookiePool = cookiePoolEnabled ? ordered.filter((model) => isCookieModel(model)) : [];
    const normalPool = ordered.filter((model) => !isCookieModel(model));
    if (cookiePool.length > 0) {
      return {
        order: [...cookiePool, ...normalPool],
        reason: "research_cookie_primary",
        details: { cookiePool, normalPool },
      };
    }
    return {
      order: ordered,
      reason: "research_cookie_pool_empty",
      details: { note: "no cookie provider in combo; using default order" },
    };
  }

  // STEP 3 — default chain (subscription → cheap → free, per member order).
  return { order: ordered, reason: "general", details: {} };
}
