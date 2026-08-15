import { NextResponse } from "next/server";
import {
  CDP_PORT,
  detectPlatform,
  findInstalledBrowser,
  isBrowserRunning,
  isCdpReachable,
  launchAndWait,
} from "@/lib/browserDebug";

// POST /api/providers/felo-capture/launch
//
// One-click setup for the capture flow: detects the OS and an installed
// Chromium-family browser (Brave → Chrome → Edge → Chromium), then starts it
// with --remote-debugging-port so /api/providers/felo-capture can attach.
// The browser must not be running (CDP can't be enabled on a live instance),
// so a running browser yields 409 asking the user to close it first.
export async function POST() {
  try {
    if (await isCdpReachable()) {
      return NextResponse.json({ alreadyRunning: true, port: CDP_PORT });
    }

    const platform = detectPlatform();
    const browser = await findInstalledBrowser();
    if (!browser) {
      return NextResponse.json(
        {
          error: "no_browser",
          message:
            "No supported browser found on this machine. Install Brave, Google Chrome, Microsoft Edge or Chromium (or set ER_CAPTURE_BROWSER=brave|chrome|edge|chromium), then retry.",
        },
        { status: 404 },
      );
    }

    if (await isBrowserRunning(browser.path)) {
      return NextResponse.json(
        {
          error: "browser_running",
          message: `${browser.name} is running without remote debugging — close all its windows, then press Launch again.`,
        },
        { status: 409 },
      );
    }

    const ok = await launchAndWait(browser.path);
    if (!ok) {
      return NextResponse.json(
        {
          error: "launch_timeout",
          message: `${browser.name} did not open the debug port in time — try launching it manually with --remote-debugging-port=${CDP_PORT}.`,
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      launched: true,
      browser: { id: browser.id, name: browser.name, path: browser.path },
      port: CDP_PORT,
      platform,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "launch_failed", message: err?.message || "Failed to launch browser" },
      { status: 500 },
    );
  }
}
