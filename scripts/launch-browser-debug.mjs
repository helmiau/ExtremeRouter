#!/usr/bin/env node
// Cross-platform launcher for the Felo capture feature.
//
// Starts an installed Chromium-family browser (Brave → Chrome → Edge →
// Chromium, override with ER_CAPTURE_BROWSER) with --remote-debugging-port so
// the capture route can attach over CDP. Works on Windows, macOS and Linux —
// replaces the old Windows-only brave-extremerouter.cmd.
//
//   node scripts/launch-browser-debug.mjs

import {
  CDP_PORT,
  detectPlatform,
  findInstalledBrowser,
  isBrowserRunning,
  isCdpReachable,
  launchAndWait,
} from "../src/lib/browserDebug.js";

const platform = detectPlatform();
console.log(`Platform: ${platform}`);

if (await isCdpReachable()) {
  console.log(`[OK] Remote debugging already active on port ${CDP_PORT} — capture can attach right away.`);
  process.exit(0);
}

const browser = await findInstalledBrowser();
if (!browser) {
  console.error(
    "[!] No supported browser found. Install Brave, Google Chrome, Microsoft Edge or Chromium," +
      " or set ER_CAPTURE_BROWSER=brave|chrome|edge|chromium."
  );
  process.exit(1);
}
console.log(`Using ${browser.name} (${browser.path})`);

if (await isBrowserRunning(browser.path)) {
  console.error(
    `[!] ${browser.name} is already running WITHOUT remote debugging.` +
      " Close all its windows first, then run this script again."
  );
  process.exit(1);
}

console.log(`Starting ${browser.name} with remote debugging on port ${CDP_PORT} ...`);
if (await launchAndWait(browser.path)) {
  console.log(`[OK] ${browser.name} started — capture is ready.`);
} else {
  console.error(`[!] ${browser.name} did not open port ${CDP_PORT} in time.`);
  process.exit(1);
}
