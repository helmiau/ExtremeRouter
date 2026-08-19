// Single source of truth for request-status classification.
//
// The backend (usageRepo error-rate, error charts, provider health timeline)
// and every dashboard widget (error donut, live logs, activity strip) MUST
// derive "error" from these sets — previously each site had its own list, so
// the donut, KPI and logs could disagree about the same request.

export const USAGE_ERROR_STATUSES = new Set([
  "error", "failed", "unauthorized", "forbidden", "timeout", "blocked",
]);

export const USAGE_OK_STATUSES = new Set(["ok", "success"]);

function normalize(status) {
  return String(status ?? "").trim().toLowerCase();
}

export function isUsageErrorStatus(status) {
  const s = normalize(status);
  if (USAGE_ERROR_STATUSES.has(s)) return true;
  return s !== "" && !Number.isNaN(Number(s)) && Number(s) >= 400;
}

export function isUsageOkStatus(status) {
  const s = normalize(status);
  if (USAGE_OK_STATUSES.has(s)) return true;
  return s !== "" && !Number.isNaN(Number(s)) && Number(s) >= 100 && Number(s) < 400;
}

/**
 * Classify any stored status value into "ok" | "error".
 *
 * Handles the string statuses the gateway writes ("ok", "failed", …) as well
 * as raw numeric HTTP codes that some paths store ("200", "401", "503"):
 *   - explicit error strings          → "error"
 *   - numeric 2xx/3xx                 → "ok"
 *   - numeric >= 400                  → "error"
 *   - unknown / empty / anything else → "ok" (matches the server-side
 *     error-rate convention: only known error statuses count as errors)
 */
export function classifyUsageStatus(status) {
  const s = normalize(status);
  if (USAGE_ERROR_STATUSES.has(s)) return "error";
  if (s !== "" && !Number.isNaN(Number(s))) {
    return Number(s) >= 400 ? "error" : "ok";
  }
  return "ok";
}
