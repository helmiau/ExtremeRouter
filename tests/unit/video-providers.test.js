/**
 * Unit tests for the Runway ML text-to-video adapter (submit + polling).
 *
 * Covers: submit task id capture, queued/processing polling, completed
 * normalization, failed task, polling timeout, malformed submit response,
 * missing task id, missing output URL. Fetch is mocked; polling timers are
 * faked so the inline loop completes without real 1.5s waits.
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

describe("runwayml video adapter", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
    vi.useFakeTimers();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("always submits to the text_to_video endpoint (never image_to_video)", () => {
    expect(runwayml.buildUrl()).toContain("/text_to_video");
    expect(runwayml.buildUrl()).not.toContain("/image_to_video");
    expect(runwayml.buildUrl()).not.toContain("text_to_image");
  });

  it("does not require an image input for pure T2V", () => {
    const body = runwayml.buildBody("gen4_turbo", { prompt: "a city at sunset" });
    expect(body.promptText).toBe("a city at sunset");
    expect(body.model).toBe("gen4_turbo");
    expect(body.promptImage).toBeUndefined();
  });

  it("includes promptImage only when an image input is provided", () => {
    const body = runwayml.buildBody("gen4_turbo", { prompt: "x", image: "https://cdn/image.png" });
    expect(body.promptImage).toBe("https://cdn/image.png");
  });

  it("defaults duration to 5 and honors a valid positive integer", () => {
    expect(runwayml.buildBody("gen4_turbo", { prompt: "x" }).duration).toBe(5);
    expect(runwayml.buildBody("gen4_turbo", { prompt: "x", duration: 7 }).duration).toBe(7);
    expect(runwayml.buildBody("gen4_turbo", { prompt: "x", duration: -3 }).duration).toBe(5);
    expect(runwayml.buildBody("gen4_turbo", { prompt: "x", duration: 2.5 }).duration).toBe(5);
  });

  it("throws when the submit response carries no task id", async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({}));
    await expect(runwayml.parseResponse(jsonResponse({}), { headers: HEADERS })).rejects.toThrow(/no task id/);
  });

  it("throws when the submit response is malformed JSON", async () => {
    const bad = new Response("not json", { status: 200, headers: { "Content-Type": "application/json" } });
    await expect(runwayml.parseResponse(bad, { headers: HEADERS })).rejects.toThrow();
  });

  it("polls through QUEUED → PROCESSING → SUCCEEDED and normalizes output to URLs", async () => {
    global.fetch
      .mockResolvedValueOnce(jsonResponse({ status: "PROCESSING" }))
      .mockResolvedValueOnce(jsonResponse({ status: "SUCCEEDED", output: ["https://cdn.example/result.mp4"] }));

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

  it("normalizes string/object output shapes too", () => {
    expect(runwayml.normalize({ output: "https://cdn/x.mp4" }).data).toEqual([{ url: "https://cdn/x.mp4" }]);
    expect(runwayml.normalize({ output: { url: "https://cdn/y.mp4" } }).data).toEqual([{ url: "https://cdn/y.mp4" }]);
    expect(runwayml.normalize({}).data).toEqual([]);
  });

  it("throws on a failed task status (HTTP 200 + FAILED)", async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ status: "FAILED", failure: "content moderation" }));
    const promise = runwayml.parseResponse(jsonResponse({ id: "task-2" }), { headers: HEADERS }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("content moderation"); // surfaces the provider failure reason
  });

  it("throws on a cancelled task status", async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ status: "CANCELLED" }));
    const promise = runwayml.parseResponse(jsonResponse({ id: "task-3" }), { headers: HEADERS }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/video generation failed/);
  });

  it("throws on poll status HTTP failure", async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({}, 500));
    const promise = runwayml.parseResponse(jsonResponse({ id: "task-4" }), { headers: HEADERS }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/Runway status 500/);
  });

  it("throws when polling times out", async () => {
    // Fresh response per poll — a shared instance would be "already read".
    global.fetch.mockImplementation(() => Promise.resolve(jsonResponse({ status: "PROCESSING" })));
    const promise = runwayml.parseResponse(jsonResponse({ id: "task-5" }), { headers: HEADERS }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS + POLL_INTERVAL_MS * 4);
    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/polling timeout/);
  });
});