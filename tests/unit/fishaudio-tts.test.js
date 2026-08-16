import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleTtsCore } from "../../open-sse/handlers/ttsCore.js";

const originalFetch = global.fetch;

describe("Fish Audio TTS", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("sends model as HTTP header + JSON body, returns base64 mp3", async () => {
    const audioBytes = new Uint8Array(256).fill(0x49); // >100 bytes — responseToBase64 rejects tiny payloads
    global.fetch.mockResolvedValueOnce(
      new Response(audioBytes, { status: 200, headers: { "Content-Type": "audio/mpeg" } })
    );

    const result = await handleTtsCore({
      provider: "fishaudio",
      model: "s1/ref-123",
      input: "Hello from Fish",
      credentials: { apiKey: "fk" },
      responseFormat: "json",
    });

    expect(result.success).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.fish.audio/v1/tts",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          Authorization: "Bearer fk",
          model: "s1",
        }),
      })
    );
    const sent = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(sent).toMatchObject({ text: "Hello from Fish", format: "mp3", reference_id: "ref-123" });

    const body = await result.response.json();
    expect(body.format).toBe("mp3");
    expect(typeof body.audio).toBe("string");
    expect(body.audio.length).toBeGreaterThan(0);
  });

  it("surfaces upstream errors", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "invalid api key" }), { status: 401, headers: { "Content-Type": "application/json" } })
    );

    const result = await handleTtsCore({
      provider: "fishaudio",
      model: "s1",
      input: "boom",
      credentials: { apiKey: "bad" },
      responseFormat: "json",
    });

    expect(result.success).toBe(false);
  });
});
