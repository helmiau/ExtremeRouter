// Proactive background OAuth token refresh.
//
// Refreshes OAuth connections within max(provider lead, 30 min) of expiry,
// independent of inbound traffic. Runs a first pass 10s after boot, then every
// 5 minutes. Timers are unref'd so they never keep the process alive.
// DISABLE_BACKGROUND_TOKEN_REFRESH=1 is the kill-switch.
//
// Fail-open: any per-tick or per-connection error is logged and skipped —
// the scheduler never throws into the caller, and one bad connection cannot
// block the rest of the sweep.

import * as log from "../utils/logger.js";
import { getProviderConnections } from "@/lib/localDb";
import { checkAndRefreshToken } from "./tokenRefresh.js";
import { getRefreshLeadMs } from "open-sse/services/tokenRefresh.js";

const BOOT_DELAY_MS = 10 * 1000;      // first pass shortly after server start
const TICK_INTERVAL_MS = 5 * 60 * 1000; // then every 5 minutes
const MIN_LEAD_MS = 30 * 60 * 1000;   // never refresh more than 30 min before expiry

const KILL_SWITCH = process.env.DISABLE_BACKGROUND_TOKEN_REFRESH === "1";

// Google's anti-abuse heuristics flag bursts of token refreshes from one IP —
// N simultaneous/back-to-back refreshes for antigravity/gemini-cli accounts
// look like credential stuffing. These providers refresh SERIALLY with wide
// spacing between connections (both delays env-tunable).
const SENSITIVE_PROVIDERS = new Set(["antigravity", "gemini-cli"]);
const SENSITIVE_REFRESH_SPACING_MS = Number(process.env.BG_REFRESH_GOOGLE_DELAY_MS) || 12_000;

let started = false;
let sweepInFlight = false;

/**
 * Compute how much lead time a connection actually needs.
 * max(provider lead, 30 min) — provider lead may be tiny (e.g. 5 min buffer).
 */
function effectiveLeadMs(provider) {
  return Math.max(getRefreshLeadMs(provider), MIN_LEAD_MS);
}

/**
 * One full sweep: iterate OAuth connections and force-refresh any whose token
 * expires within the effective lead window. Connections that don't need a
 * refresh (expiry far out, no refreshToken) are left untouched — the {force}
 * path only triggers when shouldRefreshCredentials would NOT have fired on the
 * request path, so a request never double-refreshes a token the scheduler just
 * renewed (lastRefreshAt is stamped on every refresh).
 */
async function sweep() {
  if (sweepInFlight) return; // don't stack ticks
  sweepInFlight = true;
  try {
    const connections = await getProviderConnections({ isActive: true });
    const oauthConnections = connections.filter((c) => c.authType === "oauth");

    let refreshed = 0;
    let prevWasSensitive = false; // previous COMPLETED refresh hit a Google endpoint
    for (const conn of oauthConnections) {
      const provider = conn.provider;
      const expiresAtMs = conn.expiresAt ? new Date(conn.expiresAt).getTime() : null;
      const due = expiresAtMs !== null && expiresAtMs - Date.now() < effectiveLeadMs(provider);

      if (!due) continue;
      if (!conn.refreshToken) {
        log.debug("REFRESH", `${provider}:${conn.id?.slice(0, 8)} due but no refreshToken — skip`);
        continue;
      }
      // Anti-abuse spacing: pause only between BACK-TO-BACK Google refreshes —
      // a rapid-fire sequence of antigravity/gemini-cli token refreshes from
      // one IP is exactly the pattern Google's heuristics flag. A refresh for
      // another provider in between resets the pattern.
      if (refreshed > 0 && prevWasSensitive && SENSITIVE_PROVIDERS.has(provider)) {
        const jitter = Math.floor(Math.random() * 5000);
        await new Promise((resolve) => setTimeout(resolve, SENSITIVE_REFRESH_SPACING_MS + jitter));
      }

      try {
        await checkAndRefreshToken(provider, conn, { force: true });
        refreshed++;
        prevWasSensitive = SENSITIVE_PROVIDERS.has(provider);
      } catch (err) {
        // Fail-open per connection: log, keep sweeping the rest.
        log.warn("REFRESH", `${provider}:${conn.id?.slice(0, 8)} background refresh failed`, {
          error: err?.message ?? err,
        });
        prevWasSensitive = false;
      }
    }
    if (refreshed > 0) {
      log.info("REFRESH", `Background refresh done: ${refreshed}/${oauthConnections.length} connections refreshed`);
    }
  } catch (err) {
    // Fail-open per tick: log and let the next tick try again.
    log.warn("REFRESH", "Background refresh sweep failed", { error: err?.message ?? err });
  } finally {
    sweepInFlight = false;
  }
}

/**
 * Start the background refresh scheduler. Idempotent; no-op when the
 * kill-switch is set.
 */
export function startBackgroundTokenRefresh() {
  if (KILL_SWITCH) {
    log.info("REFRESH", "Background token refresh disabled via DISABLE_BACKGROUND_TOKEN_REFRESH");
    return;
  }
  if (started) return;
  started = true;

  const bootTimer = setTimeout(() => {
    sweep().catch(() => {});
  }, BOOT_DELAY_MS);
  if (bootTimer.unref) bootTimer.unref();

  const ticker = setInterval(() => {
    sweep().catch(() => {});
  }, TICK_INTERVAL_MS);
  if (ticker.unref) ticker.unref();

  log.info("REFRESH", `Background token refresh started (boot +${BOOT_DELAY_MS / 1000}s, every ${TICK_INTERVAL_MS / 60000}min)`);
}
