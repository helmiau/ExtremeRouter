// Provider-level output ceilings — hard caps a provider's backend enforces
// regardless of what the model's capability table advertises.
//
// Only providers with a ceiling already established in this repository appear
// here; these values were previously duplicated as local constants inside the
// executors. Do NOT add speculative entries — an absent provider means "no
// known provider ceiling", which the resolver treats as no constraint rather
// than fabricating one.
export const PROVIDER_MAX_OUTPUT_TOKENS = {
  // Google's Antigravity backend rejects/truncates above this.
  antigravity: 16384,
  // Codex Responses API output cap.
  codex: 128000,
};

/** Ceiling for a provider id, or null when none is known. */
export function getProviderMaxOutputTokens(provider) {
  if (!provider) return null;
  return PROVIDER_MAX_OUTPUT_TOKENS[provider] ?? null;
}
