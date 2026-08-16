// Cross-platform browser detection + CDP launch for the Felo capture feature.
//
// playwright-core can only ATTACH to a browser that was started with
// `--remote-debugging-port` (there is no way to enable it on an already
// running instance), and only Chromium-based browsers speak CDP (Firefox uses
// a different protocol). So this module detects the OS and finds an installed
// Brave / Chrome / Edge / Chromium, then launches it with the debug port —
// on Windows, macOS and Linux.
//
// Only Node builtins here (no `@/` aliases) so it can be imported from both
// the Next.js API routes and plain Node CLI scripts.
//
// SECURITY NOTE: while a browser runs with --remote-debugging-port, ANY local
// process on the machine can connect to 127.0.0.1:9222 and read cookies for
// every site — not just the provider being captured. This is inherent to CDP.
// The UI tells users to close (or restart without the debug port) the browser
// after capturing, and isCdpReachable() tracks first-seen time so the UI can
// nag when a debug browser has been left running for a long time.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execSync } from "node:child_process";

export const CDP_PORT = 9222;
export const CDP_ENDPOINT = `http://127.0.0.1:${CDP_PORT}`;

// First time this server process saw the CDP endpoint answer. Used by the
// capture UI to warn about a long-running debug browser (accepted-risk doc:
// server restart resets it, so treat it as "at least this old").
let cdpFirstSeenAt = null;

export function detectPlatform() {
  return process.platform; // "win32" | "darwin" | "linux" | ...
}

/**
 * Ordered candidate list for a platform. Each candidate has `paths`
 * (absolute executable locations) and/or `commands` (PATH-resolvable names).
 */
export function getBrowserCandidates(platform = detectPlatform()) {
  const home = os.homedir();
  const pf = (x) =>
    path.join(process.env.ProgramFiles || "C:\\Program Files", x);
  const pf86 = (x) =>
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", x);
  const local = (x) =>
    path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), x);

  const WINDOWS = [
    {
      id: "brave",
      name: "Brave",
      paths: [
        pf("BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
        pf86("BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
        local("BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
      ],
    },
    {
      id: "chrome",
      name: "Google Chrome",
      paths: [
        pf("Google\\Chrome\\Application\\chrome.exe"),
        pf86("Google\\Chrome\\Application\\chrome.exe"),
        local("Google\\Chrome\\Application\\chrome.exe"),
      ],
    },
    {
      id: "edge",
      name: "Microsoft Edge",
      paths: [
        pf86("Microsoft\\Edge\\Application\\msedge.exe"),
        pf("Microsoft\\Edge\\Application\\msedge.exe"),
      ],
    },
    {
      id: "chromium",
      name: "Chromium",
      paths: [local("Chromium\\Application\\chrome.exe")],
    },
  ];

  const MACOS = [
    { id: "brave", name: "Brave", paths: ["/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"] },
    { id: "chrome", name: "Google Chrome", paths: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"] },
    { id: "edge", name: "Microsoft Edge", paths: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"] },
    { id: "chromium", name: "Chromium", paths: ["/Applications/Chromium.app/Contents/MacOS/Chromium"] },
  ];

  const LINUX = [
    {
      id: "brave",
      name: "Brave",
      commands: ["brave-browser", "brave"],
      paths: ["/usr/bin/brave-browser", "/opt/brave.com/brave/brave-browser", "/snap/bin/brave"],
    },
    {
      id: "chrome",
      name: "Google Chrome",
      commands: ["google-chrome", "google-chrome-stable"],
      paths: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"],
    },
    {
      id: "edge",
      name: "Microsoft Edge",
      commands: ["microsoft-edge", "microsoft-edge-stable"],
      paths: ["/usr/bin/microsoft-edge"],
    },
    {
      id: "chromium",
      name: "Chromium",
      commands: ["chromium", "chromium-browser"],
      paths: ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"],
    },
  ];

  const byPlatform = { win32: WINDOWS, darwin: MACOS, linux: LINUX };
  return (byPlatform[platform] || []).map((c) => ({ ...c, platform }));
}

function commandExists(command) {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, command + ext);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

/** Resolve a candidate to an existing executable path (or null). */
export function resolveBrowserPath(candidate) {
  for (const p of candidate.paths || []) {
    try {
      fs.accessSync(p);
      return p;
    } catch {
      /* not here */
    }
  }
  for (const c of candidate.commands || []) {
    const resolved = commandExists(c);
    if (resolved) return resolved;
  }
  return null;
}

/**
 * Does a `--version` output look like a real Chromium-family browser?
 * Requires a product name followed by a version number, so shell errors that
 * merely echo the command name ("command not found: brave") are rejected.
 * Standalone helper so it is unit-testable without spawning anything.
 */
export function isChromiumVersionOutput(text) {
  const s = String(text || "");
  return /\b(chrome|chromium|brave\s+browser|microsoft\s+edge|edge|headlessshell)\b[\s:/]*\d/i.test(s);
}

/**
 * Verify a PATH-resolved executable is really a Chromium-family browser by
 * running `<path> --version` and checking the output. A hijacked PATH entry
 * (e.g. a script named `brave` earlier in PATH) won't print a browser
 * version banner and is skipped. Fixed install paths are trusted as-is and
 * never exec'd for verification.
 */
export async function verifyChromiumBinary(binaryPath, { timeoutMs = 5000 } = {}) {
  return await new Promise((resolve) => {
    let out = "";
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok && isChromiumVersionOutput(out));
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    try {
      const child = spawn(binaryPath, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
      child.stdout?.on("data", (d) => { out += String(d); });
      child.stderr?.on("data", (d) => { out += String(d); });
      child.on("error", () => done(false));
      child.on("close", () => done(true));
    } catch {
      done(false);
    }
  });
}

function isFixedInstallPath(p, candidate) {
  return (candidate.paths || []).some((fixed) => fixed === p);
}

/**
 * Find the best installed browser. Ordered Brave → Chrome → Edge → Chromium;
 * override with `ER_CAPTURE_BROWSER=brave|chrome|edge|chromium`.
 *
 * Binaries resolved from fixed install locations are trusted directly; ones
 * resolved from PATH are verified with `--version` (see verifyChromiumBinary)
 * before being returned, so a PATH-hijacked executable is never launched
 * with the debug port.
 */
export async function findInstalledBrowser(preferredId = process.env.ER_CAPTURE_BROWSER || null) {
  const candidates = getBrowserCandidates();
  const ordered = preferredId
    ? [candidates.find((c) => c.id === preferredId), ...candidates.filter((c) => c.id !== preferredId)].filter(Boolean)
    : candidates;
  for (const c of ordered) {
    const p = resolveBrowserPath(c);
    if (!p) continue;
    if (isFixedInstallPath(p, c)) return { ...c, path: p };
    if (await verifyChromiumBinary(p)) return { ...c, path: p, verifiedFromPath: true };
  }
  return null;
}

/** Is a CDP endpoint already answering on the given port? */
export async function isCdpReachable(port = CDP_PORT, timeoutMs = 2500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok && !cdpFirstSeenAt) cdpFirstSeenAt = Date.now();
    return res.ok;
  } catch {
    return false;
  }
}

/** When this server first saw the debug browser (epoch ms), or null. */
export function getCdpUpSince() {
  return cdpFirstSeenAt;
}

/** Test-only: reset the first-seen tracking. */
export function __resetCdpTrackingForTests() {
  cdpFirstSeenAt = null;
}

function processNameOf(browserPath) {
  let base = path.basename(browserPath);
  if (process.platform === "win32") base = base.replace(/\.exe$/i, "");
  return base;
}

/** Is the given browser process already running (without CDP)? */
export function isBrowserRunning(browserPath) {
  const name = processNameOf(browserPath);
  try {
    if (process.platform === "win32") {
      const out = execSync(`tasklist /FI "IMAGENAME eq ${name}.exe" /NH`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return out.toLowerCase().includes(name.toLowerCase());
    }
    const out = execSync(`pgrep -f "${name}"`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/** Launch the browser detached with the debug port (caller keeps running). */
export function launchBrowserWithDebug(browserPath, { port = CDP_PORT } = {}) {
  const child = spawn(browserPath, [`--remote-debugging-port=${port}`, "--no-first-run"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child;
}

/** Launch and poll until the CDP endpoint answers (or timeout). */
export async function launchAndWait(browserPath, { port = CDP_PORT, timeoutMs = 20000 } = {}) {
  launchBrowserWithDebug(browserPath, { port });
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isCdpReachable(port, 1500)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return isCdpReachable(port, 1500);
}
