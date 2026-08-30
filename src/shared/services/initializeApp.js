import os from "os";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync } from "fs";
import { cleanupProviderConnections, getSettings, updateSettings, getApiKeys } from "@/lib/localDb";
import {
  enableTunnel, enableTailscale,
  isTunnelManuallyDisabled, isTunnelReconnecting, isTailscaleReconnecting,
  getTunnelService, getTailscaleService, setTunnelUnexpectedExitCallback,
  killCloudflared, isCloudflaredRunning, ensureCloudflared,
  isTailscaleRunning, isTailscaleRunningStrict, isDaemonAlive, startFunnel,
  checkInternet,
  RESTART_COOLDOWN_MS, NETWORK_SETTLE_MS,
  WATCHDOG_INTERVAL_MS, NETWORK_CHECK_INTERVAL_MS, VIRTUAL_IFACE_REGEX,
} from "@/lib/tunnel";
import { getMitmStatus, startMitm, loadEncryptedPassword, initDbHooks, restoreToolDNS, removeAllDNSEntriesSync } from "@/mitm/manager";
import { startQuotaAutoPing } from "@/shared/services/quotaAutoPing";
import { initAlertService } from "@/shared/services/alertService";
import { syncToJson as syncMitmAliasCache } from "@/lib/mitmAliasCache";
import { reactivateExpiredKimchiAccounts } from "@/sse/services/kimchiQuotaReactivation";
import { startBackgroundTokenRefresh } from "@/sse/services/backgroundTokenRefresh";

// Inject correct paths and DB hooks into manager.js (CJS) from ESM context
(function bootstrapMitm() {
  if (!process.env.MITM_SERVER_PATH) {
    try {
      const thisFile = fileURLToPath(import.meta.url);
      const appSrc = dirname(dirname(thisFile));
      const candidate = join(appSrc, "mitm", "server.js");
      if (existsSync(candidate)) process.env.MITM_SERVER_PATH = candidate;
    } catch { /* ignore */ }
  }
  try { initDbHooks(getSettings, updateSettings); } catch { /* ignore */ }
})();

// Raise limit to accommodate all legitimate shutdown handlers:
// 3 DB adapters (6) + sqljs (2) + requestDetailsRepo (4) + initializeApp (3) +
// mitm server (2) + headroom/other (2) = ~19. Set to 40 for headroom.
process.setMaxListeners(40);

// Global error handlers — prevent a single unhandled rejection from killing
// the gateway (Node 15+ default is process exit on unhandledRejection).
// These log the error for diagnostics but allow the process to continue.
if (!global.__erGlobalHandlersRegistered) {
  global.__erGlobalHandlersRegistered = true;
  process.on("unhandledRejection", (reason) => {
    console.error("[FATAL] Unhandled promise rejection:", reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[FATAL] Uncaught exception:", err?.stack || err);
  });
}

// Survive Next.js hot reload
const g = global.__appSingleton ??= {
  signalHandlersRegistered: false,
  watchdogInterval: null,
  networkMonitorInterval: null,
  lastNetworkFingerprint: null,
  lastWatchdogTick: Date.now(),
  lastOnline: null,
  mitmStartInProgress: false,
  tunnelAutoResumed: false,
  tailscaleAutoResumed: false,
  kimchiReactivationStarted: false,
};

// ─── Kimchi quota auto-reactivation ──────────────────────────────────────
// Kimchi Community-tier quota resets at 00:00 UTC. Accounts deactivated with
// testStatus="quota_exhausted" are re-activated once their cooldown passes.
// Runs at startup + every 30 min (unref'd so it never keeps the process alive).
const KIMCHI_REACTIVATION_INTERVAL_MS = 30 * 60 * 1000;

function startKimchiQuotaReactivation() {
  if (g.kimchiReactivationStarted) return;
  g.kimchiReactivationStarted = true;

  const sweep = () => {
    reactivateExpiredKimchiAccounts().catch((e) => {
      console.log("[InitApp] Kimchi quota reactivation sweep failed:", e?.message || e);
    });
  };

  // Initial sweep at startup (catches accounts whose reset passed while offline).
  sweep();
  const interval = setInterval(sweep, KIMCHI_REACTIVATION_INTERVAL_MS);
  if (interval.unref) interval.unref();
}

export async function initializeApp() {
  try {
    await cleanupProviderConnections();
    const settings = await getSettings();

    // Auto-resume tunnel (once per process)
    if (settings.tunnelEnabled && !g.tunnelAutoResumed) {
      g.tunnelAutoResumed = true;
      console.log("[InitApp] Tunnel was enabled, auto-resuming...");
      safeRestartTunnel("startup").catch((e) => console.log("[InitApp] Tunnel resume failed:", e.message));
    }

    // Auto-resume tailscale (once per process)
    if (settings.tailscaleEnabled && !g.tailscaleAutoResumed) {
      g.tailscaleAutoResumed = true;
      console.log("[InitApp] Tailscale was enabled, auto-resuming...");
      safeRestartTailscale("startup").catch((e) => console.log("[InitApp] Tailscale resume failed:", e.message));
    }

    if (!g.signalHandlersRegistered) {
      const cleanup = () => {
        try { removeAllDNSEntriesSync(); } catch { /* best effort */ }
        killCloudflared();
        process.exit();
      };
      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);
      process.on("exit", () => { try { removeAllDNSEntriesSync(); } catch { /* ignore */ } });
      g.signalHandlersRegistered = true;
    }

    ensureCloudflared().catch(() => {});

    // Sync mitmAlias DB → JSON cache so standalone MITM server can read it
    syncMitmAliasCache().catch(() => {});

    // Auto-respawn tunnel when cloudflared exits unexpectedly (e.g. network change drop)
    setTunnelUnexpectedExitCallback(() => {
      safeRestartTunnel("unexpected-exit").catch(() => {});
    });

    startWatchdog();
    startNetworkMonitor();
    autoStartMitm();
    startQuotaAutoPing();
    initAlertService();
    startKimchiQuotaReactivation();
    startBackgroundTokenRefresh();
    // Dynamic model capability catalog — non-blocking background refresh of
    // model metadata from models.dev. Failure-isolated; MODEL_CATALOG=off disables.
    import("@/lib/modelCatalog/sync")
      .then((m) => m.startModelCatalogSync())
      .catch((err) => console.error("[model-catalog] startup failed:", err?.message || err));
  } catch (error) {
    console.error("[InitApp] Error:", error);
  }
}

async function autoStartMitm() {
  if (g.mitmStartInProgress) return;
  g.mitmStartInProgress = true;
  try {
    const settings = await getSettings();
    if (!settings.mitmEnabled) return;
    const mitmStatus = await getMitmStatus();
    if (mitmStatus.running) return;

    const password = await loadEncryptedPassword();
    if (!password && process.platform !== "win32") {
      console.log("[InitApp] MITM was enabled but no saved password found, skipping auto-start");
      return;
    }

    const keys = await getApiKeys();
    const activeKey = keys.find(k => k.isActive !== false);

    console.log("[InitApp] MITM was enabled, auto-starting...");
    await startMitm(activeKey?.key || "sk_extremerouter", password);
    console.log("[InitApp] MITM auto-started");
    try {
      await restoreToolDNS(password);
      console.log("[InitApp] DNS restored from saved state");
    } catch (e) {
      console.log("[InitApp] DNS restore failed:", e.message);
    }
  } catch (err) {
    console.log("[InitApp] MITM auto-start failed:", err.message);
  } finally {
    g.mitmStartInProgress = false;
  }
}

// Cooldown only applies to repeating watchdog ticks (anti hammer-loop).
// Network/exit events are one-shot transitions → bypass to recover fast.
const FORCE_RESTART_REASONS = /^(startup|netchange|sleep|sleep\+netchange|online|unexpected-exit)$/;

// ─── Safe restart (4 guards: spawn / cooldown / alive / internet) ────────────

async function safeRestartTunnel(reason) {
  const svc = getTunnelService();
  const settings = await getSettings();
  if (!settings.tunnelEnabled) return;
  if (svc.cancelToken.cancelled) return;
  if (svc.spawnInProgress) return;

  const force = FORCE_RESTART_REASONS.test(reason);

  // Process alive = trust cloudflared (self-reconnects via --retries 99, keeps same URL).
  // Killing a live process on network change drops the tunnel and rotates the quick-tunnel URL.
  if (isCloudflaredRunning()) return;

  if (!force && Date.now() - svc.lastRestartAt < RESTART_COOLDOWN_MS) {
    console.log(`[Tunnel] degraded but cooldown active, skip (${reason})`);
    return;
  }
  if (!await checkInternet()) return;

  console.log(`[Tunnel] safeRestart (${reason}) — tunnel unreachable${force ? " [force]" : ""}`);
  try {
    await enableTunnel();
    svc.lastRestartAt = Date.now();
    console.log("[Tunnel] restart success");
  } catch (err) {
    if (!/cloudflared killed|tunnel cancelled/.test(err.message)) {
      console.log("[Tunnel] restart failed:", err.message);
    }
  }
}

async function safeRestartTailscale(reason) {
  const svc = getTailscaleService();
  const settings = await getSettings();
  if (!settings.tailscaleEnabled) return;
  if (svc.cancelToken.cancelled) return;
  if (svc.spawnInProgress) return;

  // Tailscale daemon is OS-level with built-in reconnect; trust it when running (even on netchange).
  // Startup uses strict probe — cached state is cold after process/dev reload.
  const running = reason === "startup" ? await isTailscaleRunningStrict() : isTailscaleRunning();
  if (running) return;

  // Daemon alive but funnel dropped → recover funnel only; never full-restart (preserves login/daemon).
  if (isDaemonAlive() && svc.activeLocalPort) {
    try {
      await startFunnel(svc.activeLocalPort);
      svc.lastRestartAt = Date.now();
      console.log("[Tailscale] funnel re-established (daemon alive)");
    } catch (err) {
      console.log("[Tailscale] funnel recovery failed:", err.message);
    }
    return;
  }

  const force = FORCE_RESTART_REASONS.test(reason);
  if (!force && Date.now() - svc.lastRestartAt < RESTART_COOLDOWN_MS) {
    console.log(`[Tailscale] degraded but cooldown active, skip (${reason})`);
    return;
  }
  if (!await checkInternet()) return;

  console.log(`[Tailscale] safeRestart (${reason}) — daemon not running${force ? " [force]" : ""}`);
  try {
    await enableTailscale();
    svc.lastRestartAt = Date.now();
    console.log("[Tailscale] restart success");
  } catch (err) {
    console.log("[Tailscale] restart failed:", err.message);
  }
}

// ─── Watchdog: 60s tick check both services ──────────────────────────────────

function startWatchdog() {
  if (g.watchdogInterval) return;
  g.watchdogInterval = setInterval(() => {
    safeRestartTunnel("watchdog").catch(() => {});
    safeRestartTailscale("watchdog").catch(() => {});
  }, WATCHDOG_INTERVAL_MS);
  if (g.watchdogInterval.unref) g.watchdogInterval.unref();
}

// ─── Network monitor: detect IPv4 fingerprint change + sleep/wake ────────────

function getNetworkFingerprint() {
  const interfaces = os.networkInterfaces();
  const active = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    if (VIRTUAL_IFACE_REGEX.test(name)) continue;
    for (const addr of addrs) {
      if (!addr.internal && addr.family === "IPv4") {
        active.push(`${name}:${addr.address}`);
      }
    }
  }
  return active.sort().join("|");
}

function startNetworkMonitor() {
  if (g.networkMonitorInterval) return;

  g.lastNetworkFingerprint = getNetworkFingerprint();
  g.lastWatchdogTick = Date.now();
  g.lastOnline = null;

  g.networkMonitorInterval = setInterval(async () => {
    try {
      const now = Date.now();
      const elapsed = now - g.lastWatchdogTick;
      g.lastWatchdogTick = now;

      const currentFingerprint = getNetworkFingerprint();
      const networkChanged = currentFingerprint !== g.lastNetworkFingerprint;
      const wasSleep = elapsed > NETWORK_CHECK_INTERVAL_MS * 6;
      if (networkChanged) g.lastNetworkFingerprint = currentFingerprint;

      // Real reachability check (TCP 1.1.1.1:443) — not just interface presence
      const online = await checkInternet();
      const wasOffline = g.lastOnline === false;
      g.lastOnline = online;

      if (!online) return; // no internet → idle, don't restart

      const onlineEdge = wasOffline; // offline → online transition
      if (!networkChanged && !wasSleep && !onlineEdge) return;

      // Wait for DHCP/DNS to settle before probing
      await new Promise((r) => setTimeout(r, NETWORK_SETTLE_MS));

      const reason = onlineEdge ? "online"
        : wasSleep && networkChanged ? "sleep+netchange"
        : wasSleep ? "sleep" : "netchange";
      safeRestartTunnel(reason).catch(() => {});
      safeRestartTailscale(reason).catch(() => {});
    } catch (err) {
      console.log("[NetworkMonitor] error:", err.message);
    }
  }, NETWORK_CHECK_INTERVAL_MS);

  if (g.networkMonitorInterval.unref) g.networkMonitorInterval.unref();
}

export default initializeApp;
