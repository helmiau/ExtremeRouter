/**
 * Unit tests for handleVideoGenerationCore (video generation orchestrator core).
 *
 * Covers: prompt validation, unsupported provider, model-level T2V gate (I2V-only
 * models like gen4_turbo rejected), unsupported ratio/duration → 400, success
 * normalization, and provider error propagation. Polling is faked so the inline
 * loop completes instantly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleVideoGenerationCore } from "../../open-sse/handlers/videoGenerationCore.js";
import { POLL_INTERVAL_MS } from "../../open-sse/handlers/imageProviders/_base.js";

const originalFetch = global.fetch;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const RUNWAY_T2V = { provider: "runwayml", model: "gen4.5" };

describe("handleVideoGenerationCore", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
    vi.useFakeTimers();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("rejects a missing prompt", async () => {
    const result = await handleVideoGenerationCore({ body: { model: "runwayml/gen4.5" }, modelInfo: RUNWAY_T2V });
    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toContain("Missing required field: prompt");
  });

  it("rejects a provider with no video adapter", async () => {
    const result = await handleVideoGenerationCore({
      body: { prompt: "x" },
      modelInfo: { provider: "openai", model: "dall-e-3" },
      credentials: { apiKey: "k" },
      log: null,
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toContain("does not support video generation");
  });

  it("rejects an I2V-only model (gen4_turbo) from the T2V pipeline", async () => {
    // gen4_turbo is a kind=image (Image→Video) model, reachable via the image
    // pipeline only — it must NEVER be T2V-eligible.
    const result = await handleVideoGenerationCore({
      body: { prompt: "x" },
      modelInfo: { provider: "runwayml", model: "gen4_turbo" },
      credentials: { apiKey: "k" },
      log: null,
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toContain("does not support video generation");
  });

  it("rejects an unsupported ratio as a 400 invalid request (before submitting a job)", async () => {
    const result = await handleVideoGenerationCore({
      body: { model: "runwayml/gen4.5", prompt: "x", ratio: "1:1" },
      modelInfo: RUNWAY_T2V,
      credentials: { apiKey: "k" },
      log: null,
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/unsupported ratio/);
    expect(global.fetch).not.toHaveBeenCalled(); // provider was never contacted
  });

  it("rejects an unsupported duration as a 400 invalid request (before submitting a job)", async () => {
    const result = await handleVideoGenerationCore({
      body: { model: "runwayml/gen4.5", prompt: "x", duration: 20 },
      modelInfo: RUNWAY_T2V,
      credentials: { apiKey: "k" },
      log: null,
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/unsupported duration/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("submits, polls, and normalizes a successful gen4.5 T2V result to {created, data:[{url}]}", async () => {
    global.fetch
      .mockResolvedValueOnce(jsonResponse({ id: "task-1" })) // submit → {id, estimatedCost}
      .mockResolvedValueOnce(jsonResponse({ status: "SUCCEEDED", output: ["https://cdn.example/v.mp4"] })); // poll

    const promise = handleVideoGenerationCore({
      body: { model: "runwayml/gen4.5", prompt: "aerial city at sunset" },
      modelInfo: RUNWAY_T2V,
      credentials: { apiKey: "k" },
      log: null,
    });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);

    const result = await promise;
    expect(result.success).toBe(true);
    const body = await result.response.json();
    expect(body.data).toEqual([{ url: "https://cdn.example/v.mp4" }]);
    expect(body.created).toEqual(expect.any(Number));
  });

  it("propagates a provider HTTP error without poll attempts", async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ error: "boom" }, 500));
    const result = await handleVideoGenerationCore({
      body: { prompt: "x" },
      modelInfo: RUNWAY_T2V,
      credentials: { apiKey: "k" },
      log: null,
    });
    expect(result.success).toBe(false);
    expect(result.status).toBe(500);
  });
});