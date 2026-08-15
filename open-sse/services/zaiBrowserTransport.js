// zaiBrowserTransport.js — browser-backed chat for Z.ai (chat.z.ai).
//
// Why this exists: chat.z.ai's v2 completion endpoint (`/api/v2/chat/completions`)
// requires a `captcha_verify_param` proof issued by Aliyun Captcha, bound to a
// real browser fingerprint/session. A plain HTTP request always gets a generic
// 500 "Internal Server Error" (verified live: guest and signed-API paths alike).
// The OmniRoute PR we ported solves this the same way — the browser is the
// DEFAULT transport and the signed HTTP path is only used when the caller
// supplies a proof.
//
// This module drives the real chat.z.ai page with playwright-core:
//   1. a shared browser (installed Chrome/Edge/Chromium; `channel` resolved at
//      launch), one persistent context per session token (localStorage.token),
//   2. per request: navigate fresh → pick the model (throws a clear error when
//      the account cannot select it, e.g. guests are limited to GLM-4.7) →
//      best-effort Deep Think / web-search / tools toggles → type the prompt →
//      click Send → capture the completion SSE body,
//   3. returns the captured upstream body so the executor can reuse its
//      existing SSE parsers (transformZaiStream / collectZaiContent).
//
// Configuration (all optional):
//   ER_ZAI_BROWSER_CHANNEL   e.g. "chrome" | "msedge" | "chromium" (default: auto-try)
//   ER_ZAI_BROWSER_HEADED=1  run visible so a human can solve an interactive CAPTCHA
//   ER_ZAI_BROWSER_TIMEOUT_MS  overall request cap (default 150s)

import { createHash } from "node:crypto";
import { chromium } from "playwright-core";

const ZAI_BASE_URL = "https://chat.z.ai";
const ZAI_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

const NAV_TIMEOUT_MS = 45000;
const MENU_TIMEOUT_MS = 8000;
const INPUT_TIMEOUT_MS = 15000;
const CAPTURE_TIMEOUT_MS = Number(process.env.ER_ZAI_BROWSER_TIMEOUT_MS) || 150000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024; // 16 MB OOM guard

// Installed-channel fallback order; `chromium.launch()` without a channel
// (playwright's own bundled browser) is tried afterwards.
const CHANNELS = process.env.ER_ZAI_BROWSER_CHANNEL
  ? [process.env.ER_ZAI_BROWSER_CHANNEL]
  : ["chrome", "msedge"];

let browserPromise = null;
let sharedBrowser = null;
const contextPool = new Map(); // tokenKey -> { context, page, busy }

// The pooled browser keeps the event loop alive (its child processes). Best-effort
// close on exit so standalone scripts / server restarts do not leak Chrome.
export async function shutdownZaiBrowser() {
  browserPromise = null;
  if (!sharedBrowser) return;
  const browser = sharedBrowser;
  sharedBrowser = null;
  try {
    await browser.close();
  } catch {
    /* already closed */
  }
  contextPool.clear();
}

process.once("exit", () => {
  if (sharedBrowser) {
    sharedBrowser.close().catch(() => {});
    sharedBrowser = null;
  }
});

function abortError() {
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

function withAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); }
    );
  });
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function tokenPoolKey(token) {
  return createHash("sha256").update(String(token || "")).digest("hex").slice(0, 24);
}

// Guest sessions (auto-created accounts, e.g. "guest-1786799164504@guest.com")
// are gated server-side: chat.z.ai only completes GLM-4.7 for them — every
// other model returns a generic HTTP 500, and the picker disables those items.
// Detect them so failures can point the user at the real fix (sign in).
export function isZaiGuestToken(token) {
  const payload = String(token || "").split(".")[1];
  if (!payload) return false;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (decoded?.role === "guest") return true;
    return typeof decoded?.email === "string" && /@guest\.com$/i.test(decoded.email);
  } catch {
    return false;
  }
}

// Human-readable hint appended to model-selection failures.
export function zaiGuestHint(token) {
  return isZaiGuestToken(token)
    ? "This is a guest session — chat.z.ai only allows GLM-4.7 for guests. Sign in at chat.z.ai and re-capture the token."
    : "Sign in to chat.z.ai (the model may require an account), or request a model this account can use.";
}

// Map an API model id to the display name shown in the picker.
export function browserModelName(modelId) {
  const trimmed = String(modelId || "").trim();
  const unprefixed = trimmed.split("/").at(-1) || trimmed;
  const lower = unprefixed.toLowerCase();
  if (lower === "glm-5.2") return "GLM-5.2";
  if (lower === "glm-5v-turbo") return "GLM-5V-Turbo";
  return unprefixed;
}

async function getBrowser() {
  if (browserPromise) return browserPromise;
  browserPromise = (async () => {
    const headless = process.env.ER_ZAI_BROWSER_HEADED !== "1";
    let lastError = null;
    for (const channel of CHANNELS) {
      try {
        const browser = await chromium.launch({
          channel,
          headless,
          args: ["--no-first-run", "--disable-blink-features=AutomationControlled"],
        });
        sharedBrowser = browser;
        return browser;
      } catch (err) {
        lastError = err;
      }
    }
    // Fall back to playwright's own bundled chromium if any (rare installs).
    try {
      const browser = await chromium.launch({ headless, args: ["--no-first-run"] });
      sharedBrowser = browser;
      return browser;
    } catch {
      /* keep the descriptive error below */
    }
    throw new Error(
      `no Chromium-based browser found (tried channels: ${CHANNELS.join(", ")}). ` +
        `Install Chrome or Edge, or set ER_ZAI_BROWSER_CHANNEL. ${lastError?.message || ""}`
    );
  })();
  try {
    return await browserPromise;
  } catch (err) {
    browserPromise = null;
    throw err;
  }
}

async function acquireContext(token) {
  const key = tokenPoolKey(token);
  let entry = contextPool.get(key);
  if (entry) return entry;

  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: ZAI_USER_AGENT,
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    timezoneId: "UTC",
  });
  await context.addInitScript((tok) => {
    try { localStorage.setItem("token", tok); } catch { /* storage blocked */ }
  }, token);

  // Warm the page once so the session + risk fingerprint (Aliyun CAPTCHA
  // cookies like acw_tc / cdn_sec_tc) are established for the context.
  const page = await context.newPage();
  try {
    await page.goto(`${ZAI_BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await wait(2500);
  } catch {
    /* the per-request navigation retries anyway */
  }

  entry = { context, page, key, busy: Promise.resolve() };
  contextPool.set(key, entry);
  return entry;
}

function currentSelectionText(selector) {
  return selector.innerText().then((t) => String(t || "").trim()).catch(() => "");
}

// Pick the requested model in the dropdown. Throws a clear error when the item
// is disabled (guest sessions are limited to GLM-4.7) or missing.
async function selectModel(page, modelName, signal, hint) {
  const selector = page.locator('[aria-label="Select a model"]').first();
  await withAbort(selector.waitFor({ state: "visible", timeout: INPUT_TIMEOUT_MS }), signal);
  const current = await currentSelectionText(selector);
  if (current.toLowerCase().includes(modelName.toLowerCase())) return;

  await withAbort(selector.evaluate((el) => el.click()), signal);
  await wait(900, signal);
  const menu = page.locator('[role="menu"]').filter({ hasText: modelName }).first();
  await withAbort(menu.waitFor({ state: "visible", timeout: MENU_TIMEOUT_MS }), signal);
  const item = menu.locator("button").filter({ hasText: modelName }).first();
  try {
    await withAbort(item.click({ timeout: MENU_TIMEOUT_MS }), signal);
  } catch (err) {
    const detail = String(err?.message || err).slice(0, 200);
    throw new Error(
      `cannot select model "${modelName}" in the chat.z.ai picker (${detail}). ${hint}`
    );
  }
  await page.keyboard.press("Escape").catch(() => {});
  await wait(700, signal);
  const after = await currentSelectionText(selector);
  if (!after.toLowerCase().includes(modelName.toLowerCase())) {
    throw new Error(`model selection did not stick (picker shows "${after || "unknown"}"). ${hint}`);
  }
}

// Best-effort UI toggles. Any failure is logged and ignored — the page
// defaults (Deep Think on, web search off) are acceptable fallbacks.
async function configureToggles(page, { thinking, vlm, capabilities, log }, signal) {
  const deepThinkSupported = Boolean(capabilities?.thinking);
  const webSearchSupported = Boolean(capabilities?.webSearch || capabilities?.vlmWebSearch);
  const toolsSupported = Boolean(capabilities?.vlmTools);

  // Deep Think toggle (data-autothink attribute on 1.1.84).
  try {
    if (deepThinkSupported) {
      const autothink = page.locator("button[data-autothink]").first();
      if (await autothink.count()) {
        const on = (await autothink.getAttribute("data-autothink")) === "true";
        if (on !== thinking.enabled) {
          await withAbort(autothink.click({ timeout: 5000 }), signal);
          await wait(400, signal);
        }
      }
    }
  } catch (err) {
    log?.warn?.("ZAI-WEB", `Deep Think toggle skipped: ${err?.message || err}`);
  }

  // Web search + Tools toggles (aria-label wrappers with data-selected buttons).
  const toggles = [];
  if (webSearchSupported) toggles.push(["Web search", vlm.webSearchEnabled]);
  if (toolsSupported) toggles.push(["Tools", vlm.toolsEnabled]);
  for (const [label, enabled] of toggles) {
    try {
      const wrapper = page.locator(`[aria-label^="${label} "]`).first();
      if (await wrapper.count()) {
        const button = wrapper.locator("button[data-selected]").first();
        if (await button.count()) {
          const on = (await button.getAttribute("data-selected")) === "true";
          if (on !== enabled) {
            await withAbort(button.click({ timeout: 5000 }), signal);
            await wait(400, signal);
          }
        }
      }
    } catch (err) {
      log?.warn?.("ZAI-WEB", `${label} toggle skipped: ${err?.message || err}`);
    }
  }
}

function looksLikeCaptchaOverlay(page) {
  return page
    .locator('iframe[src*="captcha"], iframe[src*="verify"], [id*="captcha"]')
    .first()
    .count()
    .then((n) => n > 0)
    .catch(() => false);
}

async function captureCompletion(page, signal) {
  const responsePromise = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().includes("/api/v2/chat/completions"),
    { timeout: CAPTURE_TIMEOUT_MS }
  );
  const response = await withAbort(responsePromise, signal);
  await withAbort(
    Promise.race([
      response.finished().catch(() => {}),
      wait(CAPTURE_TIMEOUT_MS, signal).then(() => {}),
    ]),
    signal
  );
  const status = response.status();
  const contentType = response.headers()["content-type"] || null;
  let body = Buffer.alloc(0);
  try {
    body = Buffer.from(await response.body().catch(() => Buffer.alloc(0)));
  } catch { /* empty body */ }
  if (body.length > MAX_RESPONSE_BYTES) {
    throw new Error(`Z.ai response exceeded ${MAX_RESPONSE_BYTES} bytes`);
  }
  return { status, contentType, body };
}

/**
 * Drive one chat turn through the real chat.z.ai page.
 * Returns `{ ok: true, status, contentType, body }` for any upstream response
 * (including non-2xx — the executor classifies them), or `{ ok: false, error }`
 * for transport-level failures. Never throws for HTTP-level outcomes.
 */
export async function zaiBrowserChat({ token, modelId, prompt, thinking, vlm, signal, log }) {
  if (!token) return { ok: false, error: "missing session token" };
  const entry = await acquireContext(token);
  const run = entry.busy.then(async () => {
    const { page } = entry;
    try {
      await withAbort(page.goto(`${ZAI_BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }), signal);
      await wait(1800, signal);

      if (await looksLikeCaptchaOverlay(page)) {
        const headlessHint =
          process.env.ER_ZAI_BROWSER_HEADED === "1"
            ? "solve the CAPTCHA in the opened browser window and retry."
            : "set ER_ZAI_BROWSER_HEADED=1, solve the CAPTCHA in the opened browser window, and retry.";
        return { ok: false, error: `chat.z.ai is showing a CAPTCHA challenge — ${headlessHint}` };
      }

      const modelName = browserModelName(modelId);
      await selectModel(page, modelName, signal, zaiGuestHint(token));
      await configureToggles(page, { thinking, vlm, modelId, log }, signal);

      const input = page.locator("#chat-input");
      await withAbort(input.waitFor({ state: "visible", timeout: INPUT_TIMEOUT_MS }), signal);
      await withAbort(input.fill(prompt), signal);
      await wait(700, signal);

      const sendButton = page.locator("#send-message-button");
      let clicked = false;
      try {
        if ((await sendButton.count()) > 0 && (await sendButton.isEnabled().catch(() => false))) {
          await withAbort(sendButton.click({ timeout: 5000 }), signal);
          clicked = true;
        }
      } catch { /* fall back to Enter */ }
      if (!clicked) await withAbort(input.press("Enter"), signal);

      log?.info?.("ZAI-WEB", `browser sent (model=${modelName}, thinking=${thinking.enabled})`);
      return { ok: true, ...(await captureCompletion(page, signal)) };
    } catch (err) {
      if (err?.name === "AbortError") return { ok: false, error: "request aborted" };
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  // Keep the chain alive for the next caller; the error is consumed here.
  entry.busy = run.then(
    () => {},
    () => {}
  );
  return run;
}
