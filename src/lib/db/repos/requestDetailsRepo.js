import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { shouldSkipRequestDetailOverwrite } from "../../../../open-sse/utils/requestDetailStatus.js";

const DEFAULT_MAX_RECORDS = 200;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_MAX_JSON_SIZE = 5 * 1024;
const DEFAULT_MAX_ATTEMPTS = 32;
const CONFIG_CACHE_TTL_MS = 5000;

let cachedConfig = null;
let cachedConfigTs = 0;

async function getObservabilityConfig() {
  if (cachedConfig && (Date.now() - cachedConfigTs) < CONFIG_CACHE_TTL_MS) return cachedConfig;
  try {
    const { getSettings } = await import("./settingsRepo.js");
    const settings = await getSettings();
    // Opt-in by default: full request/response capture (prompts included) only
    // runs when the user enables the dashboard toggle or sets
    // OBSERVABILITY_ENABLED=true explicitly. (The old reader key
    // `enableObservability2` was never written by any UI — the profile toggle
    // writes `enableObservability`, which now actually controls capture.)
    const envEnabled = process.env.OBSERVABILITY_ENABLED === "true";
    const enabled = typeof settings.enableObservability === "boolean"
      ? settings.enableObservability
      : envEnabled;
    cachedConfig = {
      enabled,
      maxRecords: settings.observabilityMaxRecords || parseInt(process.env.OBSERVABILITY_MAX_RECORDS || String(DEFAULT_MAX_RECORDS), 10),
      batchSize: settings.observabilityBatchSize || parseInt(process.env.OBSERVABILITY_BATCH_SIZE || String(DEFAULT_BATCH_SIZE), 10),
      flushIntervalMs: settings.observabilityFlushIntervalMs || parseInt(process.env.OBSERVABILITY_FLUSH_INTERVAL_MS || String(DEFAULT_FLUSH_INTERVAL_MS), 10),
      maxJsonSize: (settings.observabilityMaxJsonSize || parseInt(process.env.OBSERVABILITY_MAX_JSON_SIZE || "5", 10)) * 1024,
      maxAttempts: settings.observabilityMaxAttempts || parseInt(process.env.OBSERVABILITY_MAX_ATTEMPTS || String(DEFAULT_MAX_ATTEMPTS), 10),
    };
  } catch {
    cachedConfig = {
      enabled: false,
      maxRecords: DEFAULT_MAX_RECORDS,
      batchSize: DEFAULT_BATCH_SIZE,
      flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
      maxJsonSize: DEFAULT_MAX_JSON_SIZE,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
    };
  }
  cachedConfigTs = Date.now();
  return cachedConfig;
}

let writeBuffer = [];
let flushTimer = null;
let isFlushing = false;

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const sensitiveKeys = ["authorization", "x-api-key", "cookie", "token", "api-key"];
  const sanitized = { ...headers };
  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.some((s) => key.toLowerCase().includes(s))) delete sanitized[key];
  }
  return sanitized;
}

// Content redaction: prompts / responses can carry gateway keys, bearer
// tokens or JWTs. Deep-walk the stored objects and replace known secret
// shapes with [REDACTED] before the truncation pass (shapes stay intact).
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
  // Inline key=value shapes (cookie headers, captcha proof parameters, session
  // ids embedded in a larger string) — value redacted even when the string as a
  // whole matches no key shape above.
  /\b[Cc]ookie\s*[=:]\s*[^;\s,]+/g,
  /\b(?:access[_-]?token|refresh[_-]?token|captcha[_-]?(?:verify[_-]?)?(?:param|token|id)|captcha[_-]?proof|turnstile[_-]?token|hcaptcha[_-]?token|recaptcha[_-]?token|cf[_-]clearance)\s*[=:]\s*[^;\s,]+/g,
];
const REDACTED = "[REDACTED]";

// Forensics can carry credential-shaped objects whose VALUES are unrecognized
// patterns (e.g. authorization: "Basic ...", captchaVerifyParam, short tokens).
// A sensitive KEY redacts its value even when no value pattern matches.
// Compounds use optional separators ([_-]?) so camelCase, snake_case and
// kebab-case all match field names like captchaVerifyParam / xApiKey.
const SENSITIVE_KEY_PATTERN = /\b(?:authorization|x[-_]?api[-_]?key|api[-_]?key|apikey|cookie|set[-_]?cookie|session[-_]?(?:id|token)?|access[-_]?token|refresh[-_]?token|captcha[-_]?(?:verify[-_]?)?(?:param|token|id)|captcha[-_]?proof|turnstile[-_]?token|hcaptcha[-_]?token|recaptcha[-_]?token|cf[-_]?clearance|token|secret|password|credential|proof)\b/i;

export function redactSecretsDeep(value, depth = 0) {
  if (depth > 12) return value;
  if (typeof value === "string") {
    let out = value;
    for (const re of SECRET_PATTERNS) out = out.replace(re, REDACTED);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => redactSecretsDeep(v, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY_PATTERN.test(k) ? REDACTED : redactSecretsDeep(v, depth + 1);
    }
    return out;
  }
  return value;
}

function generateDetailId(model) {
  const timestamp = new Date().toISOString();
  const random = Math.random().toString(36).substring(2, 8);
  const modelPart = model ? model.replace(/[^a-zA-Z0-9-]/g, "-") : "unknown";
  return `${timestamp}-${random}-${modelPart}`;
}

function truncateField(obj, maxSize) {
  const str = JSON.stringify(obj || {});
  if (str.length > maxSize) {
    return { _truncated: true, _originalSize: str.length, _preview: str.substring(0, 200) };
  }
  return obj || {};
}

function safeStructuredField(value, maxSize) {
  if (value == null) return null;
  return truncateField(redactSecretsDeep(value), maxSize);
}

function safeAttemptsField(attempts, maxSize) {
  if (!Array.isArray(attempts) || attempts.length === 0) return null;
  const redacted = attempts.map((attempt) => redactSecretsDeep(attempt));
  if (JSON.stringify(redacted).length <= maxSize) return redacted;

  const kept = [];
  for (let i = redacted.length - 1; i >= 0; i--) {
    const candidate = [redacted[i], ...kept];
    if (JSON.stringify(candidate).length > maxSize) break;
    kept.unshift(redacted[i]);
  }
  return kept.length > 0 ? kept : [{
    attemptId: redacted[redacted.length - 1]?.attemptId || null,
    classification: redacted[redacted.length - 1]?.classification || null,
    reason: redacted[redacted.length - 1]?.reason || null,
    _truncated: true,
  }];
}

function mergeAttempts(existing, incoming, maxAttempts = DEFAULT_MAX_ATTEMPTS) {
  const prior = Array.isArray(existing) ? existing : [];
  const next = Array.isArray(incoming) ? incoming : [];
  const merged = [];
  const positions = new Map();
  for (const attempt of [...prior, ...next]) {
    if (!attempt || typeof attempt !== "object") continue;
    const id = typeof attempt.attemptId === "string" && attempt.attemptId
      ? attempt.attemptId
      : null;
    if (id && positions.has(id)) {
      merged[positions.get(id)] = attempt;
      continue;
    }
    if (id) positions.set(id, merged.length);
    merged.push(attempt);
  }
  return merged.slice(-Math.max(1, maxAttempts));
}

async function flushToDatabase() {
  if (isFlushing) return;
  if (writeBuffer.length === 0) return;
  isFlushing = true;
  try {
    // Drain entire buffer (loop in case more pushed during await)
    while (writeBuffer.length > 0) {
      const items = writeBuffer.splice(0, writeBuffer.length);
      const db = await getAdapter();
      const config = await getObservabilityConfig();

      db.transaction(() => {
        for (const item of items) {
          if (!item.id) item.id = generateDetailId(item.model);
          if (!item.timestamp) item.timestamp = new Date().toISOString();
          if (item.request?.headers) item.request.headers = sanitizeHeaders(item.request.headers);

          const existingRow = db.get(`SELECT status, data FROM requestDetails WHERE id = ?`, [item.id]);
          const existingData = existingRow?.data ? parseJson(existingRow.data, {}) : {};
          const attempts = mergeAttempts(existingData.attempts, item.attempts, config.maxAttempts);
          const record = {
            id: item.id,
            provider: item.provider || existingData.provider || null,
            model: item.model || existingData.model || null,
            connectionId: item.connectionId || existingData.connectionId || null,
            timestamp: item.timestamp,
            status: item.status || existingRow?.status || null,
            latency: item.latency || existingData.latency || {},
            tokens: item.tokens || existingData.tokens || {},
            combo: safeStructuredField(item.combo ?? existingData.combo, config.maxJsonSize),
            request: item.request !== undefined
              ? truncateField(redactSecretsDeep(item.request), config.maxJsonSize)
              : (existingData.request || {}),
            providerRequest: item.providerRequest !== undefined
              ? truncateField(redactSecretsDeep(item.providerRequest), config.maxJsonSize)
              : (existingData.providerRequest || null),
            providerResponse: item.providerResponse !== undefined
              ? truncateField(redactSecretsDeep(item.providerResponse), config.maxJsonSize)
              : (existingData.providerResponse || null),
            response: item.response !== undefined
              ? truncateField(redactSecretsDeep(item.response), config.maxJsonSize)
              : (existingData.response || {}),
            ...(item.endpoint !== undefined || existingData.endpoint !== undefined ? { endpoint: item.endpoint ?? existingData.endpoint ?? null } : {}),
            ...(item.transport !== undefined || existingData.transport !== undefined ? { transport: safeStructuredField(item.transport ?? existingData.transport, config.maxJsonSize) } : {}),
            ...(item.correlation !== undefined || existingData.correlation !== undefined ? { correlation: safeStructuredField(item.correlation ?? existingData.correlation, config.maxJsonSize) } : {}),
            ...(item.canonicalAttempt !== undefined || existingData.canonicalAttempt !== undefined ? { canonicalAttempt: safeStructuredField(item.canonicalAttempt ?? existingData.canonicalAttempt, config.maxJsonSize) } : {}),
            ...(item.streamObservability !== undefined || existingData.streamObservability !== undefined ? { streamObservability: safeStructuredField(item.streamObservability ?? existingData.streamObservability, config.maxJsonSize) } : {}),
            ...(attempts.length > 0 ? { attempts: safeAttemptsField(attempts, config.maxJsonSize) } : {}),
          };

          // Lifecycle guard: the FIRST terminal status wins. Historical attempt
          // evidence is merged above even when the main row status is protected.
          if (shouldSkipRequestDetailOverwrite(existingRow?.status, record.status)) {
            if (attempts.length > 0 && JSON.stringify(attempts) !== JSON.stringify(existingData.attempts || [])) {
              db.run(`UPDATE requestDetails SET data = ? WHERE id = ?`, [stringifyJson({ ...existingData, attempts: safeAttemptsField(attempts, config.maxJsonSize) }), record.id]);
            }
            continue;
          }

          db.run(
            `INSERT INTO requestDetails(id, timestamp, provider, model, connectionId, status, data) VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET timestamp = excluded.timestamp, provider = excluded.provider, model = excluded.model, connectionId = excluded.connectionId, status = excluded.status, data = excluded.data`,
            [record.id, record.timestamp, record.provider, record.model, record.connectionId, record.status, stringifyJson(record)]
          );
        }

        const cnt = db.get(`SELECT COUNT(*) as c FROM requestDetails`);
        if (cnt && cnt.c > config.maxRecords) {
          db.run(
            `DELETE FROM requestDetails WHERE id IN (SELECT id FROM requestDetails ORDER BY timestamp ASC LIMIT ?)`,
            [cnt.c - config.maxRecords]
          );
        }
      });
    }
  } catch (e) {
    console.error("[requestDetailsRepo] Batch write failed:", e);
  } finally {
    isFlushing = false;
  }
}

export async function saveRequestDetail(detail) {
  const config = await getObservabilityConfig();
  if (!config.enabled) return;

  writeBuffer.push(detail);

  // Trigger immediate flush if batch threshold reached.
  // flushToDatabase() drains entire buffer in a loop, so all pushes during await are persisted.
  if (writeBuffer.length >= config.batchSize) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    flushToDatabase().catch((e) => console.error("[requestDetailsRepo] flush err:", e));
  } else if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushToDatabase().catch(() => {});
    }, config.flushIntervalMs);
  }
}

export async function getRequestDetails(filter = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];

  if (filter.provider) { conds.push("provider = ?"); params.push(filter.provider); }
  if (filter.model) { conds.push("model = ?"); params.push(filter.model); }
  if (filter.connectionId) { conds.push("connectionId = ?"); params.push(filter.connectionId); }
  if (filter.status) { conds.push("status = ?"); params.push(filter.status); }
  if (filter.startDate) { conds.push("timestamp >= ?"); params.push(new Date(filter.startDate).toISOString()); }
  if (filter.endDate) { conds.push("timestamp <= ?"); params.push(new Date(filter.endDate).toISOString()); }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const cntRow = db.get(`SELECT COUNT(*) as c FROM requestDetails ${where}`, params);
  const totalItems = cntRow ? cntRow.c : 0;

  const page = filter.page || 1;
  const pageSize = filter.pageSize || 50;
  const totalPages = Math.ceil(totalItems / pageSize);
  const offset = (page - 1) * pageSize;

  const rows = db.all(
    `SELECT data FROM requestDetails ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  const details = rows.map((r) => parseJson(r.data, {}));

  return {
    details,
    pagination: { page, pageSize, totalItems, totalPages, hasNext: page < totalPages, hasPrev: page > 1 },
  };
}

export async function getRequestDetailById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM requestDetails WHERE id = ?`, [id]);
  return row ? parseJson(row.data, null) : null;
}

/**
 * Locate every leaf evidence row correlated with one forensic root request.
 * Root ledger rows are stored under `id = forensic.requestId` (embedding the
 * ordered attempts[]); streaming/error leaves are stored under their own ids
 * but carry `correlation: { requestId, attemptId, ... }`. This returns those
 * leaves so a forensic drill-down can reconstruct
 * requestId -> attempts[i] -> correlation.attemptId -> leaf evidence.
 * Retention-pruned (maxRecords), so the scan is bounded, not a hot path.
 */
export async function getRequestDetailsByCorrelation(requestId) {
  if (!requestId) return [];
  const config = await getObservabilityConfig();
  if (!config.enabled) return [];
  const db = await getAdapter();
  const rows = db.all(`SELECT data FROM requestDetails ORDER BY timestamp ASC`);
  const out = [];
  for (const row of rows) {
    const data = parseJson(row.data, {});
    if (data.correlation?.requestId === requestId) out.push(data);
  }
  return out;
}

// Distinct provider ids seen in request details (compact SELECT DISTINCT, no row load).
export async function getDistinctProviders() {
  const db = await getAdapter();
  const rows = db.all(`SELECT DISTINCT provider FROM requestDetails WHERE provider IS NOT NULL AND provider != '' ORDER BY provider`);
  return rows.map((r) => r.provider);
}

const _shutdownHandler = async () => {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (writeBuffer.length > 0) await flushToDatabase();
};

function ensureShutdownHandler() {
  process.off("beforeExit", _shutdownHandler);
  process.off("SIGINT", _shutdownHandler);
  process.off("SIGTERM", _shutdownHandler);
  process.off("exit", _shutdownHandler);

  process.on("beforeExit", _shutdownHandler);
  process.on("SIGINT", _shutdownHandler);
  process.on("SIGTERM", _shutdownHandler);
  process.on("exit", _shutdownHandler);
}

ensureShutdownHandler();
