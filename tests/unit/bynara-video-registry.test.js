/**
 * Registry + dashboard + core-gate tests for Bynara Text-to-Video.
 *
 * Verifies model-level gating: agnes-video-v2.0 is statically `kind: video`;
 * Bynara LLM models never become T2V-eligible; bynara advertises the video
 * service and appears under getProvidersByKind("video"); the adapter is
 * registered; and the core routes agnes-video-v2.0 but rejects LLM models.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AI_PROVIDERS, getProvidersByKind } from "@/shared/constants/providers";
import { getModelType } from "open-sse/config/providerModels.js";
import { getVideoAdapter } from "open-sse/handlers/videoProviders/index.js";
import { handleVideoGenerationCore } from "open-sse/handlers/videoGenerationCore.js";
import { POLL_INTERVAL_MS } from "open-sse/handlers/imageProviders/_base.js";

const originalFetch = global.fetch;
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("bynara T2V registry + dashboard wiring", () => {
  it("classifies agnes-video-v2.0 as kind=video and Bynara LLM models as not video", () => {
    expect(getModelType("bynara", "agnes-video-v2.0")).toBe("video");
    expect(getModelType("bynara", "agnes-2.5-flash")).not.toBe("video");
    expect(getModelType("bynara", "deepseek-v4-flash")).not.toBe("video");
  });

  it("Bynara advertises video (and keeps image + llm) with the media-host videoConfig", () => {
    expect(AI_PROVIDERS.bynara.serviceKinds).toContain("video");
    expect(AI_PROVIDERS.bynara.serviceKinds).toContain("image");
    expect(AI_PROVIDERS.bynara.serviceKinds).toContain("llm");
    expect(AI_PROVIDERS.bynara.videoConfig?.baseUrl).toBe("https://api-images.bynara.id/v1/videos");
  });

  it("Bynara appears under getProvidersByKind('video')", () => {
    expect(getProvidersByKind("video").map((p) => p.id)).toContain("bynara");
  });

  it("registers the bynara video adapter", () => {
    expect(getVideoAdapter("bynara")).toBeTruthy();
    expect(getVideoAdapter("runwayml")).toBeTruthy();
  });
});

describe("handleVideoGenerationCore — bynara gate", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
    vi.useFakeTimers();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("rejects a Bynara LLM model from the T2V pipeline", async () => {
    const result = await handleVideoGenerationCore({
      body: { model: "bynara/agnes-2.5-flash", prompt: "x" },
      modelInfo: { provider: "bynara", model: "agnes-2.5-flash" },
      credentials: { apiKey: "k" },
      log: null,
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toContain("does not support video generation");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects invalid Bynara duration before contacting the provider", async () => {
    const result = await handleVideoGenerationCore({
      body: { model: "bynara/agnes-video-v2.0", prompt: "x", duration: 2 },
      modelInfo: { provider: "bynara", model: "agnes-video-v2.0" },
      credentials: { apiKey: "k" },
      log: null,
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/duration/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("routes agnes-video-v2.0 through submit+poll and normalizes the result", async () => {
    global.fetch
      .mockResolvedValueOnce(jsonResponse({ id: "t1", status: "pending", created: 123 })) // submit
      .mockResolvedValueOnce(jsonResponse({ id: "t1", status: "succeeded", url: "/v1/videos/t1/download", created: 123 })); // poll
    const promise = handleVideoGenerationCore({
      body: { model: "bynara/agnes-video-v2.0", prompt: "a red ball rolling" },
      modelInfo: { provider: "bynara", model: "agnes-video-v2.0" },
      credentials: { apiKey: "k" },
      log: null,
    });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    const result = await promise;
    expect(result.success).toBe(true);
    const body = await result.response.json();
    expect(body.data).toEqual([{ url: "https://api-images.bynara.id/v1/videos/t1/download" }]);
  });
});