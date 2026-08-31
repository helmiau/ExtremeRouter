/**
 * Security tests for safeFetchMediaResult — the shared generated-media downloader.
 *
 * Covers the SSRF matrix: loopback, localhost, cloud metadata, RFC1918,
 * IPv6 loopback/link-local, DNS resolving to a private address, redirects (never
 * followed), invalid schemes, missing/disallowed Content-Type, and size caps.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

import { lookup } from "node:dns/promises";
import { safeFetchMediaResult } from "../../open-sse/utils/mediaResultDownload.js";

const originalFetch = global.fetch;

function mediaResponse(mimeType, bytes, { status = 200, headers = {} } = {}) {
  const h = { "Content-Type": mimeType, ...headers };
  return new Response(new Uint8Array(bytes), { status, headers: h });
}

const PUBLIC_IP = [{ address: "203.0.113.55", family: 4 }];

describe("safeFetchMediaResult (SSRF guard)", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
    vi.mocked(lookup).mockReset();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("rejects invalid schemes", async () => {
    expect(await safeFetchMediaResult("ftp://example.com/v.mp4")).toBeNull();
    expect(await safeFetchMediaResult("file:///etc/passwd")).toBeNull();
    expect(await safeFetchMediaResult("not-a-url")).toBeNull();
  });

  it("blocks loopback / localhost / metadata hosts regardless of content", async () => {
    for (const host of ["127.0.0.1", "localhost", "0.0.0.0", "169.254.169.254", "metadata.google.internal", "[::1]"]) {
      expect(await safeFetchMediaResult(`https://${host}/v.mp4`), host).toBeNull();
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it("blocks private RFC1918 IP literals", async () => {
    for (const ip of ["10.0.0.1", "172.16.5.9", "192.168.1.5", "192.168.0.1"]) {
      vi.mocked(lookup).mockResolvedValueOnce([{ address: ip, family: 4 }]);
      expect(await safeFetchMediaResult(`https://${ip}/v.mp4`), ip).toBeNull();
    }
  });

  it("blocks loopback/link-local IPv6", async () => {
    vi.mocked(lookup).mockResolvedValueOnce([{ address: "::1", family: 6 }]);
    expect(await safeFetchMediaResult("https://[::ffff:127.0.0.1]/v.mp4")).toBeNull();
  });

  it("blocks a hostname whose DNS resolves to a private address (multi-A guard)", async () => {
    vi.mocked(lookup).mockResolvedValueOnce([{ address: "10.1.2.3", family: 4 }]);
    expect(await safeFetchMediaResult("https://evil.example/v.mp4")).toBeNull();
  });

  it("rejects redirects without following them (no SSRF bypass via 3xx)", async () => {
    vi.mocked(lookup).mockResolvedValue(PUBLIC_IP);
    global.fetch.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/v.mp4" } })
    );
    expect(await safeFetchMediaResult("https://public.example/v.mp4")).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing Content-Type", async () => {
    vi.mocked(lookup).mockResolvedValue(PUBLIC_IP);
    global.fetch.mockResolvedValueOnce(mediaResponse(null, [1, 2, 3]));
    expect(await safeFetchMediaResult("https://public.example/v.mp4")).toBeNull();
  });

  it("rejects a disallowed Content-Type (text/html is not video)", async () => {
    vi.mocked(lookup).mockResolvedValue(PUBLIC_IP);
    global.fetch.mockResolvedValueOnce(mediaResponse("text/html", [1, 2, 3]));
    expect(await safeFetchMediaResult("https://public.example/v.mp4")).toBeNull();
  });

  it("rejects an oversized response body", async () => {
    vi.mocked(lookup).mockResolvedValue(PUBLIC_IP);
    global.fetch.mockResolvedValueOnce(mediaResponse("video/mp4", new Array(100).fill(0x11)));
    expect(await safeFetchMediaResult("https://public.example/v.mp4", { maxBytes: 16 })).toBeNull();
  });

  it("downloads a valid public video artifact", async () => {
    vi.mocked(lookup).mockResolvedValue(PUBLIC_IP);
    const bytes = [0x66, 0x74, 0x79, 0x70]; // "ftyp"
    global.fetch.mockResolvedValueOnce(mediaResponse("video/mp4", bytes));
    const media = await safeFetchMediaResult("https://public.example/v.mp4");
    expect(media).not.toBeNull();
    expect(media.mimeType).toBe("video/mp4");
    expect(Buffer.from(media.buffer)).toEqual(Buffer.from(bytes));
  });
});