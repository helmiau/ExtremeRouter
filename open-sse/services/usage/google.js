/**
 * Google usage handlers (Gemini CLI + Antigravity)
 */

import { CLIENT_METADATA, getPlatformUserAgent } from "../../config/appConstants.js";
import { ANTIGRAVITY_OAUTH_CLIENT } from "../../providers/shared.js";
import { U, parseResetTime, normalizeCloudCodeProjectId, fetchWithTimeout } from "./shared.js";

// Antigravity API config (from Quotio) — urls from registry, oauth client + dynamic UA kept here
const ANTIGRAVITY_CONFIG = {
  ...U("antigravity"),
  ...ANTIGRAVITY_OAUTH_CLIENT,
  userAgent: getPlatformUserAgent(),
};

/**
 * Gemini CLI Usage — fetch per-model quota via Cloud Code Assist API.
 * Uses retrieveUserQuota (same endpoint as `gemini /stats`) returning
 * per-model buckets with remainingFraction + resetTime.
 */
export async function getGeminiUsage(accessToken, providerSpecificData, proxyOptions = null) {
  if (!accessToken) {
    return { plan: "Free", message: "Gemini CLI access token not available." };
  }

  try {
    // Resolve project id: prefer connection-stored id, else loadCodeAssist lookup.
    // #1271: OAuth save stores projectId on the connection, not providerSpecificData.
    let projectId = normalizeCloudCodeProjectId(providerSpecificData?.projectId);
    let plan = "Free";

    if (!projectId) {
      const subInfo = await getGeminiSubscriptionInfo(accessToken, proxyOptions);
      projectId = normalizeCloudCodeProjectId(subInfo?.cloudaicompanionProject);
      plan = subInfo?.currentTier?.name || plan;
    }

    if (!projectId) {
      return {
        plan,
        message: "Gemini CLI project ID not available. Reconnect Gemini CLI, or configure a Google Cloud project with Gemini Code Assist access before checking quota.",
      };
    }

    const response = await fetchWithTimeout(
      U("gemini-cli").quotaUrl,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ project: projectId }),
      },
      10000,
      proxyOptions
    );

    if (!response.ok) {
      return { plan, message: `Gemini CLI quota error (${response.status}).` };
    }

    const data = await response.json();
    const quotas = {};

    if (Array.isArray(data.buckets)) {
      for (const bucket of data.buckets) {
        if (!bucket.modelId || bucket.remainingFraction == null) continue;

        const remainingFraction = Number(bucket.remainingFraction) || 0;
        const total = 1000; // Normalized base, matches antigravity convention
        const remaining = Math.round(total * remainingFraction);
        const used = Math.max(0, total - remaining);

        quotas[bucket.modelId] = {
          used,
          total,
          resetAt: parseResetTime(bucket.resetTime),
          remainingPercentage: remainingFraction * 100,
          unlimited: false,
        };
      }
    }

    return { plan, quotas };
  } catch (error) {
    return { message: `Gemini CLI error: ${error.message}` };
  }
}

/**
 * Get Gemini CLI subscription info via loadCodeAssist
 */
async function getGeminiSubscriptionInfo(accessToken, proxyOptions = null) {
  try {
    const response = await fetchWithTimeout(
      U("gemini-cli").loadCodeAssistUrl,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ metadata: CLIENT_METADATA }),
      },
      10000,
      proxyOptions
    );
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Antigravity Usage - Fetch quota from Google Cloud Code API
 */
export async function getAntigravityUsage(accessToken, providerSpecificData, proxyOptions = null) {
  try {
    // Fetch subscription info once — reuse for both projectId and plan
    const subscriptionInfo = await getAntigravitySubscriptionInfo(accessToken, proxyOptions);
    const projectId = subscriptionInfo?.cloudaicompanionProject || null;

    const response = await fetchWithTimeout(ANTIGRAVITY_CONFIG.quotaApiUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "User-Agent": ANTIGRAVITY_CONFIG.userAgent,
        "Content-Type": "application/json",
        "X-Client-Name": "antigravity",
        "X-Client-Version": "1.107.0",
        "x-request-source": "local", // MITM bypass
      },
      body: JSON.stringify({
        ...(projectId ? { project: projectId } : {})
      }),
    }, 10000, proxyOptions);

    if (response.status === 403) {
      return {
        message: "Antigravity quota API access forbidden. Chat may still work.",
        quotas: {}
      };
    }

    if (response.status === 401) {
      return {
        message: "Antigravity quota API authentication expired. Chat may still work.",
        quotas: {}
      };
    }

    if (!response.ok) {
      throw new Error(`Antigravity API error: ${response.status}`);
    }

    const data = await response.json();
    const quotas = {};

    // Parse model quotas into 4 consolidated family buckets (inspired by vscode-antigravity-cockpit):
    // 1. Claude Sonnet 4.6 (Thinking)
    // 2. Claude Opus 4.6 (Thinking)
    // 3. GPT-OSS 120B (Medium)
    // 4. Gemini Family (consolidates all Gemini models sharing the unified upstream quota pool)
    if (data.models) {
      let geminiRemainingFraction = null;
      let geminiResetTime = null;

      for (const [modelKey, info] of Object.entries(data.models)) {
        // Skip models without quota info or internal models
        if (!info?.quotaInfo || info.isInternal) {
          continue;
        }

        const remainingFraction = info.quotaInfo.remainingFraction != null
          ? Number(info.quotaInfo.remainingFraction)
          : null;
        if (remainingFraction == null) continue;

        // Group all Gemini models into the shared Gemini Family pool
        if (modelKey.startsWith("gemini-") || modelKey.includes("gemini")) {
          if (geminiRemainingFraction === null || remainingFraction < geminiRemainingFraction) {
            geminiRemainingFraction = remainingFraction;
          }
          if (info.quotaInfo.resetTime && (!geminiResetTime || new Date(info.quotaInfo.resetTime) < new Date(geminiResetTime))) {
            geminiResetTime = info.quotaInfo.resetTime;
          }
          continue;
        }

        // Direct non-Gemini family models
        if (modelKey === "claude-sonnet-4-6" || modelKey.includes("claude-sonnet")) {
          const total = 1000;
          const remaining = Math.round(total * remainingFraction);
          quotas["claude-sonnet-4-6"] = {
            used: total - remaining,
            total,
            resetAt: parseResetTime(info.quotaInfo.resetTime),
            remainingPercentage: remainingFraction * 100,
            unlimited: false,
            displayName: info.displayName || "Claude Sonnet 4.6 (Thinking)",
          };
        } else if (modelKey === "claude-opus-4-6-thinking" || modelKey.includes("claude-opus")) {
          const total = 1000;
          const remaining = Math.round(total * remainingFraction);
          quotas["claude-opus-4-6-thinking"] = {
            used: total - remaining,
            total,
            resetAt: parseResetTime(info.quotaInfo.resetTime),
            remainingPercentage: remainingFraction * 100,
            unlimited: false,
            displayName: info.displayName || "Claude Opus 4.6 (Thinking)",
          };
        } else if (modelKey === "gpt-oss-120b-medium" || modelKey.includes("gpt-oss")) {
          const total = 1000;
          const remaining = Math.round(total * remainingFraction);
          quotas["gpt-oss-120b-medium"] = {
            used: total - remaining,
            total,
            resetAt: parseResetTime(info.quotaInfo.resetTime),
            remainingPercentage: remainingFraction * 100,
            unlimited: false,
            displayName: info.displayName || "GPT-OSS 120B (Medium)",
          };
        }
      }

      // Add consolidated Gemini Family if any Gemini models were found
      if (geminiRemainingFraction !== null) {
        const total = 1000;
        const remaining = Math.round(total * geminiRemainingFraction);
        quotas["gemini-family"] = {
          used: total - remaining,
          total,
          resetAt: parseResetTime(geminiResetTime),
          remainingPercentage: geminiRemainingFraction * 100,
          unlimited: false,
          displayName: "Gemini Family",
        };
      }
    }

    return {
      plan: subscriptionInfo?.currentTier?.name || "Unknown",
      quotas,
      subscriptionInfo,
    };
  } catch (error) {
    console.error("[Antigravity Usage] Error:", error.message, error.cause);
    return { message: `Antigravity error: ${error.message}` };
  }
}

/**
 * Get Antigravity subscription info
 */
async function getAntigravitySubscriptionInfo(accessToken, proxyOptions = null) {
  try {
    const response = await fetchWithTimeout(ANTIGRAVITY_CONFIG.loadProjectApiUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "User-Agent": ANTIGRAVITY_CONFIG.userAgent,
        "Content-Type": "application/json",
        "x-request-source": "local", // MITM bypass
      },
      body: JSON.stringify({ metadata: CLIENT_METADATA, mode: 1 }),
    }, 10000, proxyOptions);

    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    console.error("[Antigravity Subscription] Error:", error.message);
    return null;
  }
}
