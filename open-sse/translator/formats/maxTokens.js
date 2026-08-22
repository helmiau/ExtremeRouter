import { DEFAULT_MAX_TOKENS, DEFAULT_MIN_TOKENS } from "../../config/runtimeConfig.js";
import { getCapabilitiesForModel } from "../../providers/capabilities.js";

/**
 * Adjust max_tokens based on request context and model capabilities
 * @param {object} body - Request body
 * @param {string} [provider] - Provider id (e.g. "tokenrouter") for capability lookup
 * @param {string} [model] - Model id (e.g. "qwen/qwen3.8-max-free") for capability lookup
 * @returns {number} Adjusted max_tokens
 */
export function adjustMaxTokens(body, provider = null, model = null) {
  let maxTokens = body.max_tokens || DEFAULT_MAX_TOKENS;

  // Auto-increase for tool calling to prevent truncated arguments (min never above max)
  if (body.tools && Array.isArray(body.tools) && body.tools.length > 0) {
    if (maxTokens < DEFAULT_MIN_TOKENS) {
      maxTokens = DEFAULT_MIN_TOKENS;
    }
  }

  // Ensure max_tokens > thinking.budget_tokens (Claude API requirement)
  // Claude API requires strictly greater, so add buffer instead of using DEFAULT_MAX_TOKENS
  // which could equal budget_tokens when budget_tokens >= 64000
  if (body.thinking?.budget_tokens && maxTokens <= body.thinking.budget_tokens) {
    maxTokens = body.thinking.budget_tokens + 1024;
  }

  // Never exceed the global ceiling
  if (maxTokens > DEFAULT_MAX_TOKENS) maxTokens = DEFAULT_MAX_TOKENS;

  // Model-specific clamp: ensure input + output <= model's contextWindow
  // Input tokens are estimated from the request body; for safety we don't
  // compute exact input here (would require tokenizer). Instead we cap
  // maxTokens to the model's declared maxOutput if available, and if the
  // model has a known contextWindow we apply a soft ceiling.
  if (provider && model) {
    const caps = getCapabilitiesForModel(provider, model);
    // If model declares a lower maxOutput, respect it (e.g. qwen 64k vs global 64k)
    if (caps.maxOutput && maxTokens > caps.maxOutput) {
      maxTokens = Math.min(maxTokens, caps.maxOutput);
    }
    // If model has a contextWindow, clamp so output doesn't exceed it
    // (actual input tokens are unknown here — callers that know exact
    // promptTokens should clamp further before calling).
    if (caps.contextWindow && caps.contextWindow < DEFAULT_MAX_TOKENS) {
      maxTokens = Math.min(maxTokens, caps.contextWindow);
    }
  }

  return maxTokens;
}

