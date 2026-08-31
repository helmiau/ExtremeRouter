// Central config for remote-media fetching security limits.

// Max bytes accepted from a remote image fetch (reject larger to prevent memory DoS).
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB

// Fetch timeout for remote media.
export const FETCH_TIMEOUT_MS = 10000;

// Magic-byte signatures -> mime. Each entry: { sig:[bytes], offset, mime }.
// offset>0 for containers where the signature is not at byte 0 (e.g. webp).
export const IMAGE_SIGNATURES = [
  { sig: [0x89, 0x50, 0x4e, 0x47], offset: 0, mime: "image/png" },
  { sig: [0xff, 0xd8, 0xff], offset: 0, mime: "image/jpeg" },
  { sig: [0x47, 0x49, 0x46, 0x38], offset: 0, mime: "image/gif" },
  { sig: [0x52, 0x49, 0x46, 0x46], offset: 0, mime: "image/webp", verifyWebp: true },
  { sig: [0x42, 0x4d], offset: 0, mime: "image/bmp" },
];

// Hostnames/IPs that must never be fetched (SSRF guard for loopback + cloud metadata).
export const BLOCKED_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "169.254.169.254", // AWS/GCP/Azure IMDS
  "metadata.google.internal",
]);

// Max bytes accepted from a remote generated-video fetch. Kept bounded to defend
// memory DoS while still allowing typical T2V/I2V clips (seconds-long MP4s).
export const MAX_VIDEO_BYTES = 512 * 1024 * 1024; // 512MB

// Content-Types accepted as successful generated-video output. `octet-stream`
// is allowed only as a fallback because some CDN/object stores send it for
// signed artifacts; it is never treated as proof the body is video on its own.
export const VIDEO_CONTENT_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/mov",
  "application/octet-stream",
]);
