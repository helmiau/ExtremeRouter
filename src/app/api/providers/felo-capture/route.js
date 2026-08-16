import { NextResponse } from "next/server";
import { CDP_ENDPOINT, CDP_PORT, findInstalledBrowser, getCdpUpSince, isCdpReachable } from "@/lib/browserDebug";

const PAGE_LOAD_TIMEOUT_MS = 20000;
const FELO_HOME = "https://felo.ai";

// POST /api/providers/felo-capture
//
// Captures the user's logged-in Felo session from their RUNNING Chromium
// browser (Brave/Chrome/Edge, started with --remote-debugging-port):
//   1. Attaches to the existing instance over CDP (connectOverCDP) — no new
//      browser process, no temp/incognito profile.
//   2. Opens a NEW tab in the user's real browser (their profile, login, cookies).
//   3. Reads the `felo-user-token` (`6h_...`) + `visitor_id` cookies and calls
//      /api-proxy/ext/user/info to confirm the session.
//   4. Closes only that tab — the user's browser keeps running untouched.
//
// Logged-in Felo sessions authenticate via the session token (same value as
// the felo-user-token cookie) and do NOT need a Turnstile cf_token — thread
// creation returns 200 for a valid session. The returned credential is a
// ready-to-paste string:
//
//   cookie=felo-user-token=<6h_...>; visitor_id=<...>
//
// which parseFeloCredential accepts and derives the Bearer from.
export async function POST() {
  let browser = null;
  let page = null;
  try {
    // 1. Is a browser running with remote debugging?
    const reachable = await isCdpReachable(CDP_PORT);
    if (!reachable) {
      const detected = await findInstalledBrowser();
      return NextResponse.json(
        {
          error: "browser_not_reachable",
          message: detected
            ? `No browser is reachable for capture (port ${CDP_PORT}). Press “Launch browser” below to start ${detected.name} with remote debugging, or run: node scripts/launch-browser-debug.mjs`
            : `No browser is reachable for capture (port ${CDP_PORT}) and none was detected. Install Brave, Chrome or Edge and press “Launch browser”.`,
        },
        { status: 409 },
      );
    }

    // 2. Attach to the RUNNING instance (playwright-core is ~7 MB and loads
    //    only when this route is used — no browser download needed).
    const { chromium } = await import("playwright-core");
    browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    const context = browser.contexts()[0] || (await browser.newContext());

    // 3. Open a new tab in the user's real browser.
    page = await context.newPage();
    await page.goto(FELO_HOME, { waitUntil: "domcontentloaded", timeout: PAGE_LOAD_TIMEOUT_MS });
    await page.waitForTimeout(2500);

    // 4. Read the session cookies.
    const cookies = await context.cookies(FELO_HOME);
    const byName = Object.fromEntries(cookies.map((c) => [c.name, c.value]));
    const sessionToken = byName["felo-user-token"] || "";
    const visitorId = byName["visitor_id"] || "";

    if (!sessionToken) {
      return NextResponse.json(
        {
          error: "not_logged_in",
          message:
            "No Felo session found in the browser. Log in to felo.ai in the opened tab, then press Capture again.",
        },
        { status: 401 },
      );
    }

    // 5. Confirm the session and grab profile info. /ext/user/info expects
    //    the RAW session token (no `Bearer ` prefix — unlike thread creation,
    //    which accepts `Bearer <token>`), mirroring the frontend.
    let profile = null;
    try {
      const infoRes = await fetch("https://felo.ai/api-proxy/ext/user/info", {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
          Accept: "application/json",
          Authorization: sessionToken,
        },
        signal: AbortSignal.timeout(8000),
      });
      if (infoRes.ok) {
        const json = await infoRes.json();
        const d = json?.data;
        if (d) {
          profile = {
            name: d.name || d.email?.split("@")[0] || `User ${d.uid}`,
            email: d.email || "",
            image: d.picture || "",
            uid: d.uid || "",
          };
        }
      }
    } catch {
      // Session cookie alone is enough for chat — profile is a bonus.
      profile = null;
    }

    const credential = `cookie=felo-user-token=${sessionToken}${visitorId ? `; visitor_id=${visitorId}` : ""}`;

    return NextResponse.json({ credential, profile, loggedIn: Boolean(profile), cdpUpSinceMs: getCdpUpSince() });
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      return NextResponse.json({ error: "Capture timed out — is the browser window responsive?" }, { status: 504 });
    }
    return NextResponse.json(
      { error: "capture_failed", message: err?.message || "Failed to capture Felo session" },
      { status: 500 },
    );
  } finally {
    // Leave the user's Brave running — close only the tab we opened.
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {}); // CDP disconnect, not browser quit
  }
}
