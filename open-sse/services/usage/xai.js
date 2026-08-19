// xAI (Grok) usage handler for Quota Tracker.
//
// STATUS (2026-08):
//   xAI removed the public billing/subscription endpoints from the inference
//   API (api.x.ai). Both of the following now return HTTP 404:
//     - GET /v1/billing?format=credits
//     - GET /v1/user?include=subscription
//
//   Billing moved to a SEPARATE Management API on management-api.x.ai that
//   requires a dedicated Management Key (console.x.ai → Settings →
//   Management Keys). That key is distinct from the chat API key / OAuth
//   access token. As of 2026-08 the documented public billing surface is
//   still incomplete — every management-api.x.ai path we probed returned 404.
//
// Strategy (mirrors TokenRouter two-key design + local gateway spend):
//   1. If providerSpecificData.mgmtKey is set, probe Management API once.
//      On success → return remote credits. On 404/error → fall through.
//   2. Always fall back to local gateway spend aggregated from usageHistory
//      for this connection (cost + prompt/completion tokens). This is the
//      only reliable signal while xAI has no public billing endpoint.
//
// Reference: github.com/decolua/9router PR #2672 (original, now-defunct
// endpoints); TokenRouter handler for the two-key pattern.

import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { toFiniteNumber } from "./shared.js";

const MGMT_BILLING_CANDIDATES = [
  "https://management-api.x.ai/v1/billing",
  "https://management-api.x.ai/billing",
  "https://management-api.x.ai/v1/usage",
];

function emptyLocal() {
  return {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    cost: 0,
  };
}

/**
 * Aggregate local gateway spend for one xAI connection from usageHistory.
 * Lazy-imports usageDb so unit tests that only exercise the handler's
 * credential/message path don't pull the SQLite driver.
 */
async function loadLocalSpend(connectionId) {
  if (!connectionId) return emptyLocal();
  try {
    const { getUsageHistory } = await import("@/lib/usageDb.js");
    const rows = await getUsageHistory({ connectionId, provider: "xai" });
    const out = emptyLocal();
    for (const r of rows || []) {
      out.requests += 1;
      out.promptTokens += toFiniteNumber(r.promptTokens ?? r.tokens?.prompt ?? 0);
      out.completionTokens += toFiniteNumber(r.completionTokens ?? r.tokens?.completion ?? 0);
      out.cost += toFiniteNumber(r.cost);
    }
    // Round USD to 6 decimals so floating sum noise doesn't clutter the card.
    out.cost = Math.round(out.cost * 1e6) / 1e6;
    return out;
  } catch {
    return emptyLocal();
  }
}

function buildLocalQuotas(local) {
  const totalTokens = local.promptTokens + local.completionTokens;
  return {
    "Gateway spend": {
      used: local.cost,
      total: local.cost,
      remaining: 0,
      remainingPercentage: null,
      resetAt: null,
      unlimited: true,
      unit: "usd",
      displayName: "Gateway spend (local)",
    },
    "Gateway tokens": {
      used: totalTokens,
      total: totalTokens,
      remaining: 0,
      remainingPercentage: null,
      resetAt: null,
      unlimited: true,
      unit: "tokens",
      displayName: "Gateway tokens (local)",
    },
  };
}

/**
 * Best-effort Management API probe. Returns credits-shaped payload on success,
 * null on any failure (404 / network / unexpected shape).
 */
async function tryManagementBilling(mgmtKey, proxyOptions) {
  const headers = {
    Authorization: `Bearer ${mgmtKey}`,
    Accept: "application/json",
  };

  for (const url of MGMT_BILLING_CANDIDATES) {
    let res;
    try {
      res = await proxyAwareFetch(url, { method: "GET", headers }, proxyOptions);
    } catch {
      continue;
    }
    if (!res?.ok) continue;

    const body = await res.json().catch(() => null);
    if (!body || typeof body !== "object") continue;

    // Accept a few plausible shapes (xAI has not published a stable schema).
    const remaining = toFiniteNumber(
      body.remaining ?? body.credits_remaining ?? body.balance ?? body.data?.remaining ?? body.data?.balance,
      NaN
    );
    const used = toFiniteNumber(
      body.used ?? body.credits_used ?? body.spent ?? body.data?.used ?? body.data?.spent,
      NaN
    );
    const total = toFiniteNumber(
      body.total ?? body.credits_total ?? body.limit ?? body.data?.total ?? body.data?.limit,
      NaN
    );

    if (!Number.isFinite(remaining) && !Number.isFinite(used) && !Number.isFinite(total)) {
      continue;
    }

    const safeRemaining = Number.isFinite(remaining) ? remaining : 0;
    const safeUsed = Number.isFinite(used) ? used : 0;
    const safeTotal = Number.isFinite(total) ? total : safeRemaining + safeUsed;

    return {
      quotas: {
        Credits: {
          used: safeUsed,
          total: safeTotal,
          remaining: safeRemaining,
          remainingPercentage: safeTotal > 0 ? Math.round((safeRemaining / safeTotal) * 100) : null,
          resetAt: body.reset_at || body.resetAt || null,
          unlimited: false,
          unit: "usd",
        },
      },
      plan: body.plan || body.subscription?.plan || null,
      credits: { remaining: safeRemaining, used: safeUsed, total: safeTotal },
    };
  }
  return null;
}

/**
 * @param {Object} credentials - connection-shaped object from getUsageForProvider
 * @param {Object|null} proxyOptions
 */
export async function getXaiUsage(credentials, proxyOptions = null) {
  const mgmtKey =
    credentials?.providerSpecificData?.mgmtKey ||
    credentials?.providerDataWithProjectId?.mgmtKey ||
    null;
  const connectionId = credentials?.connectionId || credentials?.id || null;

  // 1) Management Key path (forward-compat; currently expected to 404).
  if (mgmtKey) {
    const remote = await tryManagementBilling(mgmtKey, proxyOptions);
    if (remote) return remote;
  }

  // 2) Local gateway spend — always available for traffic that passed through
  //    ExtremeRouter. This is the primary signal until xAI documents billing.
  const local = await loadLocalSpend(connectionId);
  const quotas = buildLocalQuotas(local);

  if (local.requests === 0) {
    return {
      quotas,
      plan: null,
      credits: null,
      message: mgmtKey
        ? "xAI Management API key is set, but no public billing endpoint responded. Showing local gateway spend (no requests yet for this connection)."
        : "xAI has no public billing API. Showing local gateway spend tracked by ExtremeRouter (no requests yet for this connection). Optional: add a Management Key from console.x.ai → Settings → Management Keys for future remote billing support.",
    };
  }

  return {
    quotas,
    plan: null,
    credits: { remaining: 0, used: local.cost, total: local.cost },
    message: mgmtKey
      ? "xAI Management API key is set, but no public billing endpoint responded. Figures below are local gateway spend for this connection."
      : "xAI has no public billing API. Figures below are local gateway spend for this connection (cost estimated from model pricing).",
  };
}
