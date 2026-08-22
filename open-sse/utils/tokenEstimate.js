// Token count estimation — conservative heuristics only.
//
// ExtremeRouter does NOT ship a BPE tokenizer (no gpt-tokenizer / @anthropic-ai/token
// dependency). For context-window safety we need an *approximate* input token
// count — not exact, but never wildly optimistic. A 1-token ≈ 4-char heuristic
// for English text is standard across AI infra tooling and errs on the safe side
// for code-heavy prompts (code is token-denser, so we under-estimate here,
// which means the available-output ceiling is slightly conservative).
//
// This is explicitly documented as an approximation: callers that know the
// exact `prompt_tokens` from a previous response should pass it directly.

const CHARS_PER_TOKEN_FLOOR = 3;   // worst case: very token-dense code
const CHARS_PER_TOKEN_DEFAULT = 4; // English text standard
const CHAR_COUNT_REGEX = /\S/g;    // count non-whitespace chars (cheap, no split)

/**
 * Estimate input tokens from a chat-style request body's messages.
 * Counts non-whitespace characters and divides by a conservative ratio.
 *
 * @param {object} body - request body with .messages array
 * @param {number} [hints.exactInputTokens] - if known (e.g. from a prior response), use this
 * @returns {number} estimated input token count (≥ 0, integer)
 */
export function estimateInputTokens(body, hints = {}) {
  if (hints.exactInputTokens != null && hints.exactInputTokens >= 0) {
    return Math.floor(hints.exactInputTokens);
  }

  if (!body || typeof body !== "object" || !Array.isArray(body.messages)) return 0;

  let chars = 0;
  for (const msg of body.messages) {
    if (!msg || typeof msg !== "object") continue;
    const content = msg.content;
    if (typeof content === "string") {
      chars += countNonWhitespace(content);
    } else if (Array.isArray(content)) {
      // Anthropic/OpenAI content blocks
      for (const block of content) {
        if (block?.text && typeof block.text === "string") {
          chars += countNonWhitespace(block.text);
        }
      }
    }
  }

  // Use floor so we never over-estimate → context ceiling is conservative.
  return Math.floor(chars / CHARS_PER_TOKEN_FLOOR);
}

function countNonWhitespace(str) {
  return (str.match(CHAR_COUNT_REGEX) || []).length;
}

/**
 * Estimate only the non-thinking output tokens (for invariant checks).
 * If the body has explicit thinking budget, return it; otherwise 0.
 */
export function extractThinkingBudgetTokens(body) {
  if (!body || typeof body !== "object") return 0;

  // Claude shape
  if (body.thinking?.budget_tokens) {
    const b = Number(body.thinking.budget_tokens);
    return Number.isFinite(b) && b > 0 ? b : 0;
  }
  // Gemini shape
  const tc = body.thinkingConfig || body.generationConfig?.thinkingConfig;
  if (tc?.thinkingBudget) {
    const b = Number(tc.thinkingBudget);
    if (Number.isFinite(b) && b > 0) return b;
    if (b < 0) return Infinity; // "auto" / dynamic
  }
  // Qwen shape
  if (body.enable_thinking === true && body.thinking_budget) {
    const b = Number(body.thinking_budget);
    return Number.isFinite(b) && b > 0 ? b : 0;
  }
  return 0;
}
