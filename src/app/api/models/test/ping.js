import { getApiKeys } from "@/lib/localDb";
import { UPDATER_CONFIG } from "@/shared/constants/config";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import REGISTRY from "open-sse/providers/registry/index.js";

const CLI_TOKEN_SALT = "9r-cli-auth";

// Probe caps. Plain HTTP providers answer in a second or two, so 15s is a
// generous bound. Browser-backed (webCookie) providers drive a real browser
// page — navigation, model picker and response capture routinely take 15-60s+,
// and a probe that queues behind another in-flight turn needs even more. The
// old flat 15s cap aborted them mid-turn with a raw "The operation was aborted
// due to timeout" DOMException, so they get a 90s budget (the zai browser
// transport itself allows up to 150s per turn).
const TEST_TIMEOUT_MS = 15000;
const BROWSER_TEST_TIMEOUT_MS = 90000;

// webCookie providers drive a real browser page; category lives on the
// REGISTRY entry (PROVIDERS is built from entry.transport and drops it).
const BROWSER_BACKED_PROVIDERS = new Set(
  REGISTRY.filter((e) => e.category === "webCookie").map((e) => e.id)
);

function isBrowserBackedProvider(model) {
  const providerId = String(model || "").split("/")[0];
  return BROWSER_BACKED_PROVIDERS.has(providerId);
}

function probeTimeoutMs(model) {
  return isBrowserBackedProvider(model) ? BROWSER_TEST_TIMEOUT_MS : TEST_TIMEOUT_MS;
}

// fetch + AbortSignal.timeout, with the abort mapped to an actionable message.
// When AbortSignal.timeout fires mid-request, this Node/undici version rejects
// with a TimeoutError whose raw message is the unhelpful "The operation was
// aborted due to timeout" — that is what leaked to the dashboard before.
async function fetchWithProbeTimeout(url, init, model) {
  const timeoutMs = probeTimeoutMs(model);
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err?.name === "AbortError" || err?.name === "TimeoutError") {
      const hint = isBrowserBackedProvider(model)
        ? " (browser transport — navigation, model picker and CAPTCHA can be slow)"
        : "";
      throw new Error(`Test timed out after ${Math.round(timeoutMs / 1000)}s${hint}`);
    }
    throw err;
  }
}

function createSilentWavFile() {
  const sampleRate = 16000;
  const channels = 1;
  const bitsPerSample = 16;
  const durationMs = 250;
  const sampleCount = Math.max(1, Math.floor((sampleRate * durationMs) / 1000));
  const dataSize = sampleCount * channels * (bitsPerSample / 8);
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeAscii = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * (bitsPerSample / 8), true);
  view.setUint16(32, channels * (bitsPerSample / 8), true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);

  return new Blob([buffer], { type: "audio/wav" });
}

async function getInternalHeaders() {
  let apiKey = null;
  try {
    const keys = await getApiKeys();
    apiKey = keys.find((k) => k.isActive !== false)?.key || null;
  } catch {}

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  headers["x-9r-cli-token"] = await getConsistentMachineId(CLI_TOKEN_SALT);
  return headers;
}

export async function pingModelByKind(model, kind, baseUrl = `http://127.0.0.1:${process.env.PORT || UPDATER_CONFIG.appPort}`) {
  const headers = await getInternalHeaders();
  const start = Date.now();

  if (kind === "embedding") {
    const res = await fetchWithProbeTimeout(`${baseUrl}/api/v1/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, input: "test" }),
    }, model);
    const latencyMs = Date.now() - start;
    const rawText = await res.text().catch(() => "");
    let parsed = null;
    try { parsed = rawText ? JSON.parse(rawText) : null; } catch {}

    if (!res.ok) {
      const detail = parsed?.error?.message || parsed?.error || rawText;
      return { ok: false, latencyMs, error: `HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 240)}` : ""}`, status: res.status };
    }
    const hasEmbedding = Array.isArray(parsed?.data) && parsed.data.length > 0 && Array.isArray(parsed.data[0]?.embedding);
    if (!hasEmbedding) {
      return { ok: false, latencyMs, status: res.status, error: "Provider returned no embedding data" };
    }
    return { ok: true, latencyMs, error: null, status: res.status };
  }

  if (kind === "image") {
    const res = await fetchWithProbeTimeout(`${baseUrl}/api/v1/images/generations`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, prompt: "test" }),
    }, model);
    const latencyMs = Date.now() - start;
    const rawText = await res.text().catch(() => "");
    let parsed = null;
    try { parsed = rawText ? JSON.parse(rawText) : null; } catch {}

    if (!res.ok) {
      const detail = parsed?.error?.message || parsed?.msg || parsed?.message || parsed?.error || rawText;
      return { ok: false, latencyMs, error: `HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 240)}` : ""}`, status: res.status };
    }

    const hasImages = Array.isArray(parsed?.data) && parsed.data.length > 0;
    if (!hasImages) {
      return { ok: false, latencyMs, status: res.status, error: "Provider returned no image data for this model" };
    }
    return { ok: true, latencyMs, error: null, status: res.status };
  }

  if (kind === "stt") {
    const form = new FormData();
    const sampleAudio = createSilentWavFile();
    form.append("file", sampleAudio, "test.wav");
    form.append("model", model);

    const res = await fetchWithProbeTimeout(`${baseUrl}/api/v1/audio/transcriptions`, {
      method: "POST",
      headers: Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== "content-type")),
      body: form,
    }, model);
    const latencyMs = Date.now() - start;
    const rawText = await res.text().catch(() => "");
    let parsed = null;
    try { parsed = rawText ? JSON.parse(rawText) : null; } catch {}

    if (!res.ok) {
      const detail = parsed?.error?.message || parsed?.msg || parsed?.message || parsed?.error || rawText;
      return { ok: false, latencyMs, error: `HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 240)}` : ""}`, status: res.status };
    }

    const text = typeof parsed?.text === "string" ? parsed.text : "";
    if (!text.trim()) {
      return { ok: false, latencyMs, status: res.status, error: "Provider returned no transcription text for this model" };
    }
    return { ok: true, latencyMs, error: null, status: res.status };
  }

  const res = await fetchWithProbeTimeout(`${baseUrl}/api/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      // The probe is a connectivity check — never run reasoning. Thinking models
      // (e.g. GLM-5.2 at max effort) can deliberate for minutes, and the browser
      // transport waits for the full completion before responding, so without
      // this the probe routinely exceeded any reasonable timeout.
      enable_thinking: false,
      // Claude-on-Copilot returns empty choices at max_tokens:1 (budget is spent
      // before a content token emits), so a 1-token probe yields a false negative.
      max_tokens: 16,
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    }),
  }, model);
  const latencyMs = Date.now() - start;

  const rawText = await res.text().catch(() => "");
  let parsed = null;
  try { parsed = rawText ? JSON.parse(rawText) : null; } catch {}

  if (!res.ok) {
    const detail = parsed?.error?.message || parsed?.msg || parsed?.message || parsed?.error || rawText;
    return { ok: false, latencyMs, error: `HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 240)}` : ""}`, status: res.status };
  }

  const providerStatus = parsed?.status;
  const providerMsg = parsed?.msg || parsed?.message;
  const hasProviderErrorStatus = providerStatus !== undefined
    && providerStatus !== null
    && String(providerStatus) !== "200"
    && String(providerStatus) !== "0";
  if (hasProviderErrorStatus && providerMsg) {
    return {
      ok: false,
      latencyMs,
      status: res.status,
      error: `Provider status ${providerStatus}: ${String(providerMsg).slice(0, 240)}`,
    };
  }

  if (parsed?.error) {
    const providerError = parsed?.error?.message || parsed?.error || "Provider returned an error";
    return {
      ok: false,
      latencyMs,
      status: res.status,
      error: String(providerError).slice(0, 240),
    };
  }

  // Some providers (e.g. Cline/ClinePass) wrap the OpenAI completion inside a
  // `{ data: {...} }` envelope for non-streaming responses. Unwrap it so the
  // choices check below finds them.
  const choicesSource = (Array.isArray(parsed?.choices) && parsed.choices.length > 0)
    ? parsed
    : (parsed?.data && typeof parsed.data === "object" ? parsed.data : parsed);

  const hasChoices = Array.isArray(choicesSource?.choices) && choicesSource.choices.length > 0;
  if (!hasChoices) {
    return {
      ok: false,
      latencyMs,
      status: res.status,
      error: "Provider returned no completion choices for this model",
    };
  }

  // Accept reasoning-only responses: some models (e.g. thinking models on a tiny
  // max_tokens probe) spend the whole budget on reasoning_content before emitting
  // any visible content token. The model is reachable and responding — that's a pass.
  return { ok: true, latencyMs, error: null, status: res.status };
}
