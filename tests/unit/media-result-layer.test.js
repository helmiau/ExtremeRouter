/**
 * Unit tests for the provider-agnostic media-result delivery layer.
 *
 * A provider artifact that needs authenticated download must never be handed to the
 * client as the raw provider URL. The core registers it under an opaque
 * ExtremeRouter URL (/api/v1/media/results/<id>), and retrieval resolves the provider
 * credential SERVER-side through the SSRF-hardened downloader.
 *
 * Covers: opaque-id registration / expiry / lifecycle; resolveMediaResult 404/410/502;
 * core returns an ExtremeRouter URL (not the provider URL) for authenticated providers
 * while keeping raw URLs for public providers; server-side Authorization header
 * attachment; SSRF guards stay active on the retrieval fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

import { lookup } from "node:dns/promises";
import { POLL_INTERVAL_MS } from "../../open-sse/handlers/imageProviders/_base.js";
import { handleVideoGenerationCore } from "../../open-sse/handlers/videoGenerationCore.js";
import {
  registerMediaResult,
  getMediaResult,
  deleteMediaResult,
  clearMediaResults,
  sizeMediaResults,
  mediaResultPath,
  resolveMediaResult,
} from "../../open-sse/services/mediaResultStore.js";

const originalFetch = global.fetch;
const PUBLIC_IP = [{ address: "203.0.113.55", family: 4 }];

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("mediaResultStore registration (opaque ids)", () => {
  beforeEach(() => clearMediaResults());
  afterEach(() => clearMediaResults());

  it("issues an opaque random UUID that is not the provider task id, and never repeats", () => {
    const { id: a } = registerMediaResult({ provider: "bynara", source: { url: "https://x/v.mp4" } });
    const { id: b } = registerMediaResult({ provider: "bynara", source: { url: "https://x/v.mp4" } });
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe("t1"); // never the provider/upstream task id
    expect(a).not.toBe(b);    // opaque — not guessable from input
  });

  it("stores the record with expiry, and supports get/delete/size/clear", () => {
    const { id, expiresAt } = registerMediaResult({ provider: "bynara", source: { url: "https://x/v.mp4" }, connectionId: "c1" });
    const rec = getMediaResult(id);
    expect(rec.provider).toBe("bynara");
    expect(rec.connectionId).toBe("c1");
    expect(rec.source.url).toBe("https://x/v.mp4");
    expect(typeof expiresAt).toBe("number");
    expect(sizeMediaResults()).toBe(1);
    expect(deleteMediaResult(id)).toBe(true);
    expect(sizeMediaResults()).toBe(0);
    expect(mediaResultPath(id)).toBe(`/api/v1/media/results/${id}`);
  });
});

describe("resolveMediaResult (server-side retrieval)", () => {
  beforeEach(() => {
    clearMediaResults();
    global.fetch = vi.fn();
    vi.mocked(lookup).mockReset();
    vi.mocked(lookup).mockResolvedValue(PUBLIC_IP);
  });
  afterEach(() => {
    clearMediaResults();
    global.fetch = originalFetch;
  });

  it("404s for an unknown id before any network I/O", async () => {
    const r = await resolveMediaResult("deadbeef");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("410s an expired result (and drops it from the store)", async () => {
    const { id } = registerMediaResult({ provider: "bynara", source: { url: "https://x/v.mp4" } });
    const r = await resolveMediaResult(id, { nowMs: Date.now() + 31 * 60 * 1000 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(410);
    expect(getMediaResult(id)).toBeNull();
  });

  it("502s when the result has no source artifact", async () => {
    const { id } = registerMediaResult({ provider: "bynara", source: { kind: "remote-url", url: "" } });
    const r = await resolveMediaResult(id);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(502);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("502s on an unreachable artifact — the SSRF guard is NOT bypassed for provider 'trusted' URLs", async () => {
    const { id } = registerMediaResult({ provider: "bynara", source: { url: "https://127.0.0.1/v.mp4" } });
    const r = await resolveMediaResult(id);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(502);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("resolves the provider credential server-side and attaches it as a Bearer header", async () => {
    const { id } = registerMediaResult({ provider: "bynara", source: { url: "https://public.example/v.mp4" }, connectionId: "c1" });
    const bytes = [0x66, 0x74, 0x79, 0x70]; // "ftyp"
    global.fetch.mockResolvedValueOnce(new Response(new Uint8Array(bytes), {
      status: 200,
      headers: { "Content-Type": "video/mp4" },
    }));
    const getCredentials = vi.fn().mockResolvedValue({ apiKey: "sk-nry-secret", connectionId: "c1" });
    const r = await resolveMediaResult(id, { getCredentials });
    expect(r.ok).toBe(true);
    expect(r.mimeType).toBe("video/mp4");
    expect(Buffer.from(r.buffer)).toEqual(Buffer.from(bytes));
    // the credential is resolved for the result's own connection, never caller-supplied
    expect(getCredentials).toHaveBeenCalledWith("bynara", null, null, { preferredConnectionId: "c1" });
    expect(global.fetch).toHaveBeenCalledWith(
      "https://public.example/v.mp4",
      expect.objectContaining({ headers: { Authorization: "Bearer sk-nry-secret" } })
    );
  });
});

describe("videoGenerationCore → media-result URL (authenticated providers)", () => {
  beforeEach(() => {
    clearMediaResults();
    global.fetch = vi.fn();
    vi.useFakeTimers();
  });
  afterEach(() => {
    clearMediaResults();
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("bynara: swaps the provider download URL for an ExtremeRouter media-result URL", async () => {
    // Bynara result download URLs require the provider API key — the registry
    // path must expose only an ExtremeRouter-owned URL, never the raw provider URL.
    global.fetch
      .mockResolvedValueOnce(jsonResponse({ id: "t1", status: "pending", created: 1 })) // submit
      .mockResolvedValueOnce(jsonResponse({ id: "t1", status: "succeeded", url: "/v1/videos/t1/download" })); // poll
    const before = sizeMediaResults();
    const promise = handleVideoGenerationCore({
      body: { model: "bynara/agnes-video-v2.0", prompt: "a cat" },
      modelInfo: { provider: "bynara", model: "agnes-video-v2.0" },
      credentials: { apiKey: "sk-nry", connectionId: "c1" },
      mediaResultOrigin: "http://localhost:20128",
      log: null,
    });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    const result = await promise;
    expect(result.success).toBe(true);
    const body = await result.response.json();
    const url = body.data[0].url;
    expect(url).toMatch(/^http:\/\/localhost:20128\/api\/v1\/media\/results\/[0-9a-f-]{36}$/);
    expect(url).not.toContain("router.bynara.id");
    // the provider artifact is registered and fetchable server-side
    expect(sizeMediaResults()).toBe(before + 1);
    const id = url.split("/").pop();
    expect(getMediaResult(id).source.url).toBe("https://router.bynara.id/v1/videos/t1/download");
  });

  it("keeps the raw provider URL when the provider does NOT need authenticated download (runway)", async () => {
    // Genericity: the registry treatment applies to authenticated providers only;
    // public artifact URLs (runway) are still returned verbatim.
    global.fetch
      .mockResolvedValueOnce(jsonResponse({ id: "task-1" })) // submit
      .mockResolvedValueOnce(jsonResponse({ status: "SUCCEEDED", output: ["https://cdn.example/v.mp4"] })); // poll
    const before = sizeMediaResults();
    const promise = handleVideoGenerationCore({
      body: { model: "runwayml/gen4.5", prompt: "x" },
      modelInfo: { provider: "runwayml", model: "gen4.5" },
      credentials: { apiKey: "k" },
      mediaResultOrigin: "http://localhost:20128",
      log: null,
    });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    const result = await promise;
    const body = await result.response.json();
    expect(body.data[0].url).toBe("https://cdn.example/v.mp4");
    expect(sizeMediaResults()).toBe(before); // not registered
  });
});