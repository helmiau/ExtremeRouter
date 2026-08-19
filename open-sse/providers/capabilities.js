// Model capabilities — what each model can read/do beyond plain text.
//
// Fallback order (first match wins), result merged over DEFAULT_CAPABILITIES:
//   1. PROVIDER_CAPABILITIES[provider][model]  — provider-specific override
//   2. MODEL_CAPABILITIES[model]               — canonical exact id (handles exceptions)
//   3. PATTERN_CAPABILITIES                     — glob match, ordered specific -> generic
//   4. DEFAULT_CAPABILITIES                     — safe floor (always returned)
//
// ── HOW TO ADD / UPDATE A MODEL ──────────────────────────────────────
// Authoritative data source: https://models.dev/api.json (145 providers, 4000+
// models, MIT). Each model exposes the exact fields we map below:
//   modalities.input  ["text","image","pdf","audio","video"] -> vision / pdf / audioInput / videoInput
//   modalities.output ["text","image","audio"]               -> imageOutput / audioOutput
//   reasoning   -> reasoning      tool_call    -> tools
//   limit.context -> contextWindow   limit.output -> maxOutput
// Look up the model id, then:
//   • If a PATTERN below already covers it correctly -> nothing to do.
//   • If it is an exception (pattern would mis-match) -> add an exact entry to
//     MODEL_CAPABILITIES (only the fields that differ from DEFAULT).
//   • If a whole new family -> add an ordered PATTERN (specific before generic).
// NOTE: models.dev has NO "search" flag (web search is a runtime tool, not a
// model spec); set `search` from vendor docs (Claude 4.x+, GPT-5.x/4o, Gemini
// 2.0+, Grok, Perplexity). Verify with: curl -s https://models.dev/api.json

import { matchPattern } from "./pricing.js";
import { resolveProviderAlias } from "../services/model.js";

/**
 * Safe floor — every resolved result is merged over this so consumers
 * never need null-checks. Most modern LLMs meet these limits.
 */
export const DEFAULT_CAPABILITIES = {
  // input modalities
  vision: false,        // read images
  pdf: false,           // read PDF / documents
  audioInput: false,    // read audio
  videoInput: false,    // read video
  // output modalities
  imageOutput: false,   // generate images
  audioOutput: false,   // generate audio
  // features
  search: false,        // built-in web search tool / grounding
  tools: true,          // function / tool calling
  reasoning: false,     // thinking / reasoning
  // thinking wire format (only meaningful when reasoning:true). null → derive from transport.format.
  // enum: openai|claude-adaptive|claude-budget|gemini-level|gemini-budget|zai|qwen|deepseek|kimi|minimax|hunyuan|step
  thinkingFormat: null,
  thinkingCanDisable: true,  // false → model cannot turn thinking off (clamp to min instead of disable)
  thinkingRange: null,       // { min, max } for budget formats; null = no clamp
  thinkingMaxEffort: false,  // true → supports "max" reasoning_effort (e.g. gpt-5.6-sol)
  thinkingLevels: null,      // explicit valid reasoning_effort list (e.g. ["low","medium","high"]); null = all levels
  // limits (tokens)
  contextWindow: 200000,
  maxOutput: 64000,
};

// User-added model metadata can carry dashboard service kinds instead of the
// runtime capability names used here. Map those typed model kinds into input /
// output capabilities so custom vision models are not treated as text-only.
const SERVICE_KIND_CAPABILITIES = {
  imageToText: { vision: true },
  image: { imageOutput: true },
  stt: { audioInput: true },
  tts: { audioOutput: true },
  embedding: { tools: false },
};

export function capabilitiesFromServiceKind(kind) {
  return SERVICE_KIND_CAPABILITIES[kind] || null;
}

/**
 * Canonical exact-id overrides — used for exceptions that patterns would
 * otherwise mis-match. Only declare deltas vs DEFAULT.
 */
export const MODEL_CAPABILITIES = {
  // Claude 4.6/4.7/4.8 and Kiro Sonnet 5 have 1M context + adaptive thinking (override generic claude pattern)
  "claude-opus-4.6":   { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4.7":   { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4-7":   { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4.8":   { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4-6":   { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4-8":   { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4.8-thinking": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4-8-thinking": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-4.6": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-4-6": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-5": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-5-thinking": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-5-agentic": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-5-thinking-agentic": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },

  // Gemini image-gen / OpenAI image / xai image variants
  "gpt-image-1":       { imageOutput: true, tools: false },

  // GLM vision variant (text GLM has no vision)
  "glm-4.6v":          { vision: true, reasoning: true, thinkingFormat: "zai", contextWindow: 128000 },

  // Qwen plain coder/text (no vision) — registry "vision-model" / "coder-model" aliases
  "vision-model":      { vision: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000 },
  "coder-model":       { reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000 },
};

// Codex OAuth (ChatGPT backend) — per-model context window reported by upstream
// (lower than OpenAI API's 1.05M). Sol differs from Terra/Luna. Port of
// decolua/9router GPT-5.6 Codex reasoning-overrides design.
// thinkingMaxEffort + thinkingLevels mirror the codex override matrix in
// thinkingLevels.js so UI gates (combo "max" option, playground picker) see
// the real level range instead of the generic openai fallback.
const CODEX_GPT_56_SOL_CAPS = {
  vision: true, reasoning: true, search: true, thinkingFormat: "openai",
  contextWindow: 372000, maxOutput: 128000,
  thinkingMaxEffort: true,
  thinkingLevels: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
};
const CODEX_GPT_56_DEFAULT_CAPS = {
  vision: true, reasoning: true, search: true, thinkingFormat: "openai",
  contextWindow: 272000, maxOutput: 128000,
  thinkingMaxEffort: true,
  thinkingLevels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
};

/**
 * Provider-specific capability overrides. Keyed by provider alias/id.
 */
export const PROVIDER_CAPABILITIES = {
  // Codex GPT-5.6 family — provider-scoped so the global *gpt-5.6* patterns
  // (which describe Kiro) can't leak onto cx/ models, and the *gpt-5*codex*
  // 400k default can't override Sol's real 372k window.
  codex: {
    "gpt-5.6-sol":         CODEX_GPT_56_SOL_CAPS,
    "gpt-5.6-sol-review":  CODEX_GPT_56_SOL_CAPS,
    "gpt-5.6-terra":       CODEX_GPT_56_DEFAULT_CAPS,
    "gpt-5.6-terra-review": CODEX_GPT_56_DEFAULT_CAPS,
    "gpt-5.6-luna":        CODEX_GPT_56_DEFAULT_CAPS,
    "gpt-5.6-luna-review": CODEX_GPT_56_DEFAULT_CAPS,
  },
  // Fireworks AI — OpenAI-compatible host. transport.thinkingFormat:"openai" makes
  // reasoning models speak OpenAI reasoning_effort. These per-model pins correct
  // generic family patterns that mis-flag Fireworks models:
  //   *kimi*k2*     → vision + kimi thinking format (k2-instruct-0905 is text-only)
  //   *glm-5*       → zai thinking format + 200k ctx (glm-5p2 is 1M ctx)
  //   *deepseek*    → reasoning (deepseek-v3p1 is a plain chat model)
  //   *qwen*235b*   → qwen thinking format (OpenAI-style effort here)
  fireworks: {
    "accounts/fireworks/models/glm-5p2":            { reasoning: true, thinkingFormat: "openai", contextWindow: 1048575, maxOutput: 131072 },
    "accounts/fireworks/models/kimi-k2p6":          { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 262000, maxOutput: 262000 },
    "accounts/fireworks/models/kimi-k2-instruct-0905": { vision: false, reasoning: false, contextWindow: 262144, maxOutput: 262144 },
    "accounts/fireworks/models/deepseek-v3p1":      { vision: false, reasoning: false, contextWindow: 128000, maxOutput: 16384 },
    "accounts/fireworks/models/qwen3-235b-a22b":    { reasoning: true, thinkingFormat: "openai", contextWindow: 128000, maxOutput: 32768 },
  },
  // NVIDIA NIM is OpenAI-compatible → rejects MiniMax/GLM native `thinking` field.
  // Force openai reasoning_effort format for its reasoning models. #issue
  "nvidia": {
    "minimaxai/minimax-m2.7": { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 131072 },
    "minimaxai/minimax-m3": { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 512000, maxOutput: 131072 },
    "z-ai/glm-5.2": { reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 128000 },
    "deepseek-ai/deepseek-v4-pro": { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 65536 },
    "deepseek-ai/deepseek-v4-flash": { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 65536 },
  },
  // CodeBuddy.cn — authoritative per-model metadata from the gateway's model
  // config (contextWindow=maxInputTokens, maxOutput=maxOutputTokens, vision=
  // supportsImages). Every model reasons via OpenAI-style reasoning_effort
  // (see registry thinkingFormat). `onlyReasoning` models can't turn thinking
  // off → thinkingCanDisable:false (clamped to minimal instead of disabled).
  "codebuddy-cn": {
    "glm-5.2":            { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 48000 },
    "glm-5.1":            { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 48000 },
    "glm-5.0":            { reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 48000 },
    "glm-5.0-turbo":      { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 48000 },
    "glm-5v-turbo":       { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 38000 },
    // glm-4.7 removed from upstream catalog (2026-08-14); hy3 (Hunyuan) added.
    "hy3":                { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 192000, maxOutput: 64000 },
    "minimax-m3":         { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 512000, maxOutput: 48000 },
    "minimax-m2.7":       { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 48000 },
    "kimi-k2.7":          { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 256000, maxOutput: 32000 },
    "kimi-k2.6":          { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 256000, maxOutput: 32000 },
    "kimi-k2.5":          { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 164000, maxOutput: 32000 },
    "hy3-preview":        { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 192000, maxOutput: 64000 },
    "deepseek-v4-pro":    { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 50000 },
    "deepseek-v4-flash":  { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 50000 },
    "deepseek-v3-2-volc": { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 96000, maxOutput: 32000 },
  },
  // Bynara (router.bynara.id) — deterministic runtime mirror of the gateway's
  // /v1/models metadata (context_window, vision, reasoning). The live values
  // are also absorbed automatically by the bynara modelsFetcher parser
  // (suggested-models/filters.js) for the providers page; this static block
  // keeps getCapabilitiesForModel correct for picker/combo/playground even
  // before/without that fetch. Reasoning models speak OpenAI reasoning_effort
  // (the gateway's primary chat format).
  bynara: {
    "agnes-2.0-flash":     { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 512000 },
    "agnes-2.5-flash":     { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 512000 },
    "grok-4.5-free":       { vision: true, contextWindow: 212000 },
    "laguna-s-2.1":        { reasoning: true, thinkingFormat: "openai", contextWindow: 262000 },
    "ling-3.0-flash-free": { reasoning: true, thinkingFormat: "openai", contextWindow: 262000 },
    "mistral-large":       { contextWindow: 252000 },
    "mistral-medium-3-5":  { vision: true, contextWindow: 256000 },
    "nemotron-3-ultra":    { contextWindow: 1000000 },
    "stepfun-3.7-flash":   { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 262000 },
    "tencent-hy3-free":    { contextWindow: 262000 },
    // DeepSeek V4 free/paid on Bynara speak OpenAI reasoning_effort only
    // (gateway rejects native DeepSeek thinking:{type} blocks → HTTP 400).
    // vision:false — free tier is text-only; generic *deepseek-v4* has no vision
    // either, pin keeps picker/combo honest if patterns drift later.
    "deepseek-v4-pro":       { vision: false, reasoning: true, thinkingFormat: "openai", thinkingMaxEffort: true, contextWindow: 1000000, maxOutput: 384000 },
    "deepseek-v4-pro-free":  { vision: false, reasoning: true, thinkingFormat: "openai", thinkingMaxEffort: true, contextWindow: 1000000, maxOutput: 384000 },
    "deepseek-v4-flash":     { vision: false, reasoning: true, thinkingFormat: "openai", thinkingMaxEffort: true, contextWindow: 1000000, maxOutput: 384000 },
    "deepseek-v4-flash-free":{ vision: false, reasoning: true, thinkingFormat: "openai", thinkingMaxEffort: true, contextWindow: 1000000, maxOutput: 384000 },
  },
  // OrcaRouter (api.orcarouter.ai) — multi-provider OpenAI gateway. Live model
  // cards: https://www.orcarouter.ai/api/public/models/<id>. thinkingFormat is
  // also pinned on transport (openai reasoning_effort is the unified wire
  // shape per docs.orcarouter.ai/advanced/reasoning); provider-scoped caps fix
  // context/vision so generic *qwen3.7*/*deepseek-v4* patterns don't inflate
  // free-tier text models to 1M multimodal.
  orcarouter: {
    "orcarouter/free":                 { contextWindow: 1000000, maxOutput: 64000 },
    "orcarouter/fusion":               { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 64000 },
    "orcarouter/fusion-flash":         { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 64000 },
    "orcarouter/fusion-mini":          { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 64000 },
    "qwen/qwen3.8-27b-free":           { vision: false, reasoning: true, thinkingFormat: "openai", contextWindow: 65536, maxOutput: 65536 },
    "qwen/qwen3.8-27b":                { vision: false, reasoning: true, thinkingFormat: "openai", contextWindow: 65536, maxOutput: 65536 },
    "qwen/qwen3.7-max":                { vision: false, reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 64000 },
    "qwen/qwen3.5-27b":                { vision: true, videoInput: true, reasoning: true, thinkingFormat: "openai", contextWindow: 32768, maxOutput: 65536 },
    "deepseek/deepseek-v4-pro":        { vision: false, reasoning: true, thinkingFormat: "openai", thinkingMaxEffort: true, contextWindow: 1048576, maxOutput: 384000 },
    "deepseek/deepseek-v4-pro-free":   { vision: false, reasoning: true, thinkingFormat: "openai", thinkingMaxEffort: true, contextWindow: 1048576, maxOutput: 384000 },
    "deepseek/deepseek-v4-flash":      { vision: false, reasoning: true, thinkingFormat: "openai", thinkingMaxEffort: true, contextWindow: 1048576, maxOutput: 384000 },
    "deepseek/deepseek-v4-flash-free": { vision: false, reasoning: true, thinkingFormat: "openai", thinkingMaxEffort: true, contextWindow: 1048576, maxOutput: 384000 },
    "deepseek/deepseek-reasoner":      { vision: false, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 384000 },
    "minimax/minimax-m2.7":            { vision: false, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 204800, maxOutput: 131072 },
    "openai/gpt-5.5":                  { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 400000, maxOutput: 128000 },
    "tencent/hy3-free":                { vision: false, contextWindow: 262000 },
  },
  // tokenharbor — AI gateway; pin the Claude 5 flagships to claude-adaptive 1M
  // so the generic *claude*opus*/*claude*fable* pattern (claude-budget 200k)
  // can't win for these models.
  tokenharbor: {
    "claude-opus-5":  { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
    "claude-fable-5": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  },
  // meta-ai — Muse Spark family. Reasoning always on (native reasoning_effort
  // tiers minimal/low/medium/high/xhigh; "none" unsupported → HTTP 400, so
  // thinkingCanDisable false clamps disable requests to minimal). Provider-
  // scoped so the generic *muse-spark* pattern can't leak native effort levels
  // onto muse-spark-web (web bridge doesn't speak OpenAI-compatible effort).
  "meta-ai": {
    // Muse Spark 1.x is fully multimodal (models.dev: image+video+pdf+audio input).
    "muse-spark-1.2":            { vision: true, pdf: true, audioInput: true, videoInput: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, thinkingLevels: ["minimal", "low", "medium", "high", "xhigh"], contextWindow: 1048576, maxOutput: 131072 },
    "muse-spark-1.2-contributor": { vision: true, pdf: true, audioInput: true, videoInput: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, thinkingLevels: ["minimal", "low", "medium", "high", "xhigh"], contextWindow: 1048576, maxOutput: 131072 },
    "muse-spark-1.1":            { vision: true, pdf: true, audioInput: true, videoInput: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, thinkingLevels: ["minimal", "low", "medium", "high", "xhigh"], contextWindow: 1048576, maxOutput: 131072 },
  },
  // codebuddy-intl + workbuddy — same CodeBuddy gateway on their own hosts
  // (codebuddy.ai / workbuddy.ai). WorkBuddy's flagship model is "hy3" (the
  // registry model id); it reasons via OpenAI-style reasoning_effort like every
  // other model on this gateway.
  "codebuddy-intl": {
    "glm-5.2":            { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 48000 },
    "glm-5.1":            { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 48000 },
    "glm-5.0":            { reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 48000 },
    "glm-5.0-turbo":      { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 48000 },
    "glm-5v-turbo":       { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 38000 },
    "glm-4.7":            { reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 48000 },
    "minimax-m3":         { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 512000, maxOutput: 48000 },
    "minimax-m2.7":       { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 48000 },
    "kimi-k2.7":          { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 256000, maxOutput: 32000 },
    "kimi-k2.6":          { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 256000, maxOutput: 32000 },
    "kimi-k2.5":          { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 164000, maxOutput: 32000 },
    "hy3-preview":        { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 192000, maxOutput: 64000 },
    "deepseek-v4-pro":    { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 50000 },
    "deepseek-v4-flash":  { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 50000 },
    "deepseek-v3-2-volc": { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 96000, maxOutput: 32000 },
  },
  workbuddy: {
    "hy3":               { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 64000 },
    "glm-5.2":           { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 48000 },
    "glm-5.1":           { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 48000 },
    "glm-5.0":           { reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 48000 },
    "glm-5.0-turbo":     { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 48000 },
    "glm-5v-turbo":      { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 38000 },
    "glm-4.7":           { reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 48000 },
    "minimax-m3":        { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 512000, maxOutput: 48000 },
    "minimax-m2.7":      { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 48000 },
    "kimi-k2.7":         { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 256000, maxOutput: 32000 },
    "kimi-k2.6":         { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 256000, maxOutput: 32000 },
    "kimi-k2.5":         { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 164000, maxOutput: 32000 },
    "hy3-preview":       { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 192000, maxOutput: 64000 },
    "deepseek-v4-pro":   { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 50000 },
    "deepseek-v4-flash": { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 50000 },
    "deepseek-v3-2-volc": { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 96000, maxOutput: 32000 },
  },
};

/**
 * Pattern fallback — glob (* = wildcard), matched case-insensitively and
 * anchored (^...$) so a pattern must match the full model id. ORDER MATTERS:
 * vision/specific variants first, text-only/generic families last, to avoid
 * a broad family pattern swallowing an exception (e.g. glm-4.6v vs glm-5).
 */
export const PATTERN_CAPABILITIES = [
  // ── Claude (4.6+ = adaptive thinking; older/haiku = budget) ──────
  { pattern: "*claude*opus-4.6*",   caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive" } },
  { pattern: "*claude*opus-4.7*",   caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive" } },
  { pattern: "*claude*opus-4.8*",   caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive" } },
  { pattern: "*claude*sonnet-4.6*", caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive" } },
  { pattern: "*claude*sonnet-4.7*", caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive" } },
  { pattern: "*claude*haiku*",  caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-budget" } },
  { pattern: "*claude*opus*",   caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-budget" } },
  { pattern: "*claude*sonnet*", caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-budget" } },
  { pattern: "*claude*fable*",  caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-budget", contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*claude*mythos*", caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-budget", contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*claude-3*",      caps: { vision: true } },
  // M5 FIX: Tightened from bare *claude* to require a dash separator, avoiding
  // false-positives on custom models that happen to contain "claude" (e.g.
  // "my-claude-finetune"). Real Claude model IDs always contain "claude-".
  { pattern: "*claude-*",       caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-budget" } },

  // ── Gemini (all 2.0+ multimodal + google_search grounding, 1M ctx) ─
  { pattern: "*gemini*image*",  caps: { vision: true, imageOutput: true, contextWindow: 1048576 } },
  { pattern: "*gemini-3.7*",    caps: { vision: true, audioInput: true, videoInput: true, reasoning: true, search: true, thinkingFormat: "gemini-level", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 65536 } },
  { pattern: "*gemini-3*pro*",  caps: { vision: true, audioInput: true, videoInput: true, reasoning: true, search: true, thinkingFormat: "gemini-level", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 65535 } },
  { pattern: "*gemini-3*",      caps: { vision: true, audioInput: true, videoInput: true, reasoning: true, search: true, thinkingFormat: "gemini-level", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 65536 } },
  { pattern: "*gemini-2.5*",    caps: { vision: true, audioInput: true, videoInput: true, reasoning: true, search: true, thinkingFormat: "gemini-budget", thinkingRange: { min: 1024, max: 24576 }, contextWindow: 1048576, maxOutput: 65536 } },
  { pattern: "*gemini-2*",      caps: { vision: true, audioInput: true, videoInput: true, search: true, contextWindow: 1048576, maxOutput: 65536 } },
  { pattern: "*gemini*",        caps: { vision: true, search: true, contextWindow: 1048576 } },
  { pattern: "*gemma*",         caps: { vision: true, contextWindow: 128000 } },
  { pattern: "*nanobanana*",    caps: { vision: true, imageOutput: true } },

  // ── OpenAI GPT-5.x (vision + thinking + web search) ──────────────
  { pattern: "*gpt-5*image*",   caps: { imageOutput: true } },
  { pattern: "*gpt-5.6-sol*",  caps: { reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 272000, maxOutput: 128000, thinkingMaxEffort: true } },
  { pattern: "*gpt-5.6-terra*", caps: { reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 272000, maxOutput: 128000 } },
  { pattern: "*gpt-5.6-luna*", caps: { reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 272000, maxOutput: 128000 } },

  // ── Moonshot / Kimi K3 (reasoning, supports max effort) ──────────
  // K3 reasoning + Preserved Thinking always on (can't disable), native tiers
  // low/high/max only (default max). See moonshot.js registry note.
  { pattern: "*kimi-k3*",      caps: { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, thinkingLevels: ["low", "high", "max"], thinkingMaxEffort: true, contextWindow: 1048576, maxOutput: 1048576 } },
  { pattern: "*gpt-5*codex*",   caps: { reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 400000, maxOutput: 128000 } },
  { pattern: "*gpt-5*",         caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 400000, maxOutput: 128000 } },
  { pattern: "*gpt-4o*",        caps: { vision: true, search: true, contextWindow: 128000, maxOutput: 16384 } },
  // MAI-Code-1-Flash (Microsoft via GitHub Copilot) — code-generation model.
  { pattern: "*mai-code*",      caps: { reasoning: true, thinkingFormat: "openai", contextWindow: 256000, maxOutput: 128000 } },
  { pattern: "*gpt-4.1*",       caps: { vision: true, contextWindow: 1000000, maxOutput: 32768 } },
  { pattern: "*gpt-4-turbo*",   caps: { vision: true, contextWindow: 128000 } },
  { pattern: "*gpt-4*",         caps: { contextWindow: 128000 } },
  { pattern: "*gpt-3.5*",       caps: { contextWindow: 16385, maxOutput: 4096 } },
  { pattern: "*gpt-oss*",       caps: { reasoning: true, thinkingFormat: "openai", contextWindow: 128000 } },

  // ── OpenAI o-series (reasoning, vision) ──────────────────────────
  // M4 FIX: Tightened from *o1* (matches any model containing "o1") to *o1-* /
  // *o1_* to avoid false-positives on unrelated models. The prefix "o" + digit +
  // separator is OpenAI's naming convention; generic "o1" substrings are too broad.
  { pattern: "*o1-mini*",       caps: { reasoning: true, thinkingFormat: "openai", contextWindow: 128000 } },
  { pattern: "*o1-*",           caps: { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 100000 } },
  { pattern: "*o1_*",           caps: { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 100000 } },
  { pattern: "*o3-*",           caps: { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 100000 } },
  { pattern: "*o3_*",           caps: { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 100000 } },
  { pattern: "*o4-*",           caps: { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 100000 } },
  { pattern: "*o4_*",           caps: { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 100000 } },
  // Bare o1/o3/o4 ids (openai/o1, openai/o3, chatgpt-web/o3, copilot-web/o3, …)
  // contain no dash/underscore, so the *o1-* / *o3_* patterns never match them
  // and they silently lost reasoning+vision. models.dev: reasoning, image/pdf
  // input, 200k ctx / 100k output. Specific variants (o1-mini, o3-mini, o4-mini)
  // are still caught by the earlier patterns.
  { pattern: "o1*",            caps: { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 100000 } },
  { pattern: "o3*",            caps: { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 100000 } },
  { pattern: "o4*",            caps: { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 100000 } },

  // ── Grok (vision + Live Search) ──────────────────────────────────
  { pattern: "*grok-imagine-video*", caps: { videoOutput: true } },
  { pattern: "*grok*image*",    caps: { imageOutput: true } },
  { pattern: "*grok-code*",     caps: { reasoning: true, thinkingFormat: "openai", contextWindow: 256000 } },
  // Grok 4.6: 500k context + effort levels low/medium/high/xhigh (docs.x.ai 2026-08).
  { pattern: "*grok-4.6*",      caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 500000, thinkingLevels: ["low", "medium", "high", "xhigh"], thinkingMaxEffort: true } },
  // Grok 4.5: 500k context + effort levels low/medium/high only (no minimal).
  { pattern: "*grok-4.5*",      caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 500000, thinkingLevels: ["low", "medium", "high"] } },
  { pattern: "*grok-4*",        caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 256000 } },
  { pattern: "*grok-3*",        caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 131072 } },
  { pattern: "*grok*",          caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 256000 } },

  // ── Qwen (3.5+ = native vision/video; coder & max = text-only; QwQ = thinking-only) ─
  { pattern: "*qwen*vl*",       caps: { vision: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 262144 } },
  { pattern: "*qwen*omni*",     caps: { vision: true, audioInput: true, videoInput: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 262144, maxOutput: 65536 } },
  { pattern: "*qwen*coder*",    caps: { reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000 } },
  { pattern: "*qwen*max*",      caps: { reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen3.5*",       caps: { vision: true, videoInput: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen3.6*",       caps: { vision: true, videoInput: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen3.7*",       caps: { vision: true, videoInput: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 65536 } },
  // Qwen3.8 dense (OrcaRouter self-host + Alibaba) — reasoning + tools; vision
  // not guaranteed on every host (Orca free card is text-only 64k). Keep
  // family-level reasoning; provider-scoped orcarouter pin overrides ctx/vision.
  { pattern: "*qwen3.8*",       caps: { reasoning: true, thinkingFormat: "qwen", contextWindow: 262144, maxOutput: 65536 } },
  { pattern: "*qwen*plus*",     caps: { vision: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen*235b*",     caps: { reasoning: true, thinkingFormat: "qwen", contextWindow: 262144 } },
  { pattern: "*qwq*",           caps: { reasoning: true, thinkingFormat: "qwen", thinkingCanDisable: false, contextWindow: 131072 } },
  { pattern: "*qwen*",          caps: { reasoning: true, thinkingFormat: "qwen", contextWindow: 262144 } },

  // ── Kimi (enabled→reasoning_effort; K2.7-code cannot disable) ─────
  { pattern: "*kimi*k2.7*code*", caps: { vision: true, reasoning: true, thinkingFormat: "kimi", thinkingCanDisable: false, contextWindow: 262144, maxOutput: 262144 } },
  { pattern: "*kimi*k2*",       caps: { vision: true, reasoning: true, thinkingFormat: "kimi", contextWindow: 262144, maxOutput: 262144 } },
  // kimi-latest (Moonshot chat) accepts image input (models.dev).
  { pattern: "*kimi-latest*",   caps: { vision: true, reasoning: true, thinkingFormat: "kimi", contextWindow: 262144 } },
  { pattern: "*kimi*",          caps: { reasoning: true, thinkingFormat: "kimi", contextWindow: 262144 } },

  // ── GLM / Z.ai (thinking.enabled; disable via enable_thinking:false) ─
  // GLM-5.3 exposes 1M context + reasoning_effort low|high|max (default max;
  // https://z.ai/blog/glm-5.3). GLM-5.2 exposes 1M context + reasoning_effort
  // high|max (Z.ai docs); the generic *glm-5* caps at 200k and advertises the
  // full effort range.
  { pattern: "*glm-5.3*",       caps: { reasoning: true, thinkingFormat: "zai", thinkingLevels: ["low", "high", "max"], contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*glm-5.2*",       caps: { reasoning: true, thinkingFormat: "zai", thinkingLevels: ["high", "max"], contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*glm-5*",         caps: { reasoning: true, thinkingFormat: "zai", contextWindow: 200000, maxOutput: 128000 } },
  { pattern: "*glm-4.7*",       caps: { reasoning: true, thinkingFormat: "zai", contextWindow: 200000, maxOutput: 128000 } },
  { pattern: "*glm-4*",         caps: { reasoning: true, thinkingFormat: "zai", contextWindow: 200000 } },
  { pattern: "*glm*",           caps: { reasoning: true, thinkingFormat: "zai", contextWindow: 200000 } },

  // ── DeepSeek (thinking.enabled + reasoning_effort; r1 = thinking-only) ─
  // V4 tiers are low/high/max natively (no medium on the wire). thinkingMaxEffort
  // unhides "max" in the dashboard picker + getThinkingLevels().
  { pattern: "*deepseek-v4*",   caps: { reasoning: true, thinkingFormat: "deepseek", thinkingMaxEffort: true, contextWindow: 1000000, maxOutput: 384000 } },
  { pattern: "*reasoner*",      caps: { reasoning: true, thinkingFormat: "deepseek", thinkingCanDisable: false, contextWindow: 128000 } },
  { pattern: "*deepseek-r*",    caps: { reasoning: true, thinkingFormat: "deepseek", thinkingCanDisable: false, contextWindow: 128000 } },
  { pattern: "*deepseek-chat*", caps: { contextWindow: 128000 } },
  { pattern: "*deepseek*",      caps: { reasoning: true, thinkingFormat: "deepseek", contextWindow: 128000 } },

  // ── MiniMax (M3 = adaptive; M2.x cannot disable) ─────────────────
  { pattern: "*minimax*image*", caps: { imageOutput: true } },
  { pattern: "*minimax-m3*",    caps: { vision: true, reasoning: true, thinkingFormat: "minimax", contextWindow: 1048576, maxOutput: 512000 } },
  { pattern: "*minimax-m2.7*",  caps: { reasoning: true, thinkingFormat: "minimax", thinkingCanDisable: false, contextWindow: 204800, maxOutput: 131072 } },
  { pattern: "*minimax*",       caps: { reasoning: true, thinkingFormat: "minimax", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 131072 } },

  // ── Xiaomi MiMo (vision, 1M / 262K ctx) ──────────────────────────
  // MiMo-V2.5 family — native reasoning (models.dev: reasoning:true, input
  // text+image+audio+video, 1M ctx). OpenAI-compatible API → openai effort.
  { pattern: "*mimo*v2.5*",     caps: { vision: true, audioInput: true, videoInput: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1048576, maxOutput: 131072 } },
  { pattern: "*mimo*auto*",     caps: { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 262144, maxOutput: 131072 } },
  { pattern: "*mimo*omni*",     caps: { vision: true, audioInput: true, contextWindow: 262144, maxOutput: 131072 } },
  { pattern: "*mimo*",          caps: { vision: true, contextWindow: 262144, maxOutput: 131072 } },

  // ── Llama (4 = vision/1M; 3.x = text-only/128K) ──────────────────
  { pattern: "*llama-4*",       caps: { vision: true, contextWindow: 1000000 } },
  { pattern: "*llama*",         caps: { contextWindow: 128000 } },

  // ── Mistral (Large 3 = vision/256K; codestral text) ──────────────
  { pattern: "*codestral*",     caps: { contextWindow: 256000 } },
  { pattern: "*mistral-large*", caps: { vision: true, contextWindow: 256000 } },
  { pattern: "*mistral*",       caps: { contextWindow: 128000 } },

  // ── Cohere (Command A Vision = vision; others text) ──────────────
  // Cohere Command A Reasoning — explicit reasoning model (models.dev: 256k ctx).
  { pattern: "*command-a-reasoning*", caps: { reasoning: true, thinkingFormat: "openai", contextWindow: 256000, maxOutput: 32000 } },
  { pattern: "*command-a-vision*", caps: { vision: true, contextWindow: 128000 } },
  { pattern: "*command*",       caps: { contextWindow: 128000 } },

  // ── Perplexity (web search native) ───────────────────────────────
  { pattern: "*sonar*",         caps: { search: true, contextWindow: 128000 } },
  { pattern: "*pplx*",          caps: { search: true, contextWindow: 128000 } },
  { pattern: "*perplexity*",    caps: { search: true, contextWindow: 128000 } },

  // ── Others ───────────────────────────────────────────────────────
  { pattern: "*laguna-s-2.1*",  caps: { reasoning: true, thinkingFormat: "openai", thinkingLevels: ["low", "medium", "high"], contextWindow: 1048576, maxOutput: 131072 } },
  { pattern: "*step-3.7*",      caps: { reasoning: true, thinkingFormat: "step", thinkingLevels: ["low", "medium", "high"], contextWindow: 256000, maxOutput: 256000 } },
  { pattern: "*hunyuan*",       caps: { reasoning: true, thinkingFormat: "hunyuan", contextWindow: 262144, maxOutput: 262144 } },
  { pattern: "hy3*",            caps: { reasoning: true, thinkingFormat: "hunyuan", contextWindow: 262144, maxOutput: 262144 } },
  { pattern: "*step-*",         caps: { reasoning: true, thinkingFormat: "step", contextWindow: 128000 } },
  // NVIDIA Nemotron / Inclusion Ling — OpenAI-compatible reasoning formats.
  { pattern: "*nemotron*",      caps: { reasoning: true, thinkingFormat: "openai", contextWindow: 128000 } },
  { pattern: "*ling-*",         caps: { reasoning: true, thinkingFormat: "openai", contextWindow: 128000 } },
];

/**
 * Resolve capabilities for a model using the 4-step fallback chain,
 * merged over DEFAULT_CAPABILITIES so the result is always complete.
 *
 * @param {string} provider
 * @param {string} model
 * @returns {object} full capabilities object
 */
export function getCapabilitiesForModel(provider, model) {
  if (!model) return { ...DEFAULT_CAPABILITIES };
  // Providers arrive as registry ids at runtime (parseModel → resolveProviderAlias)
  // but as aliases from UI call sites (AI_MODELS, /api/models, useModelCaps,
  // StatsBar). Normalize alias → id here so both keys resolve the same table.
  provider = resolveProviderAlias(provider);

  // 1. Provider-specific override
  if (provider && PROVIDER_CAPABILITIES[provider]?.[model]) {
    return { ...DEFAULT_CAPABILITIES, ...PROVIDER_CAPABILITIES[provider][model] };
  }

  // 2. Canonical exact (strip vendor prefix: "anthropic/claude-opus-4.7" -> "claude-opus-4.7")
  const baseModel = model.includes("/") ? model.split("/").pop() : model;
  if (MODEL_CAPABILITIES[baseModel]) return { ...DEFAULT_CAPABILITIES, ...MODEL_CAPABILITIES[baseModel] };
  if (MODEL_CAPABILITIES[model]) return { ...DEFAULT_CAPABILITIES, ...MODEL_CAPABILITIES[model] };

  // 3. Pattern match (first match wins)
  for (const { pattern, caps } of PATTERN_CAPABILITIES) {
    if (matchPattern(pattern, baseModel) || matchPattern(pattern, model)) {
      return { ...DEFAULT_CAPABILITIES, ...caps };
    }
  }

  // 4. Floor
  return { ...DEFAULT_CAPABILITIES };
}
