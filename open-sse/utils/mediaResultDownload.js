// Hardened download primitive for remote generated-media results (video/image).
//
// The image pipeline historically downloaded provider result URLs with a bare
// `fetch(url)` (`imageProviders/_base.js` `urlToBase64`) — an SSRF sink. This
// module is the single safe downloader for generated-media artifacts:
//   scheme + hostname allow-list → DNS resolution pinned to public IPs →
//   `redirect:"manual"` (redirects rejected, never followed) → bounded streaming
//   read with a byte cap → Content-Type allow-list.
//
// It is deliberately media-agnostic (works for video and image) so future
// providers share one implementation instead of weaker per-provider copies.

import { lookup } from "node:dns/promises";
import { BLOCKED_HOSTS, FETCH_TIMEOUT_MS, VIDEO_CONTENT_TYPES } from "../config/mediaConfig.js";

// True if an IPv4/IPv6 address is private/reserved (an SSRF target).
export function isPrivateIp(ip) {
  if (!ip) return true;
  const h = String(ip).replace(/^\[|\]$/g, "").toLowerCase();
  // IPv6: loopback, unique-local (fc/fd), link-local (fe80), IPv4-mapped.
  if (h.includes(":")) {
    if (h === "::1" || h === "::") return true;
    if (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true;
    const v4 = h.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4) return isPrivateIpv4(v4[1]);
    return false;
  }
  return isPrivateIpv4(h);
}

// True if a dotted IPv4 literal is private/reserved.
function isPrivateIpv4(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return true; // not a clean literal → treat as unsafe
  const nums = parts.map((n) => Number.parseInt(n, 10));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = nums;
  if (a === 10 || a === 127 || a === 0) return true;            // RFC1918, loopback, unspecified
  if (a === 172 && b >= 16 && b <= 31) return true;             // RFC1918 172.16/12
  if (a === 192 && b === 168) return true;                      // RFC1918 192.168/16
  if (a === 169 && b === 254) return true;                      // link-local + cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true;            // CGNAT 100.64/10
  return false;
}

// Normalize a hostname for blocklist matching: strip brackets and trailing dot.
function normalizeHost(hostname) {
  return String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

// Resolve a hostname to its IPs, requiring every record to be public (defeats
// multi-A techniques where one record points at an internal/metadata address).
// Also blocks reserved hostnames outright.
export async function resolvePublicIps(hostname) {
  const host = normalizeHost(hostname);
  if (!host || BLOCKED_HOSTS.has(host)) return null;
  try {
    const records = await lookup(host, { all: true });
    if (!records.length || records.some((r) => isPrivateIp(r.address))) return null;
    return records;
  } catch {
    return null;
  }
}

/**
 * Fetch a remote generated-media artifact safely.
 * Returns `{ buffer, mimeType, url }` on success, or `null` on any rejection
 * (bad scheme, private/reserved host, private DNS, redirect, oversized body,
 * disallowed Content-Type, timeout, network error).
 *
 * @param {string} url - Absolute http(s) artifact URL
 * @param {object} [options]
 * @param {AbortSignal} [options.signal] - Caller-owned abort signal (client cancellation)
 * @param {number} [options.timeoutMs] - Override timeout (defaults to mediaConfig)
 * @param {number} [options.maxBytes] - Override byte cap (defaults to mediaConfig image cap)
 * @param {Set<string>} [options.allowedTypes] - Allowed Content-Types (defaults to video set)
 * @returns {Promise<{buffer: Buffer, mimeType: string, url: string}|null>}
 */
export async function safeFetchMediaResult(url, options = {}) {
  const { signal, timeoutMs = FETCH_TIMEOUT_MS, maxBytes, allowedTypes } = options;
  const max = maxBytes ?? 512 * 1024 * 1024;

  if (typeof url !== "string") return null;
  if (!url.startsWith("http://") && !url.startsWith("https://")) return null;

  const parsed = new URL(url);
  const host = normalizeHost(parsed.hostname);
  if (BLOCKED_HOSTS.has(host)) return null;

  const pinned = await resolvePublicIps(host);
  if (!pinned) return null;

  const controller = new AbortController();
  const timeout = signal ? null : setTimeout(() => controller.abort(), timeoutMs);
  const fetchSignal = signal || controller.signal;

  let onAbort = null;
  if (signal) {
    onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    // `redirect:"manual"` — never follow a redirect to a different (possibly
    // private) target. Generated-artifact URLs are direct; a 3xx is rejected.
    const response = await fetch(url, { signal: fetchSignal, redirect: "manual" });
    if (response.status >= 300 || !response.ok || !response.body) return null;

    const mimeType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!mimeType) return null; // reject unknown — do not guess
    if (!((allowedTypes ?? VIDEO_CONTENT_TYPES).has(mimeType))) return null;

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) {
        try { await reader.cancel(); } catch { /* ignore */ }
        return null;
      }
      chunks.push(value);
    }
    return { buffer: Buffer.concat(chunks), mimeType, url };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}