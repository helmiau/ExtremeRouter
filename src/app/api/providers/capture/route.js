import { NextResponse } from "next/server";
import { CDP_ENDPOINT, CDP_PORT, findInstalledBrowser, getCdpUpSince, isCdpReachable } from "@/lib/browserDebug";
import { getCookieCaptureConfig } from "@/shared/constants/cookieCapture";

const PAGE_LOAD_TIMEOUT_MS = 20000;
const SETTLE_MS = 3000;

// POST /api/providers/capture  body: { provider }
//
// Generic "auto capture cookies" — the Felo capture system generalized to
// every webCookie provider. Attaches to the user's RUNNING Chromium browser
// (started with --remote-debugging-port, see /api/providers/capture/launch),
// opens a tab on the provider's domain, reads the cookies / localStorage /
// Authorization header declared in COOKIE_CAPTURE metadata, then closes only
// the tab. Returns a ready-to-paste credential string in the format the
// provider's executor accepts.
export async function POST(request) {
  let browser = null;
  let page = null;
  let authHeader = null;
  try {
    let provider = "";
    try {
      const body = await request.json();
      provider = String(body?.provider || "");
    } catch {
      /* non-JSON body */
    }
    const config = getCookieCaptureConfig(provider);
    if (!config) {
      return NextResponse.json(
        { error: "unknown_provider", message: `No capture configuration for provider "${provider}".` },
        { status: 400 },
      );
    }
    const domains = config.domains?.length ? config.domains : ["example.com"];
    const origin = `https://${domains[0]}`;

    // 1. Is a browser running with remote debugging?
    const reachable = await isCdpReachable(CDP_PORT);
    if (!reachable) {
      const detected = await findInstalledBrowser();
      return NextResponse.json(
        {
          error: "browser_not_reachable",
          message: detected
            ? `No browser is reachable for capture (port ${CDP_PORT}). Press “Launch browser” below to start ${detected.name} with remote debugging.`
            : `No browser is reachable for capture (port ${CDP_PORT}) and none was detected. Install Brave, Chrome or Edge and press “Launch browser”.`,
        },
        { status: 409 },
      );
    }

    // 2. Attach to the RUNNING instance and open a new tab in the user's real browser.
    const { chromium } = await import("playwright-core");
    browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    const context = browser.contexts()[0] || (await browser.newContext());
    page = await context.newPage();

    // 3. Capture an Authorization header if the provider needs a Bearer JWT.
    // Same-origin only: third-party requests the page fires (analytics,
    // iframes) must not donate their tokens to the credential.
    if (config.authorization) {
      page.on("request", (r) => {
        if (authHeader) return;
        let url = "";
        try { url = r.url(); } catch { return; }
        if (!url.startsWith(origin)) return;
        const h = r.headers();
        const auth = h["authorization"] || h["Authorization"];
        if (auth && !authHeader) authHeader = auth;
      });
    }

    await page.goto(origin, { waitUntil: "domcontentloaded", timeout: PAGE_LOAD_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS);

    // 4. Extract the declared session data.
    const captured = [];
    const missing = [];
    let credential = "";

    // A captured value only counts when it actually holds session data — a
    // JSON placeholder like {"value":null} (deepseek userToken) is not one.
    const isMeaningful = (v) => {
      if (v == null) return false;
      const s = String(v).trim();
      if (!s || s === "null" || s === "undefined") return false;
      try {
        const parsed = JSON.parse(s);
        if (parsed && typeof parsed === "object" && "value" in parsed) {
          return parsed.value != null && String(parsed.value).trim() !== "";
        }
      } catch {
        /* not JSON — plain value */
      }
      return true;
    };

    const cookiesByDomain = {};
    for (const domain of domains) {
      cookiesByDomain[domain] = await context.cookies(`https://${domain}`);
    }

    if (config.fullCookieHeader) {
      const all = [];
      for (const domain of domains) {
        for (const c of cookiesByDomain[domain]) {
          if (c.value) all.push(`${c.name}=${c.value}`);
        }
      }
      credential = all.join("; ");
      if (all.length) captured.push(...domains.map((d) => `${d} cookies`));
      else missing.push(`${domains[0]} session cookies`);
    } else if (config.cookies?.length) {
      const byName = {};
      for (const domain of domains) {
        for (const c of cookiesByDomain[domain]) {
          if (!byName[c.name]) byName[c.name] = c.value;
        }
      }
      const pairs = [];
      for (const name of config.cookies) {
        const value = byName[name];
        if (isMeaningful(value)) {
          captured.push(name);
          pairs.push(config.mode === "bare" ? value : `${name}=${value}`);
        } else {
          missing.push(name);
        }
      }
      credential = config.mode === "bare" ? pairs[0] || "" : pairs.join("; ");
    } else if (config.localStorage?.length) {
      try {
        const values = await page.evaluate((keys) => {
          const out = {};
          for (const k of keys) out[k] = localStorage.getItem(k);
          return out;
        }, config.localStorage);
        for (const key of config.localStorage) {
          const value = values?.[key];
          if (isMeaningful(value)) {
            captured.push(key);
            credential = config.mode === "bare" ? value : `${key}=${value}`;
          } else {
            missing.push(key);
          }
        }
      } catch {
        missing.push(...config.localStorage);
      }
    }

    if (config.authorization && authHeader) {
      const token = authHeader.replace(/^bearer\s+/i, "").trim();
      if (token) {
        captured.push("Authorization header");
        credential = config.mode === "bare" ? token : `bearer=${token}`;
      } else {
        missing.push("Authorization header");
      }
    }

    // Named-cookie providers need ALL their cookies — a partial capture
    // (e.g. claude sessionKey missing but cf_clearance present) is unusable.
    if (config.cookies?.length && missing.length > 0) {
      return NextResponse.json(
        {
          error: "not_logged_in",
          message: `Missing ${missing.join(", ")} for ${config.label.replace("Capture from ", "")}. Log in to ${origin} in the opened tab, then press Capture again.`,
          missing,
        },
        { status: 401 },
      );
    }

    if (!credential) {
      return NextResponse.json(
        {
          error: "not_logged_in",
          message: `No session found for ${config.label.replace("Capture from ", "")}. Log in to ${origin} in the opened tab, then press Capture again.`,
          missing,
        },
        { status: 401 },
      );
    }

    return NextResponse.json({ credential, captured, missing, provider, cdpUpSinceMs: getCdpUpSince() });
  } catch (err) {
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      return NextResponse.json({ error: "Capture timed out — is the browser window responsive?" }, { status: 504 });
    }
    return NextResponse.json(
      { error: "capture_failed", message: err?.message || "Failed to capture session" },
      { status: 500 },
    );
  } finally {
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {}); // CDP disconnect, not browser quit
  }
}
