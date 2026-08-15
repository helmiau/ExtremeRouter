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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execSync } from "node:child_process";

export const CDP_PORT = 9222;
export const CDP_ENDPOINT = `http://127.0.0.1:${CDP_PORT}`;

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
 * Find the best installed browser. Ordered Brave → Chrome → Edge → Chromium;
 * override with `ER_CAPTURE_BROWSER=brave|chrome|edge|chromium`.
 */
export async function findInstalledBrowser(preferredId = process.env.ER_CAPTURE_BROWSER || null) {
  const candidates = getBrowserCandidates();
  if (preferredId) {
    const pref = candidates.find((c) => c.id === preferredId);
    if (pref) {
      const p = resolveBrowserPath(pref);
      if (p) return { ...pref, path: p };
    }
  }
  for (const c of candidates) {
    const p = resolveBrowserPath(c);
    if (p) return { ...c, path: p };
  }
  return null;
}

/** Is a CDP endpoint already answering on the given port? */
export async function isCdpReachable(port = CDP_PORT, timeoutMs = 2500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
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
