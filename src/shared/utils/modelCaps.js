// Single source of truth for the client-facing caps shape exposed by
// /api/models and mirrored by useModelCaps' fallback path. Keeping the shape in
// one place prevents the alias-vs-id drift that previously made the dashboard
// display different capabilities than the runtime used.
//
// Emits ONLY non-default fields (missing key ⇒ default), so the 1352-model
// catalog stays small on the wire while consumers that read `caps.x` get the
// right answer (undefined is falsy / treated as the default):
//   • booleans defaulting to false are omitted when false
//   • thinkingCanDisable defaults to true → omitted when true
//   • thinkingFormat / thinkingLevels omitted when absent
//   • maxOutput emitted whenever the model has a real output cap (> 0)
//   • confidence emitted only when NOT "verified"; absent ⇒ verified
//   • known emitted only when false (unknown/default floor); absent ⇒ known

/**
 * Build the client-facing caps object from the full runtime capabilities.
 * @param {object} c - result of getCapabilitiesForModel (full field set)
 * @returns {object} compact client caps
 */
export function toClientCaps(c) {
  if (!c) return {};
  // Badge booleans are ALWAYS present (coerced) so consumers never see
  // undefined for the fields CapacityBadges renders.
  const caps = {
    vision: !!c.vision,
    search: !!c.search,
    reasoning: !!c.reasoning,
    pdf: !!c.pdf,
    audioInput: !!c.audioInput,
    videoInput: !!c.videoInput,
  };
  if (typeof c.maxOutput === "number" && c.maxOutput > 0) caps.maxOutput = c.maxOutput;
  // Provenance. Absent `confidence` ⇒ "verified" (the omit-defaults convention
  // above), so only inferred/unknown results pay for the field. `known` is
  // emitted only when false and is redundant with confidence === "unknown";
  // it stays for consumers that only need the boolean.
  if (c.confidence && c.confidence !== "verified") caps.confidence = c.confidence;
  if (c.known === false) caps.known = false;
  if (c.thinkingMaxEffort) caps.thinkingMaxEffort = true;
  if (Array.isArray(c.thinkingLevels) && c.thinkingLevels.length > 0) {
    caps.thinkingLevels = c.thinkingLevels;
  }
  if (c.thinkingCanDisable === false) caps.thinkingCanDisable = false;
  if (c.thinkingFormat) caps.thinkingFormat = c.thinkingFormat;
  return caps;
}

/**
 * Project a derived combo capability object (deriveComboCapabilities output,
 * catalog shape: vision/audio as {input, output}, thinking as reasoning) onto
 * the same compact client shape CapacityBadges and the dashboard consume.
 * Badge booleans are ALWAYS present (coerced), consistent with toClientCaps.
 * @param {object} c - deriveComboCapabilities output
 * @returns {object} compact client caps
 */
export function comboToClientCaps(c) {
  if (!c) return {};
  const caps = {
    vision: !!c.vision?.input,
    search: !!c.search,
    reasoning: !!c.thinking,
    pdf: !!c.pdf,
    audioInput: !!c.audio?.input,
    videoInput: !!c.videoInput,
  };
  if (typeof c.maxOutput === "number" && c.maxOutput > 0) caps.maxOutput = c.maxOutput;
  return caps;
}
