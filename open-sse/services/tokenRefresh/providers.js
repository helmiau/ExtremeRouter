import { PROVIDERS, PROVIDER_OAUTH } from "../../config/providers.js";
import { OAUTH_ENDPOINTS, GITHUB_COPILOT } from "../../config/appConstants.js";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { dedupRefresh } from "./dedup.js";
import { buildExternalIdpRefreshParams } from "../../../src/lib/oauth/kiroExternalIdp.js";

// Timeout for all token-refresh fetch calls. A hung OAuth endpoint pins the
// provider via dedupRefresh + credential lock, so every refresh fetch MUST
// be bounded. 15s is generous enough for slow providers but prevents indefinite hangs.
const REFRESH_TIMEOUT_MS = 15000;

/**
 * Wrap fetch options with a timeout signal if none is present.
 * Returns a new options object with signal attached.
 */
function withTimeout(options = {}) {
  if (options.signal) return options; // caller already set a signal
  return { ...options, signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS) };
}

// Bounded fetch wrapper for token refresh — prevents hung endpoints from
// pinning the provider via dedupRefresh + credential lock.
const _refreshFetch = (url, options) => fetch(url, withTimeout(options));

let _xaiServiceSingleton = null;
export async function refreshXaiToken(refreshToken, log) {
  if (!refreshToken) return null;
  return dedupRefresh("xai", refreshToken, async () => {
    try {
      if (!_xaiServiceSingleton) {
        const mod = await import("../../../src/lib/oauth/services/xai.js");
        _xaiServiceSingleton = new mod.XaiService();
      }
      const tokens = await _xaiServiceSingleton.refreshAccessToken(refreshToken);
      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || refreshToken,
        expiresIn: tokens.expires_in,
        idToken: tokens.id_token,
      };
    } catch (e) {
      log?.warn?.("TOKEN_REFRESH", `xai refresh failed: ${e?.message || e}`);
      const msg = String(e?.message || "");
      if (msg.includes("invalid_grant") || msg.includes("invalid_request")) {
        return { error: "invalid_grant" };
      }
      return null;
    }
  }, log);
}

export async function refreshAccessToken(provider, refreshToken, credentials, log) {
  const config = PROVIDERS[provider];

  if (!config || !config.refreshUrl) {
    log?.warn?.("TOKEN_REFRESH", `No refresh URL configured for provider: ${provider}`);
    return null;
  }

  if (!refreshToken) {
    log?.warn?.("TOKEN_REFRESH", `No refresh token available for provider: ${provider}`);
    return null;
  }

  return dedupRefresh(provider, refreshToken, async () => {
  try {
    const response = await _refreshFetch(config.refreshUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      log?.error?.("TOKEN_REFRESH", `Failed to refresh token for ${provider}`, {
        status: response.status,
        error: errorText,
      });
      return null;
    }

    const tokens = await response.json();

    log?.info?.("TOKEN_REFRESH", `Successfully refreshed token for ${provider}`, {
      hasNewAccessToken: !!tokens.access_token,
      hasNewRefreshToken: !!tokens.refresh_token,
      expiresIn: tokens.expires_in,
    });

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || refreshToken,
      expiresIn: tokens.expires_in,
    };
  } catch (error) {
    log?.error?.("TOKEN_REFRESH", `Error refreshing token for ${provider}`, {
      error: error.message,
    });
    return null;
  }
  }, log);
}

export async function refreshClaudeOAuthToken(refreshToken, log) {
  if (!refreshToken) return null;
  return dedupRefresh("claude", refreshToken, async () => {
  try {
    const response = await _refreshFetch(OAUTH_ENDPOINTS.anthropic.token, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: PROVIDERS.claude.clientId,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      log?.error?.("TOKEN_REFRESH", "Failed to refresh Claude OAuth token", { status: response.status, error: errorText });
      return null;
    }

    const tokens = await response.json();
    log?.info?.("TOKEN_REFRESH", "Successfully refreshed Claude OAuth token", { hasNewAccessToken: !!tokens.access_token, expiresIn: tokens.expires_in });
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || refreshToken, expiresIn: tokens.expires_in };
  } catch (error) {
    log?.error?.("TOKEN_REFRESH", `Network error refreshing Claude token: ${error.message}`);
    return null;
  }
  }, log);
}

export async function refreshClineToken(refreshToken, log, providerId = "cline") {
  if (!refreshToken) return null;
  return dedupRefresh(`cline:${providerId}`, refreshToken, async () => {
    const refreshUrl = PROVIDERS[providerId]?.refreshUrl || PROVIDERS.cline?.refreshUrl;
    if (!refreshUrl) {
      log?.warn?.("TOKEN_REFRESH", `No refreshUrl configured for provider: ${providerId}`);
      return null;
    }
    try {
      const response = await _refreshFetch(refreshUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ refreshToken, grantType: "refresh_token", clientType: "extension" }),
      });
      if (!response.ok) {
        const errorText = await response.text();
        log?.error?.("TOKEN_REFRESH", `Failed to refresh token for ${providerId}`, { status: response.status, error: errorText });
        return null;
      }
      const payload = await response.json();
      const data = payload?.data || payload;
      const expiresAtIso = data?.expiresAt;
      const expiresIn = expiresAtIso ? Math.max(1, Math.floor((new Date(expiresAtIso).getTime() - Date.now()) / 1000)) : undefined;
      let accessToken = data?.accessToken;
      if (accessToken && !accessToken.startsWith("workos:")) {
        accessToken = `workos:${accessToken}`;
      }
      log?.info?.("TOKEN_REFRESH", `Successfully refreshed ${providerId} token`, { hasNewAccessToken: !!accessToken, expiresIn });
      return { accessToken, refreshToken: data?.refreshToken || refreshToken, expiresIn };
    } catch (error) {
      log?.error?.("TOKEN_REFRESH", `Network error refreshing ${providerId} token: ${error.message}`);
      return null;
    }
  }, log);
}

export async function refreshGoogleToken(refreshToken, clientId, clientSecret, log) {
  if (!refreshToken) return null;
  return dedupRefresh(`google:${clientId}`, refreshToken, async () => {
  try {
    const response = await _refreshFetch(OAUTH_ENDPOINTS.google.token, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      log?.error?.("TOKEN_REFRESH", "Failed to refresh Google token", { status: response.status, error: errorText });
      return null;
    }

    const tokens = await response.json();
    log?.info?.("TOKEN_REFRESH", "Successfully refreshed Google token", { hasNewAccessToken: !!tokens.access_token, expiresIn: tokens.expires_in });
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || refreshToken, expiresIn: tokens.expires_in };
  } catch (error) {
    log?.error?.("TOKEN_REFRESH", `Network error refreshing Google token: ${error.message}`);
    return null;
  }
  }, log);
}

export async function refreshQwenToken(refreshToken, log) {
  if (!refreshToken) return null;
  return dedupRefresh("qwen", refreshToken, async () => {
  const endpoint = OAUTH_ENDPOINTS.qwen.token;

  try {
    const response = await _refreshFetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: PROVIDERS.qwen.clientId,
      }),
    });

    if (response.status === 200) {
      const tokens = await response.json();

      log?.info?.("TOKEN_REFRESH", "Successfully refreshed Qwen token", {
        hasNewAccessToken: !!tokens.access_token,
        hasNewRefreshToken: !!tokens.refresh_token,
        expiresIn: tokens.expires_in,
      });

      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || refreshToken,
        expiresIn: tokens.expires_in,
        providerSpecificData: tokens.resource_url
          ? { resourceUrl: tokens.resource_url }
          : undefined,
      };
    } else {
      const errorText = await response.text().catch(() => "");
      log?.warn?.("TOKEN_REFRESH", `Error with Qwen endpoint`, {
        status: response.status,
        error: errorText,
      });
    }
  } catch (error) {
    log?.warn?.("TOKEN_REFRESH", `Network error trying Qwen endpoint`, {
      error: error.message,
    });
  }

  log?.error?.("TOKEN_REFRESH", "Failed to refresh Qwen token");
  return null;
  }, log);
}

export function classifyOAuthRefreshError(errorText = "", status = 0) {
  let parsed = null;
  try {
    parsed = errorText ? JSON.parse(errorText) : null;
  } catch {
    parsed = null;
  }

  const code = parsed?.error?.code || parsed?.error || parsed?.error_code || "";
  const description = parsed?.error_description || parsed?.message || errorText || "";
  const combined = `${code} ${description}`.toLowerCase();
  const permanent = [
    "refresh_token_expired",
    "refresh_token_reused",
    "refresh_token_invalidated",
    "invalid_grant",
  ].some((marker) => combined.includes(marker));

  return { status, code, description, permanent };
}

export async function refreshCodexToken(refreshToken, log) {
  if (!refreshToken) return null;
  return dedupRefresh("codex", refreshToken, async () => {
    try {
      const response = await _refreshFetch(OAUTH_ENDPOINTS.openai.token, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          client_id: PROVIDERS.codex.clientId,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        const failure = classifyOAuthRefreshError(errorText, response.status);
        if (failure.permanent) {
          log?.error?.("TOKEN_REFRESH", "Codex refresh token already used or invalid. Re-auth required.", {
            status: response.status,
            code: failure.code,
          });
          return { error: "unrecoverable_refresh_error", code: failure.code };
        }

        log?.error?.("TOKEN_REFRESH", "Failed to refresh Codex token", {
          status: response.status,
          error: errorText,
          code: failure.code,
          permanent: failure.permanent,
        });
        return null;
      }

      const tokens = await response.json();

      log?.info?.("TOKEN_REFRESH", "Successfully refreshed Codex token", {
        hasNewAccessToken: !!tokens.access_token,
        hasNewRefreshToken: !!tokens.refresh_token,
        hasIdToken: !!tokens.id_token,
        expiresIn: tokens.expires_in,
      });

      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || refreshToken,
        idToken: tokens.id_token,
        expiresIn: tokens.expires_in,
      };
    } catch (error) {
      log?.error?.("TOKEN_REFRESH", `Network error refreshing Codex token: ${error.message}`);
      return null;
    }
  }, log);
}

async function resolveKiroProfileArnPatch(providerSpecificData, accessToken, refreshedArn) {
  if (providerSpecificData?.profileArn) return {};
  let profileArn = refreshedArn?.trim?.() || null;
  if (!profileArn) {
    const { fetchKiroProfileArn } = await import("../../../src/lib/oauth/providers.js");
    profileArn = await fetchKiroProfileArn(accessToken);
  }
  return profileArn ? { providerSpecificData: { profileArn } } : {};
}

export async function refreshKiroToken(refreshToken, providerSpecificData, log, proxyOptions = null) {
  if (!refreshToken) return null;
  return dedupRefresh("kiro", refreshToken, async () => {
  const authMethod = providerSpecificData?.authMethod;
  const clientId = providerSpecificData?.clientId;
  const clientSecret = providerSpecificData?.clientSecret;
  const region = providerSpecificData?.region;

  if (authMethod === "external_idp") {
    let refreshRequest;
    try {
      refreshRequest = buildExternalIdpRefreshParams(refreshToken, providerSpecificData);
    } catch (error) {
      log?.warn?.("TOKEN_REFRESH", `Invalid Kiro external_idp refresh config: ${error.message}`);
      return null;
    }

    const response = await proxyAwareFetch(refreshRequest.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: refreshRequest.body,
    }, proxyOptions);

    if (!response.ok) {
      const errorText = await response.text();
      log?.error?.("TOKEN_REFRESH", "Failed to refresh Kiro external_idp token", {
        status: response.status,
        error: errorText,
      });
      return null;
    }

    const tokens = await response.json();

    log?.info?.("TOKEN_REFRESH", "Successfully refreshed Kiro external_idp token", {
      hasNewAccessToken: !!tokens.access_token,
      hasNewRefreshToken: !!tokens.refresh_token,
      expiresIn: tokens.expires_in,
    });

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || refreshToken,
      expiresIn: tokens.expires_in,
      providerSpecificData: refreshRequest.providerSpecificData,
    };
  }

  if (clientId && clientSecret) {
    const isIDC = authMethod === "idc";
    const endpoint = isIDC && region
      ? `https://oidc.${region}.amazonaws.com/token`
      : "https://oidc.us-east-1.amazonaws.com/token";

    const response = await proxyAwareFetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        clientId: clientId,
        clientSecret: clientSecret,
        refreshToken: refreshToken,
        grantType: "refresh_token",
      }),
    }, proxyOptions);

    if (!response.ok) {
      const errorText = await response.text();
      log?.error?.("TOKEN_REFRESH", "Failed to refresh Kiro AWS token", {
        status: response.status,
        error: errorText,
      });
      return null;
    }

    const tokens = await response.json();

    log?.info?.("TOKEN_REFRESH", "Successfully refreshed Kiro AWS token", {
      hasNewAccessToken: !!tokens.accessToken,
      expiresIn: tokens.expiresIn,
    });

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken || refreshToken,
      expiresIn: tokens.expiresIn,
      ...(await resolveKiroProfileArnPatch(providerSpecificData, tokens.accessToken, tokens.profileArn)),
    };
  }

  const response = await proxyAwareFetch(PROVIDERS.kiro.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "kiro-cli/1.0.0",
    },
    body: JSON.stringify({
      refreshToken: refreshToken,
    }),
  }, proxyOptions);

  if (!response.ok) {
    const errorText = await response.text();
    log?.error?.("TOKEN_REFRESH", "Failed to refresh Kiro social token", {
      status: response.status,
      error: errorText,
    });
    return null;
  }

  const tokens = await response.json();

  log?.info?.("TOKEN_REFRESH", "Successfully refreshed Kiro social token", {
    hasNewAccessToken: !!tokens.accessToken,
    expiresIn: tokens.expiresIn,
  });

  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || refreshToken,
    expiresIn: tokens.expiresIn,
    ...(await resolveKiroProfileArnPatch(providerSpecificData, tokens.accessToken, tokens.profileArn)),
  };
  }, log);
}

export async function refreshIflowToken(refreshToken, log) {
  if (!refreshToken) return null;
  return dedupRefresh("iflow", refreshToken, async () => {
  const basicAuth = btoa(`${PROVIDERS.iflow.clientId}:${PROVIDERS.iflow.clientSecret}`);

  const response = await _refreshFetch(OAUTH_ENDPOINTS.iflow.token, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: PROVIDERS.iflow.clientId,
      client_secret: PROVIDERS.iflow.clientSecret,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    log?.error?.("TOKEN_REFRESH", "Failed to refresh iFlow token", {
      status: response.status,
      error: errorText,
    });
    return null;
  }

  const tokens = await response.json();

  log?.info?.("TOKEN_REFRESH", "Successfully refreshed iFlow token", {
    hasNewAccessToken: !!tokens.access_token,
    hasNewRefreshToken: !!tokens.refresh_token,
    expiresIn: tokens.expires_in,
  });

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || refreshToken,
    expiresIn: tokens.expires_in,
  };
  }, log);
}

export async function refreshGitHubToken(refreshToken, log) {
  if (!refreshToken) return null;
  return dedupRefresh("github", refreshToken, async () => {
  const params = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: PROVIDERS.github.clientId,
  };
  if (PROVIDERS.github.clientSecret) {
    params.client_secret = PROVIDERS.github.clientSecret;
  }

  const response = await _refreshFetch(OAUTH_ENDPOINTS.github.token, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(params),
  });

  if (!response.ok) {
    const errorText = await response.text();
    log?.error?.("TOKEN_REFRESH", "Failed to refresh GitHub token", {
      status: response.status,
      error: errorText,
    });
    return null;
  }

  const tokens = await response.json();

  log?.info?.("TOKEN_REFRESH", "Successfully refreshed GitHub token", {
    hasNewAccessToken: !!tokens.access_token,
    hasNewRefreshToken: !!tokens.refresh_token,
    expiresIn: tokens.expires_in,
  });

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || refreshToken,
    expiresIn: tokens.expires_in,
  };
  }, log);
}

export async function refreshCopilotToken(githubAccessToken, log) {
  if (!githubAccessToken) return null;
  return dedupRefresh("copilot", githubAccessToken, async () => {
  try {
    const response = await _refreshFetch(PROVIDER_OAUTH["github"]?.copilotTokenUrl, {
      headers: {
        "Authorization": `token ${githubAccessToken}`,
        "User-Agent": GITHUB_COPILOT.USER_AGENT,
        "Editor-Version": `vscode/${GITHUB_COPILOT.VSCODE_VERSION}`,
        "Editor-Plugin-Version": `copilot-chat/${GITHUB_COPILOT.COPILOT_CHAT_VERSION}`,
        "Accept": "application/json",
        "x-github-api-version": GITHUB_COPILOT.API_VERSION
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      log?.error?.("TOKEN_REFRESH", "Failed to refresh Copilot token", {
        status: response.status,
        error: errorText
      });
      return null;
    }

    const data = await response.json();

    log?.info?.("TOKEN_REFRESH", "Successfully refreshed Copilot token", {
      hasToken: !!data.token,
      expiresAt: data.expires_at
    });

    return {
      token: data.token,
      expiresAt: data.expires_at
    };
  } catch (error) {
    log?.error?.("TOKEN_REFRESH", "Error refreshing Copilot token", {
      error: error.message
    });
    return null;
  }
  }, log);
}

// CodeBuddy-family (Tencent) refresh — POST /v2/plugin/auth/token/refresh with
// the refresh token carried in the X-Refresh-Token header (not a form body),
// matching the official CodeBuddy CLI. Shared by codebuddy-cn, codebuddy-intl
// and workbuddy (same contract per host). Response: { code: 0, data: <token> }.
export async function refreshCodebuddyToken(refreshToken, log, providerId = "codebuddy-cn") {
  if (!refreshToken) return null;
  return dedupRefresh(providerId, refreshToken, async () => {
    const oauth = PROVIDER_OAUTH[providerId] || {};
    const response = await _refreshFetch(oauth.refreshUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": oauth.userAgent,
        "X-Requested-With": "XMLHttpRequest",
        "X-Domain": oauth.baseUrl?.replace(/^https?:\/\//, "") || "copilot.tencent.com",
        "X-Refresh-Token": refreshToken,
        "X-Auth-Refresh-Source": "plugin",
        "X-Product": "SaaS",
      },
      body: "{}",
    });

    if (!response.ok) {
      const errorText = await response.text();
      log?.error?.("TOKEN_REFRESH", "Failed to refresh CodeBuddy token", {
        status: response.status,
        error: errorText,
      });
      return null;
    }

    const data = await response.json();
    if (data.code !== 0 || !data.data?.accessToken) {
      log?.error?.("TOKEN_REFRESH", "CodeBuddy token refresh returned no token", {
        code: data.code,
        msg: data.msg,
      });
      return null;
    }

    log?.info?.("TOKEN_REFRESH", "Successfully refreshed CodeBuddy token", {
      hasNewAccessToken: !!data.data.accessToken,
      hasNewRefreshToken: !!data.data.refreshToken,
      expiresIn: data.data.expiresIn,
    });

    return {
      accessToken: data.data.accessToken,
      refreshToken: data.data.refreshToken || refreshToken,
      expiresIn: data.data.expiresIn,
    };
  }, log);
}

/**
 * Zed Hosted AI — mint a new short-lived LLM bearer token.
 *
 * Zed's auth model is two-layered: the long-lived user credentials (userId +
 * zedAccessToken, the latter stored as `refreshToken` on the connection) are
 * exchanged for a 1h LLM token via POST /client/llm_tokens. The executor also
 * refreshes inline on 401, but this handler enables proactive/health refresh.
 *
 * @param {string} refreshToken - the Zed user access token (zedAccessToken)
 * @param {object} providerSpecificData - must contain userId (+ optional organizationId)
 */
export async function refreshZedLlmToken(refreshToken, providerSpecificData, log) {
  if (!refreshToken) return null;
  const userId = providerSpecificData?.userId;
  if (!userId) {
    log?.warn?.("TOKEN_REFRESH", "Zed refresh missing userId in providerSpecificData");
    return null;
  }
  const organizationId = providerSpecificData?.organizationId || null;
  return dedupRefresh("zed", refreshToken, async () => {
    const base = (PROVIDERS.zed?.baseUrl || "https://cloud.zed.dev").replace(/\/$/, "");
    const path = PROVIDER_OAUTH.zed?.llmTokensPath || "/client/llm_tokens";
    const body = organizationId ? { organization_id: organizationId } : {};
    const response = await proxyAwareFetch(`${base}${path}`, {
      method: "POST",
      headers: {
        Authorization: `${userId} ${refreshToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      log?.error?.("TOKEN_REFRESH", `Zed LLM token refresh failed (${response.status}): ${text.slice(0, 200)}`);
      return null;
    }
    const data = await response.json().catch(() => null);
    const raw = data?.token;
    // Token may be a plain string or a CBOR-ish object { "0": "..." }.
    const token =
      typeof raw === "string"
        ? raw
        : raw && typeof raw === "object"
          ? raw["0"] || raw.token || Object.values(raw)[0]
          : null;
    if (!token) {
      log?.error?.("TOKEN_REFRESH", "Zed LLM token response missing token");
      return null;
    }
    log?.info?.("TOKEN_REFRESH", "Successfully minted new Zed LLM token");
    return {
      accessToken: token,
      expiresIn: 3600,
      providerSpecificData: { llmToken: token, lastLlmTokenAt: new Date().toISOString() },
    };
  }, log);
}
