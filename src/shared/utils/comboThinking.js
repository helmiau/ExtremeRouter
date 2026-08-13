// Pure combo thinking-mode classification — no React, no DOM. Used by
// ComboCard to gate thinking options, mirrored exactly in the runtime's
// thinkingUnified.applyFormat so the UI never advertises a mode a model
// can't honor (and never hides one it can).
//
//   • effort   → reasoning_effort is translated into EVERY native format
//                (openai / claude-adaptive / claude-budget / gemini-level /
//                gemini-budget / zai / deepseek / kimi / ...), so any
//                reasoning-capable model can honor it.
//   • extended → budget_tokens is consumed only by the budget-capable formats
//                (claude-*, gemini-*, qwen, hunyuan, minimax, zai). OpenAI-style
//                effort formats (openai / deepseek / kimi / step) drop a budget
//                config, so they can't honor it.

// Formats whose native shape consumes a thinking budget.
const BUDGET_FORMATS = new Set([
  "claude-adaptive", "claude-budget", "claude", "extended",
  "gemini-level", "gemini-budget", "qwen", "hunyuan", "minimax", "zai",
]);

const budgetCapable = (caps) =>
  !!caps?.reasoning && (!caps?.thinkingFormat || BUDGET_FORMATS.has(caps.thinkingFormat));

/**
 * Classify a list of combo members' capability objects.
 *
 * @param {Array<{model: string, caps: object}>} modelThinking
 * @returns {{hasEffort: boolean, hasExtended: boolean, hasMaxEffort: boolean,
 *            unresolvableModels: Array, unsupportedForCurrent: (type: string) => Array}}
 */
export function classifyComboThinking(modelThinking, thinkingType = "") {
  const hasEffort = modelThinking.some((m) => !!m.caps?.reasoning);
  const hasExtended = modelThinking.some((m) => budgetCapable(m.caps));
  const hasMaxEffort = modelThinking.some((m) => !!m.caps?.thinkingMaxEffort);
  const unresolvableModels = modelThinking.filter((m) => !m.caps?.reasoning && m.caps?.reasoning !== undefined);

  const unsupportedForCurrent =
    thinkingType === "effort"
      ? [] // every reasoning format translates reasoning_effort at runtime
      : thinkingType === "extended"
        ? modelThinking.filter((m) => m.caps?.reasoning === true && !budgetCapable(m.caps))
        : [];

  return { hasEffort, hasExtended, hasMaxEffort, unresolvableModels, unsupportedForCurrent };
}
