/**
 * xAI Grok Imagine Video 1.5 text-to-video adapter tests.
 * Contract source: https://docs.x.ai/openapi.json.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { POLL_INTERVAL_MS, POLL_TIMEOUT_MS } from "../../open-sse/handlers/imageProviders/_base.js";
import xai from "../../open-sse/handlers/videoProviders/xai.js";

const originalFetch = global.fetch;
const HEADERS = { Authorization: "Bearer xai-test" };

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("xAI grok-imagine-video-1.5 T2V adapter", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
    vi.useFakeTimers();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("uses the documented endpoint and bearer authentication", () => {
    expect(xai.buildUrl()).toBe("https://api.x.ai/v1/videos/generations");
    expect(xai.buildHeaders({ apiKey: "k" })).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer k",
    });
  });

  it("builds the text-only payload with documented defaults", () => {
    expect(xai.buildBody("grok-imagine-video-1.5", { prompt: "a city at sunset" })).toEqual({
      model: "grok-imagine-video-1.5",
      prompt: "a city at sunset",
      duration: 8,
    });
  });

  it("passes verified duration, aspect ratio, resolution, and seconds alias", () => {
    expect(xai.buildBody("grok-imagine-video-1.5", {
      prompt: "x",
      seconds: "12",
      aspect_ratio: "9:16",
      resolution: "1080p",
    })).toEqual({
      model: "grok-imagine-video-1.5",
      prompt: "x",
      duration: 12,
      aspect_ratio: "9:16",
      resolution: "1080p",
    });
  });

  it("rejects unsupported models, references, and optional values", () => {
    expect(() => xai.buildBody("grok-imagine-video", { prompt: "x" })).toThrow(/only supports/);
    expect(() => xai.buildBody("grok-imagine-video-1.5", { prompt: "x", image: { url: "https://x/i.png" } })).toThrow(/image or reference/);
    expect(() => xai.buildBody("grok-imagine-video-1.5", { prompt: "x", duration: 16 })).toThrow(/duration/);
    expect(() => xai.buildBody("grok-imagine-video-1.5", { prompt: "x", aspect_ratio: "21:9" })).toThrow(/aspect_ratio/);
    expect(() => xai.buildBody("grok-imagine-video-1.5", { prompt: "x", resolution: "4k" })).toThrow(/resolution/);
  });

  it("requires a non-empty prompt", () => {
    expect(() => xai.buildBody("grok-imagine-video-1.5", {})).toThrow(/prompt/);
    expect(() => xai.buildBody("grok-imagine-video-1.5", { prompt: " " })).toThrow(/prompt/);
  });

  it("polls request_id until done and normalizes the temporary video URL", async () => {
    global.fetch
      .mockResolvedValueOnce(jsonResponse({ status: "pending", progress: 35 }, 202))
      .mockResolvedValueOnce(jsonResponse({
        status: "done",
        model: "grok-imagine-video-1.5",
        video: { url: "https://vidgen.x.ai/video.mp4", duration: 8, respect_moderation: true },
      }));

    const promise = xai.parseResponse(jsonResponse({ request_id: "req/1" }), { headers: HEADERS });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    const result = await promise;

    expect(result.video.url).toBe("https://vidgen.x.ai/video.mp4");
    expect(xai.normalize(result).data).toEqual([{ url: "https://vidgen.x.ai/video.mp4" }]);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.x.ai/v1/videos/req%2F1",
      expect.objectContaining({ headers: HEADERS })
    );
  });

  it("handles missing identifiers, terminal failures, 404, and timeout", async () => {
    await expect(xai.parseResponse(jsonResponse({}), { headers: HEADERS })).rejects.toThrow(/request_id/);

    global.fetch.mockResolvedValueOnce(jsonResponse({
      status: "failed",
      error: { code: "invalid_argument", message: "prompt rejected" },
    }));
    const failed = xai.parseResponse(jsonResponse({ request_id: "failed" }), { headers: HEADERS }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    expect((await failed).message).toContain("prompt rejected");

    global.fetch.mockResolvedValueOnce(jsonResponse({}, 404));
    const missing = xai.parseResponse(jsonResponse({ request_id: "missing" }), { headers: HEADERS }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    expect((await missing).message).toMatch(/not found|expired/);

    global.fetch.mockImplementation(() => Promise.resolve(jsonResponse({ status: "pending" }, 202)));
    const timeout = xai.parseResponse(jsonResponse({ request_id: "slow" }), { headers: HEADERS }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS + POLL_INTERVAL_MS * 3);
    expect((await timeout).message).toMatch(/polling timeout/);
  });
});
