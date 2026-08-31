/**
 * Unit tests for the Runway ML text-to-video adapter (verified gen4.5 contract).
 *
 * Contract (official OpenAPI, docs.dev.runwayml.com/openapi.json):
 *   POST /v1/text_to_video  ·  gen4.5 requires model/promptText/ratio/duration
 *   ratio ∈ {1280:720, 720:1280}  ·  duration ∈ 2..10  ·  NO promptImage for T2V
 *
 * Covers: endpoint, request body (ratio/duration validation, promptImage always
 * omitted), submit task-id capture, queued/processing polling, completed
 * normalization, failed/cancelled/404, timeout, malformed/missing task/missing
 * output. Fetch is mocked; polling timers are faked so the loop completes fast.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { POLL_INTERVAL_MS, POLL_TIMEOUT_MS } from "../../open-sse/handlers/imageProviders/_base.js";
import runwayml from "../../open-sse/handlers/videoProviders/runwayml.js";

const originalFetch = global.fetch;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const HEADERS = { Authorization: "Bearer test-key" };

describe("runwayml video adapter (gen4.5 T2V contract)", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
    vi.useFakeTimers();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("submits to the dedicated /v1/text_to_video endpoint (never image_to_video)", () => {
    expect(runwayml.buildUrl()).toContain("/text_to_video");
    expect(runwayml.buildUrl()).not.toContain("/image_to_video");
  });

  it("builds the gen4.5 text-only payload and never sends promptImage", () => {
    const body = runwayml.buildBody("gen4.5", { prompt: "a city at sunset" });
    expect(body).toEqual({ model: "gen4.5", promptText: "a city at sunset", ratio: "1280:720", duration: 5 });
    expect(body.promptImage).toBeUndefined();
  });

  it("omits promptImage even when an image input is supplied (text-only contract)", () => {
    const body = runwayml.buildBody("gen4.5", { prompt: "x", image: "https://cdn/i.png" });
    expect(body.promptImage).toBeUndefined();
    expect(body).not.toHaveProperty("promptImage");
  });

  it("accepts the two supported Gen-4.5 ratios and maps aspect hints", () => {
    expect(runwayml.buildBody("gen4.5", { prompt: "x", ratio: "720:1280" }).ratio).toBe("720:1280");
    expect(runwayml.buildBody("gen4.5", { prompt: "x", ratio: "16:9" }).ratio).toBe("1280:720");
    expect(runwayml.buildBody("gen4.5", { prompt: "x", ratio: "9:16" }).ratio).toBe("720:1280");
    expect(runwayml.buildBody("gen4.5", { prompt: "x", size: "auto" }).ratio).toBe("1280:720");
    expect(runwayml.buildBody("gen4.5", { prompt: "x" }).ratio).toBe("1280:720"); // default
  });

  it("rejects unsupported ratios instead of sending them upstream", () => {
    expect(() => runwayml.buildBody("gen4.5", { prompt: "x", ratio: "1:1" })).toThrow(/unsupported ratio/);
    expect(() => runwayml.buildBody("gen4.5", { prompt: "x", ratio: "4:3" })).toThrow(/unsupported ratio/);
    expect(() => runwayml.buildBody("gen4.5", { prompt: "x", size: "1024x1024" })).toThrow(/unsupported ratio/);
    expect(() => runwayml.buildBody("gen4.5", { prompt: "x", size: "800x600" })).toThrow(/unsupported ratio/);
  });

  it("validates duration against the Gen-4.5 2..10s range", () => {
    expect(runwayml.buildBody("gen4.5", { prompt: "x" }).duration).toBe(5); // default
    expect(runwayml.buildBody("gen4.5", { prompt: "x", duration: 2 }).duration).toBe(2);
    expect(runwayml.buildBody("gen4.5", { prompt: "x", duration: 10 }).duration).toBe(10);
    expect(() => runwayml.buildBody("gen4.5", { prompt: "x", duration: 1 })).toThrow(/unsupported duration/);
    expect(() => runwayml.buildBody("gen4.5", { prompt: "x", duration: 11 })).toThrow(/unsupported duration/);
    expect(() => runwayml.buildBody("gen4.5", { prompt: "x", duration: 2.5 })).toThrow(/unsupported duration/);
    expect(() => runwayml.buildBody("gen4.5", { prompt: "x", duration: -3 })).toThrow(/unsupported duration/);
  });

  it("passes an optional seed through", () => {
    expect(runwayml.buildBody("gen4.5", { prompt: "x", seed: 12345 }).seed).toBe(12345);
    expect(runwayml.buildBody("gen4.5", { prompt: "x" }).seed).toBeUndefined();
  });

  it("throws when the submit response carries no task id", async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({}));
    await expect(runwayml.parseResponse(jsonResponse({}), { headers: HEADERS })).rejects.toThrow(/no task id/);
  });

  it("throws when the submit response is malformed JSON", async () => {
    const bad = new Response("not json", { status: 200, headers: { "Content-Type": "application/json" } });
    await expect(runwayml.parseResponse(bad, { headers: HEADERS })).rejects.toThrow();
  });

  it("polls through queued/processing → SUCCEEDED and normalizes output", async () => {
    global.fetch
      .mockResolvedValueOnce(jsonResponse({ status: "PROCESSING" }))
      .mockResolvedValueOnce(jsonResponse({ status: "SUCCEEDED", output: ["https://cdn.example/result.mp4"], cost: { credits: 12 } }));

    const promise = runwayml.parseResponse(jsonResponse({ id: "task-1" }), { headers: HEADERS });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);

    const result = await promise;
    const normalized = runwayml.normalize(result);
    expect(normalized.created).toEqual(expect.any(Number));
    expect(normalized.data).toEqual([{ url: "https://cdn.example/result.mp4" }]);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/tasks/task-1"),
      expect.objectContaining({ headers: HEADERS })
    );
  });

  it("throws on SUCCEEDED with an empty/missing output array", async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ status: "SUCCEEDED", output: [] }));
    const promise = runwayml.parseResponse(jsonResponse({ id: "task-6" }), { headers: HEADERS }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/no output/);
  });

  it("normalizes string/object output shapes too", () => {
    expect(runwayml.normalize({ output: "https://cdn/x.mp4" }).data).toEqual([{ url: "https://cdn/x.mp4" }]);
    expect(runwayml.normalize({ output: { url: "https://cdn/y.mp4" } }).data).toEqual([{ url: "https://cdn/y.mp4" }]);
    expect(runwayml.normalize({}).data).toEqual([]);
  });

  it("throws on a failed task (HTTP 200 + FAILED) surfacing the provider reason", async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ status: "FAILED", failure: "content moderation" }));
    const promise = runwayml.parseResponse(jsonResponse({ id: "task-2" }), { headers: HEADERS }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("content moderation");
  });

  it("throws on a cancelled task (HTTP 200 + CANCELLED)", async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ status: "CANCELLED", failureCode: "task_cancelled" }));
    const promise = runwayml.parseResponse(jsonResponse({ id: "task-3" }), { headers: HEADERS }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/task_cancelled/);
  });

  it("maps a 404 poll response to task-deleted/cancelled", async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({}, 404));
    const promise = runwayml.parseResponse(jsonResponse({ id: "task-7" }), { headers: HEADERS }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/cancelled or no longer exists/);
  });

  it("throws on an unexpected poll HTTP status", async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({}, 500));
    const promise = runwayml.parseResponse(jsonResponse({ id: "task-4" }), { headers: HEADERS }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/Runway status 500/);
  });

  it("throws when polling times out", async () => {
    global.fetch.mockImplementation(() => Promise.resolve(jsonResponse({ status: "PROCESSING" })));
    const promise = runwayml.parseResponse(jsonResponse({ id: "task-5" }), { headers: HEADERS }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS + POLL_INTERVAL_MS * 4);
    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/polling timeout/);
  });
});