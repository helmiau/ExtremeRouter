/**
 * ZCode (Zhipu / Z.ai) CLI OAuth service.
 *
 * Device-style browser flow + coding-plan key derivation, ported from the
 * ZCode app bundle (zcode.z.ai /oauth/cli). Sequence:
 *
 *   1. Generate a 32-byte hex pollToken locally; POST /oauth/cli/init with
 *      {provider:"zai"} + Bearer pollToken → {flow_id, authorize_url, ...}
 *   2. User approves the authorize_url in the browser
 *   3. GET /oauth/cli/poll/<flow_id> + Bearer pollToken until
 *      status:"ready" → {token, user, zai:{access_token}}
 *   4. Exchange the Z.ai OAuth token for the account's coding-plan API key
 *      ("zcode-api-key", returned as "<id>.<secret>") — the exact credential
 *      the ZCode app writes into its own config.
 *
 * All Z.ai endpoints answer with a business envelope {code, msg, data} where
 * code 0/200 (number or string) means success.
 */

import { randomBytes } from "node:crypto";

export const ZCODE_DEFAULTS = {
  baseUrl: "https://zcode.z.ai/api/v1",
  provider: "zai",
  apiKeyHost: "https://api.z.ai",
  apiKeyName: "zcode-api-key",
};

export function zcodeEnvelopeOk(code) {
  return code === 0 || code === 200 || code === "0" || code === "200";
}

// Single envelope request: JSON parse + success-code check → data (null on absent).
async function zcodeRequest(url, headers = {}, body = null, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(url, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => null);
  if (!json || !zcodeEnvelopeOk(json.code)) {
    throw new Error(json?.msg || `ZCode API error at ${url} (HTTP ${res.status})`);
  }
  return json.data ?? null;
}

export class ZcodeService {
  constructor(config = {}) {
    this.config = { ...ZCODE_DEFAULTS, ...config };
  }

  /**
   * Start a device login flow.
   * @returns {Promise<{pollToken, flowId, authorizeUrl, expiresInSeconds, pollIntervalSec}>}
   */
  async initiateDeviceFlow() {
    const pollToken = randomBytes(32).toString("hex");
    const data = await zcodeRequest(
      `${this.config.baseUrl}/oauth/cli/init`,
      { "Authorization": `Bearer ${pollToken}` },
      { provider: this.config.provider },
    );
    if (typeof data?.flow_id !== "string" || typeof data?.authorize_url !== "string") {
      throw new Error("ZCode OAuth init response is missing flow_id/authorize_url");
    }
    return {
      pollToken,
      flowId: data.flow_id,
      authorizeUrl: data.authorize_url,
      expiresInSeconds: Number.isFinite(data.expires_at) && data.expires_at > 0
        ? Math.max(30, Math.floor((data.expires_at * 1000 - Date.now()) / 1000))
        : 300,
      pollIntervalSec: Number.isFinite(data.poll_interval_sec) && data.poll_interval_sec > 0
        ? data.poll_interval_sec
        : 3,
    };
  }

  /**
   * Poll once for the flow result.
   * @returns {Promise<{status:"pending"|"failed"}|{status:"ready", zaiAccessToken, user}>}
   */
  async pollDeviceFlow({ flowId, pollToken }) {
    if (!flowId || !pollToken) throw new Error("Missing ZCode flow id or poll token");
    const data = await zcodeRequest(
      `${this.config.baseUrl}/oauth/cli/poll/${encodeURIComponent(flowId)}`,
      { "Authorization": `Bearer ${pollToken}` },
    );
    const status = data?.status;
    if (status === "pending") return { status: "pending" };
    if (status === "failed") return { status: "failed" };
    if (status === "ready" && typeof data.zai?.access_token === "string") {
      return {
        status: "ready",
        zaiAccessToken: data.zai.access_token,
        user: {
          userId: data.user?.user_id || "",
          email: data.user?.email || "",
          name: data.user?.name || "",
        },
      };
    }
    throw new Error("Invalid ZCode poll response");
  }

  /**
   * Derive the coding-plan API key ("<id>.<secret>") from a Z.ai OAuth token.
   * Mirrors ZCode's resolver: z/login → getCustomerInfo → api_keys → /copy.
   */
  async resolveCodingPlanApiKey(zaiAccessToken) {
    const host = this.config.apiKeyHost.replace(/\/+$/, "");

    // 1. Biz token
    const loginData = await zcodeRequest(`${host}/api/auth/z/login`, {}, { token: zaiAccessToken });
    const bizToken = loginData?.access_token?.trim() || loginData?.accessToken?.trim() || "";
    if (!bizToken) throw new Error("Z.AI login response is missing access_token");

    // 2. Org + project (prefer the default org/project, matching the ZCode app)
    const info = await zcodeRequest(`${host}/api/biz/customer/getCustomerInfo`, { "Authorization": `Bearer ${bizToken}` });
    const org = info?.organizations?.find((o) => o?.organizationName?.includes("默认机构")) || info?.organizations?.[0];
    const project = org?.projects?.find((p) => p?.projectName?.includes("默认项目")) || org?.projects?.[0];
    if (!org?.organizationId || !project?.projectId) {
      throw new Error("Unable to resolve Z.AI organization and project");
    }

    // 3. Find or create the named key
    const keysUrl = `${host}/api/biz/v1/organization/${org.organizationId}/projects/${project.projectId}/api_keys`;
    const keys = await zcodeRequest(keysUrl, { "Authorization": `Bearer ${bizToken}` });
    let keyItem = Array.isArray(keys) ? keys.find((k) => k?.name === this.config.apiKeyName) : null;
    if (!keyItem?.apiKey) {
      keyItem = await zcodeRequest(keysUrl, { "Authorization": `Bearer ${bizToken}` }, { name: this.config.apiKeyName });
    }
    const apiKeyId = keyItem?.apiKey?.trim() || "";
    if (!apiKeyId) throw new Error("Z.AI API key response is missing apiKey");

    // 4. Secret part → "<id>.<secret>"
    const copy = await zcodeRequest(`${keysUrl}/copy/${encodeURIComponent(apiKeyId)}`, { "Authorization": `Bearer ${bizToken}` });
    const secretKey = copy?.secretKey?.trim() || "";
    if (!secretKey) throw new Error("Z.AI API key copy response is missing secretKey");
    return `${apiKeyId}.${secretKey}`;
  }
}
