import { GlmExecutor } from "./glm.js";

// Statuses that mean "this endpoint leg rejects the credential/request shape"
// rather than "the provider is down". ZcodeExecutor advances to the next leg
// (zcode-plan → bigmodel → api.z.ai) on these, mirroring the Kiro
// gateway-first override. 400 stays terminal (malformed request), 429/5xx keep
// base behavior.
const ZCODE_ENDPOINT_FALLBACK_STATUSES = [401, 403, 404];

/**
 * ZCode executor — GLM effort tiers (inherited) + endpoint-leg fallback.
 *
 * The zcode-plan leg (zcode.z.ai/api/v1/zcode-plan/anthropic) is the Start
 * Plan runtime surface; the ZCode app additionally signs its requests with a
 * client-signing handshake (X-Client-Sig / X-Client-Pow). A router request
 * without that signature can be rejected with an auth-shaped status even when
 * the derived coding key is valid on the other legs — so 401/403/404 on any
 * leg but the last advances to the next endpoint instead of hard-stopping.
 */
export class ZcodeExecutor extends GlmExecutor {
  constructor(provider = "zcode") {
    super(provider);
  }

  /**
   * Multi-leg URL resolution. DefaultExecutor.buildUrl (inherited through
   * GlmExecutor) resolves only config.baseUrl — it predates baseUrls chains,
   * which only BaseExecutor.buildUrl (Kiro) walks. Without this override the
   * retry loop would re-request leg 0 on every urlIndex.
   */
  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    const baseUrls = this.getBaseUrls();
    const leg = baseUrls[urlIndex] || baseUrls[0];
    if (leg) return leg;
    return super.buildUrl(model, stream, urlIndex, credentials);
  }

  shouldRetry(status, urlIndex) {
    if (ZCODE_ENDPOINT_FALLBACK_STATUSES.includes(status)) {
      return urlIndex + 1 < this.getFallbackCount();
    }
    return super.shouldRetry(status, urlIndex);
  }
}

export default ZcodeExecutor;
