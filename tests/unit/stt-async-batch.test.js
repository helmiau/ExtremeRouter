import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleSttCore } from "../../open-sse/handlers/sttCore.js";

const originalFetch = global.fetch;

function makeFormData(model) {
  const fd = new FormData();
  fd.append("model", model);
  fd.append("file", new File([new Uint8Array([1, 2, 3])], "clip.wav", { type: "audio/wav" }));
  return fd;
}

function jsonRes(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

describe("async-batch STT adapters", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("gladia: upload → submit pre-recorded job → poll result_url → full_transcript", async () => {
    global.fetch
      .mockResolvedValueOnce(jsonRes({ audio_url: "https://cdn.gladia.io/x.mp3" }))       // upload
      .mockResolvedValueOnce(jsonRes({ result_url: "https://api.gladia.io/result/abc" })) // submit
      .mockResolvedValueOnce(jsonRes({ status: "done", result: { transcription: { full_transcript: "Hello world" } } })); // poll

    const result = await handleSttCore({
      provider: "gladia",
      model: "solaria-1",
      formData: makeFormData("solaria-1"),
      credentials: { apiKey: "gk" },
      sttConfig: {
        baseUrl: "https://api.gladia.io/v2/pre-recorded",
        authType: "apikey",
        authHeader: "x-gladia-key",
        format: "gladia",
      },
    });

    expect(result.success).toBe(true);
    // x-gladia-key custom header must be sent on every call
    for (const [, opts] of global.fetch.mock.calls) {
      expect(opts.headers).toMatchObject({ "x-gladia-key": "gk" });
    }
    expect(global.fetch.mock.calls[1][0]).toBe("https://api.gladia.io/v2/pre-recorded");
    expect(JSON.parse(global.fetch.mock.calls[1][1].body)).toEqual({ audio_url: "https://cdn.gladia.io/x.mp3", model: "solaria-1" });
    const body = await result.response.json();
    expect(body).toEqual({ text: "Hello world" });
  });

  it("soniox: upload file → create job → poll completed → fetch transcript", async () => {
    global.fetch
      .mockResolvedValueOnce(jsonRes({ id: "file-1" }))                                            // upload
      .mockResolvedValueOnce(jsonRes({ id: "tr-1" }))                                               // create
      .mockResolvedValueOnce(jsonRes({ status: "completed" }))                                      // poll
      .mockResolvedValueOnce(jsonRes({ text: "Transcribed by soniox" }));                           // transcript

    const result = await handleSttCore({
      provider: "soniox",
      model: "stt-async-v5",
      formData: makeFormData("stt-async-v5"),
      credentials: { apiKey: "sk" },
      sttConfig: {
        baseUrl: "https://api.soniox.com/v1/transcriptions",
        authType: "apikey",
        authHeader: "bearer",
        format: "soniox",
      },
    });

    expect(result.success).toBe(true);
    expect(global.fetch.mock.calls[1][0]).toBe("https://api.soniox.com/v1/transcriptions");
    expect(JSON.parse(global.fetch.mock.calls[1][1].body)).toMatchObject({ model: "stt-async-v5", file_id: "file-1", enable_language_identification: true });
    expect(global.fetch.mock.calls[3][0]).toBe("https://api.soniox.com/v1/transcriptions/tr-1/transcript");
    const body = await result.response.json();
    expect(body).toEqual({ text: "Transcribed by soniox" });
  });

  it("rev-ai: submit job (media field) → poll transcribed → fetch plain-text transcript", async () => {
    global.fetch
      .mockResolvedValueOnce(jsonRes({ id: "job-9" }))                        // submit
      .mockResolvedValueOnce(jsonRes({ status: "transcribed" }))               // poll
      .mockResolvedValueOnce(new Response("Plain transcript", { status: 200 })); // transcript txt

    const result = await handleSttCore({
      provider: "rev-ai",
      model: "machine",
      formData: makeFormData("machine"),
      credentials: { apiKey: "rk" },
      sttConfig: {
        baseUrl: "https://api.rev.ai/speechtotext/v1",
        authType: "apikey",
        authHeader: "bearer",
        format: "rev-ai",
      },
    });

    expect(result.success).toBe(true);
    expect(global.fetch.mock.calls[0][0]).toBe("https://api.rev.ai/speechtotext/v1/jobs");
    expect(global.fetch.mock.calls[2][0]).toBe("https://api.rev.ai/speechtotext/v1/jobs/job-9/transcript");
    const body = await result.response.json();
    expect(body).toEqual({ text: "Plain transcript" });
  });

  it("speechmatics: submit job (data_file + config) → poll done → fetch txt transcript", async () => {
    global.fetch
      .mockResolvedValueOnce(jsonRes({ id: "sm-1" }))                         // submit
      .mockResolvedValueOnce(jsonRes({ job: { status: "done" } }))             // poll
      .mockResolvedValueOnce(new Response("Speechmatics text", { status: 200 })); // transcript txt

    const result = await handleSttCore({
      provider: "speechmatics",
      model: "enhanced",
      formData: makeFormData("enhanced"),
      credentials: { apiKey: "smk" },
      sttConfig: {
        baseUrl: "https://asr.api.speechmatics.com/v2/jobs",
        authType: "apikey",
        authHeader: "bearer",
        format: "speechmatics",
      },
    });

    expect(result.success).toBe(true);
    expect(global.fetch.mock.calls[0][0]).toBe("https://asr.api.speechmatics.com/v2/jobs");
    expect(global.fetch.mock.calls[2][0]).toBe("https://asr.api.speechmatics.com/v2/jobs/sm-1/transcript?format=txt");
    const body = await result.response.json();
    expect(body).toEqual({ text: "Speechmatics text" });
  });

  it("speechmatics: rejected job surfaces the upstream error message", async () => {
    global.fetch
      .mockResolvedValueOnce(jsonRes({ id: "sm-2" }))
      .mockResolvedValueOnce(jsonRes({ job: { status: "rejected", errors: [{ message: "audio too short" }] } }));

    const result = await handleSttCore({
      provider: "speechmatics",
      model: "enhanced",
      formData: makeFormData("enhanced"),
      credentials: { apiKey: "smk" },
      sttConfig: {
        baseUrl: "https://asr.api.speechmatics.com/v2/jobs",
        authType: "apikey",
        authHeader: "bearer",
        format: "speechmatics",
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("audio too short");
  });
});
