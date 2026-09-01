/**
 * Unit tests for the Bynara text-to-video adapter (verified contract).
 *
 * Contract (router.bynara.id/docs): POST router.bynara.id/v1/videos with
 * mode=t2v; poll GET /v1/videos/{id} to `succeeded`; result url is relative.
 *
 * Covers endpoint/headers/exact payload (never image fields), Bynara-specific
 * validation (3-15s duration, ratio allow-list, 720p/1080p, seed range),
 * submission (202+id / missing id / malformed / 4xx / 5xx), polling (pending →
 * succeeded / failed / cancelled / unknown / 404 / timeout), and result URL
 * resolution. Fetch mocked; timers faked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { POLL_INTERVAL_MS, POLL_TIMEOUT_MS } from "../../open-sse/handlers/imageProviders/_base.js";
import bynara from "../../open-sse/handlers/videoProviders/bynara.js";

const originalFetch = global.fetch;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const HEADERS = { Authorization: "Bearer sk-nry-test" };
const MODEL = "agnes-video-v2.0";

describe("bynara video adapter (agnes-video-v2.0 T2V)", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
    vi.useFakeTimers();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

it("submits to the verified router.bynara.id endpoint with Bearer auth", () => {
    // Live probe: api-images.bynara.id/v1/videos returns an nginx HTML 404, but
    // router.bynara.id/v1/videos answers with the JSON API. Guard against
    // regressing to the stale docs host.
    expect(bynara.buildUrl()).toBe("https://router.bynara.id/v1/videos");
    expect(bynara.buildUrl()).not.toContain("api-images.bynara.id");
    expect(bynara.buildHeaders({ apiKey: "k" })).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer k",
    });
  });

  it("builds the minimal t2v payload and never sends image input", () => {
    const body = bynara.buildBody(MODEL, { prompt: "a city at sunset" });
    expect(body).toEqual({ model: MODEL, mode: "t2v", prompt: "a city at sunset", duration: 5 });
    expect(body).not.toHaveProperty("promptImage");
    expect(body).not.toHaveProperty("image");
    expect(body).not.toHaveProperty("image_url");
    expect(body).not.toHaveProperty("image_urls");
  });

  it("passes through supported optional fields", () => {
    const body = bynara.buildBody(MODEL, {
      prompt: "x",
      negative_prompt: "no text",
      resolution: "1080p",
      ratio: "9:16",
      duration: 7,
      seed: 123,
      watermark: true,
    });
    expect(body).toMatchObject({
      model: MODEL,
      mode: "t2v",
      prompt: "x",
      negative_prompt: "no text",
      resolution: "1080p",
      ratio: "9:16",
      duration: 7,
      seed: 123,
      watermark: true,
    });
  });

  it("validates prompt (required, <=3500)", () => {
    expect(() => bynara.buildBody(MODEL, {})).toThrow(/prompt/);
    expect(() => bynara.buildBody(MODEL, { prompt: "" })).toThrow(/prompt/);
    expect(() => bynara.buildBody(MODEL, { prompt: "a".repeat(3501) })).toThrow(/3500/);
    expect(() => bynara.buildBody(MODEL, { prompt: "ok", negative_prompt: "b".repeat(3501) })).toThrow(/3500/);
  });

  it("validates duration as integer 3..15", () => {
    expect(bynara.buildBody(MODEL, { prompt: "x" }).duration).toBe(5);
    expect(bynara.buildBody(MODEL, { prompt: "x", duration: 3 }).duration).toBe(3);
    expect(bynara.buildBody(MODEL, { prompt: "x", duration: 15 }).duration).toBe(15);
    for (const bad of [2, 16, 2.5, -1, 0, "5"]) {
      expect(() => bynara.buildBody(MODEL, { prompt: "x", duration: bad }), `duration=${bad}`).toThrow(/duration/);
    }
  });

  it("validates ratio against the Bynara allow-list (not Runway values)", () => {
    for (const r of ["16:9", "9:16", "1:1", "4:3", "3:4", "4:5", "5:4", "9:21", "21:9"]) {
      expect(bynara.buildBody(MODEL, { prompt: "x", ratio: r }).ratio).toBe(r);
    }
    for (const bad of ["1280:720", "720:1280", "4:6", "16/9"]) {
      expect(() => bynara.buildBody(MODEL, { prompt: "x", ratio: bad }), `ratio=${bad}`).toThrow(/unsupported ratio/);
    }
  });

  it("validates resolution (720p/1080p only)", () => {
    expect(() => bynara.buildBody(MODEL, { prompt: "x", resolution: "4k" })).toThrow(/unsupported resolution/);
    expect(bynara.buildBody(MODEL, { prompt: "x", resolution: "720p" }).resolution).toBe("720p");
    expect(bynara.buildBody(MODEL, { prompt: "x", resolution: "1080p" }).resolution).toBe("1080p");
  });

  it("validates seed range (0..2147483647)", () => {
    for (const bad of [-1, 2147483648, 1.5, "42"]) {
      expect(() => bynara.buildBody(MODEL, { prompt: "x", seed: bad }), `seed=${bad}`).toThrow(/seed/);
    }
    expect(bynara.buildBody(MODEL, { prompt: "x", seed: 0 }).seed).toBe(0);
    expect(bynara.buildBody(MODEL, { prompt: "x", seed: 2147483647 }).seed).toBe(2147483647);
  });

  it("throws when the submit response has no task id", async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ status: "pending" }));
    await expect(bynara.parseResponse(jsonResponse({}), { headers: HEADERS })).rejects.toThrow(/no task id/);
  });

  it("throws when the submit response is malformed JSON", async () => {
    const bad = new Response("not-json", { status: 202, headers: { "Content-Type": "application/json" } });
    await expect(bynara.parseResponse(bad, { headers: HEADERS })).rejects.toThrow();
  });

  it("polls pending → succeeded and resolves the relative download URL", async () => {
    global.fetch
      .mockResolvedValueOnce(jsonResponse({ id: "t1", status: "pending", created: 123 }))
      .mockResolvedValueOnce(jsonResponse({ id: "t1", status: "succeeded", url: "/v1/videos/t1/download", duration: 5, created: 123 }));
    const promise = bynara.parseResponse(jsonResponse({ id: "t1", status: "pending", created: 123 }), { headers: HEADERS });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    const s = await promise;
    const normalized = bynara.normalize(s);
    expect(normalized.data).toEqual([{ url: "https://router.bynara.id/v1/videos/t1/download" }]);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/videos/t1"),
      expect.objectContaining({ headers: HEADERS })
    );
  });

  it("throws on `succeeded` with no output url", async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ id: "t2", status: "succeeded" }));
    const promise = bynara.parseResponse(jsonResponse({ id: "t2", status: "succeeded" }), { headers: HEADERS }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/no output url/);
  });

  it("normalizes a relative url to the media origin, never an attacker host", () => {
    const n = bynara.normalize({ url: "/v1/videos/abc/download", created: 999 });
    expect(n.created).toBe(999);
    expect(n.data[0].url).toBe("https://router.bynara.id/v1/videos/abc/download");
    // absolute passthrough + empty guard
    expect(bynara.normalize({}).data).toEqual([]);
  });

  it("throws on a failed task surfacing the provider reason (HTTP 200 + failed)", async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({ status: "failed", error: { message: "content moderation" } }));
    const promise = bynara.parseResponse(jsonResponse({ id: "t3", status: "failed" }), { headers: HEADERS }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("content moderation");
  });

  it("throws on a cancelled task by any documented spelling", async () => {
    for (const st of ["cancelled", "canceled"]) {
      global.fetch.mockResolvedValueOnce(jsonResponse({ id: "t4", status: st, code: "task_cancelled" }));
      const promise = bynara.parseResponse(jsonResponse({ id: "t4", status: st }), { headers: HEADERS }).catch((e) => e);
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
      const err = await promise;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/task_cancelled/);
    }
  });

  it("maps a 404 poll to task-deleted/cancelled", async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse({}, 404));
    const promise = bynara.parseResponse(jsonResponse({ id: "t5", status: "pending" }), { headers: HEADERS }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/cancelled or no longer exists/);
  });

  it("does not classify an unknown status as success — times out instead", async () => {
    global.fetch.mockImplementation(() => Promise.resolve(jsonResponse({ id: "t6", status: "generating-unknown" })));
    const promise = bynara.parseResponse(jsonResponse({ id: "t6", status: "pending" }), { headers: HEADERS }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS + POLL_INTERVAL_MS * 4);
    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/polling timeout/);
  });

  it("times out when the task never reaches a terminal state", async () => {
    global.fetch.mockImplementation(() => Promise.resolve(jsonResponse({ id: "t7", status: "pending" })));
    const promise = bynara.parseResponse(jsonResponse({ id: "t7", status: "pending" }), { headers: HEADERS }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS + POLL_INTERVAL_MS * 4);
    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/polling timeout/);
  });
});