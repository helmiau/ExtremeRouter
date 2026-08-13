// Combo capability derivation — single source of truth for what a combo can do.
//
// A combo dispatches to one member per request, so its effective capability is
// composed from its members:
//   • modalities (vision/audio/video/pdf/search/tools) → UNION (any member can
//     do it, the combo can do it on that request)
//   • limits (contextWindow/maxOutput)                  → MIN (never exceed the
//     weakest member)
//   • thinking                                          → member-derived "can
//     think" (union of reasoning), unless the strategy explicitly disables it
//     (thinking.type === "off").
//
// Strategy intent ("will it actually emit reasoning") is deliberately NOT part
// of the derived capability — it lives in the strategy config and is exposed
// separately (e.g. /v1/models entry.strategy.thinking). capabilities.thinking
// answers "can I ask it to reason?", strategy answers "will it reason?".
//
// Members are passed as full capability objects (getCapabilitiesForModel
// output). A member may be `null` when the caller KNOWS it is unknown — it then
// contributes nothing (UNKNOWN_MEMBER_FLOOR): no modality, no limit. In this
// codebase getCapabilitiesForModel already returns a conservative safe floor
// (200k ctx / 64k output / tools) for unknown models, so callers that resolve
// members through it can pass the results directly and still get an honest,
// conservative answer.
//
// See docs/unified-model-capability-catalog.md §3 for the design.

import { getCapabilitiesForModel } from "./capabilities.js";

/**
 * Zero-assumption floor for a member that is definitely unknown.
 * contextWindow/maxOutput are null → treated as unlimited → the derived limit
 * is omitted (a limit we cannot verify must not be advertised).
 */
export const UNKNOWN_MEMBER_FLOOR = {
  vision: false,
  imageOutput: false,
  audioInput: false,
  audioOutput: false,
  videoInput: false,
  pdf: false,
  search: false,
  tools: false,
  reasoning: false,
  agentic: false,
  contextWindow: null,
  maxOutput: null,
};

/**
 * Resolve a combo member reference ("cc/claude-opus-4-7" or bare
 * "claude-opus-4-7") to its full capability object via getCapabilitiesForModel
 * (alias→id normalized internally). Returns null for empty refs.
 */
export function memberCapabilitiesForRef(ref) {
  if (typeof ref !== "string" || !ref.trim()) return null;
  const slash = ref.indexOf("/");
  if (slash > 0) {
    return getCapabilitiesForModel(ref.slice(0, slash), ref.slice(slash + 1));
  }
  return getCapabilitiesForModel("", ref);
}

/**
 * Derive a combo's effective capability catalog entry from its members.
 *
 * @param {Array<object|null>} members  member capability objects (or null for
 *   unknown members → UNKNOWN_MEMBER_FLOOR). Pass memberCapabilitiesForRef(ref).
 * @param {object} strategy  merged combo strategy config (strategyConfig +
 *   settings.comboStrategies[name] override). Only `thinking.type` is read.
 * @returns {object} catalog-shape capability object with `source: "combo"`.
 */
export function deriveComboCapabilities(members = [], strategy = {}) {
  const list = (members || []).map((m) => m || UNKNOWN_MEMBER_FLOOR);
  const has = (fn) => list.some((m) => fn(m));
  const strategyType = strategy?.thinking?.type;

  // Limits: min over members, omitted when there are no members or any member's
  // limit is unknown/unlimited (null/0) — a limit we cannot verify must not be
  // advertised (Math.min of an empty array is Infinity, guard it).
  const minLimit = (key) => {
    const values = list.map((m) => m[key]);
    const finite = values.filter((v) => typeof v === "number" && v > 0);
    if (list.length === 0 || finite.length < list.length) return undefined;
    return Math.min(...finite);
  };

  return {
    // can think: any member reasons — unless strategy turns thinking off
    thinking: strategyType !== "off" && has((m) => m.reasoning === true),
    // agentic is not in the internal caps shape; members may carry it, else false
    agentic: has((m) => m.agentic === true),
    tools: has((m) => m.tools === true),
    vision: { input: has((m) => m.vision === true), output: has((m) => m.imageOutput === true) },
    audio: { input: has((m) => m.audioInput === true), output: has((m) => m.audioOutput === true) },
    search: has((m) => m.search === true),
    pdf: has((m) => m.pdf === true),
    videoInput: has((m) => m.videoInput === true),
    contextWindow: minLimit("contextWindow"),
    maxOutput: minLimit("maxOutput"),
    source: "combo",
  };
}
