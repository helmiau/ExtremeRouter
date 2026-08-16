import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

/**
 * Smart Routing telemetry persistence — thin DB layer for
 * open-sse/services/smartRoutingTelemetry.js.
 *
 * The telemetry module owns the in-memory live bus and its write buffer; this
 * repo only performs the actual SQL (upsert + retention prune + load). Writes
 * never throw into the request path — callers catch and degrade silently.
 */

/** Retention cap: keep at most this many runs (newest kept). */
export const DEFAULT_MAX_RECORDS = 1000;

export async function persistRuns(runs) {
  if (!Array.isArray(runs) || runs.length === 0) return;
  const db = await getAdapter();
  const maxRecords = Number(process.env.SMART_ROUTING_MAX_RECORDS) || DEFAULT_MAX_RECORDS;

  db.transaction(() => {
    for (const run of runs) {
      if (!run || !run.runId) continue;
      const startedAt = run.startedAt != null ? String(run.startedAt) : new Date().toISOString();
      db.run(
        `INSERT INTO smartRoutingRuns(id, comboName, promptPreview, routing, reason, servedModel, status, error, startedAt, completedAt, totalDurationMs)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           comboName = excluded.comboName,
           promptPreview = excluded.promptPreview,
           routing = excluded.routing,
           reason = excluded.reason,
           servedModel = excluded.servedModel,
           status = excluded.status,
           error = excluded.error,
           startedAt = excluded.startedAt,
           completedAt = excluded.completedAt,
           totalDurationMs = excluded.totalDurationMs`,
        [
          run.runId,
          run.comboName || null,
          run.promptPreview || null,
          run.routing ? stringifyJson(run.routing) : null,
          run.routing?.reason || null,
          run.servedModel || null,
          run.status || "running",
          run.error || null,
          startedAt,
          run.completedAt != null ? String(run.completedAt) : null,
          run.totalDurationMs != null ? Number(run.totalDurationMs) : null,
        ],
      );
    }

    // Retention prune: delete the oldest rows beyond the cap.
    const cnt = db.get(`SELECT COUNT(*) as c FROM smartRoutingRuns`);
    if (cnt && cnt.c > maxRecords) {
      db.run(
        `DELETE FROM smartRoutingRuns WHERE id IN (
          SELECT id FROM smartRoutingRuns ORDER BY startedAt ASC LIMIT ?
        )`,
        [cnt.c - maxRecords],
      );
    }
  });
}

function rowToRun(row) {
  if (!row) return null;
  return {
    runId: row.id,
    comboName: row.comboName,
    promptPreview: row.promptPreview,
    routing: row.routing ? parseJson(row.routing, null) : null,
    servedModel: row.servedModel,
    status: row.status,
    error: row.error,
    startedAt: row.startedAt != null ? Number(row.startedAt) : null,
    completedAt: row.completedAt != null ? Number(row.completedAt) : null,
    totalDurationMs: row.totalDurationMs != null ? Number(row.totalDurationMs) : null,
  };
}

/**
 * Paged history query for the dashboard — filters by reason, combo, status and
 * a startedAt date range, with pagination metadata (mirrors requestDetailsRepo).
 *
 * @param {object} [opts]
 * @param {number} [opts.page] - 1-based page (default 1)
 * @param {number} [opts.pageSize] - rows per page (default 20, max 200)
 * @param {string} [opts.comboName] - exact combo name filter
 * @param {string} [opts.status] - run status filter (running|done|error)
 * @param {string} [opts.reason] - routing decision filter (tool_calling, …)
 * @param {string} [opts.startDate] - ISO/datetime string; startedAt >= this
 * @param {string} [opts.endDate} - ISO/datetime string; startedAt <= this
 * @returns {Promise<{runs: Array, pagination: object}>}
 */
export async function queryHistory({
  page = 1,
  pageSize = 20,
  comboName,
  status,
  reason,
  startDate,
  endDate,
} = {}) {
  const db = await getAdapter();
  const conds = [];
  const params = [];
  if (comboName) { conds.push("comboName = ?"); params.push(comboName); }
  if (status) { conds.push("status = ?"); params.push(status); }
  if (reason) { conds.push("reason = ?"); params.push(reason); }
  // startedAt is stored as a String(ms) — compare numerically via CAST.
  if (startDate) {
    const ms = new Date(startDate).getTime();
    if (Number.isFinite(ms)) { conds.push("CAST(startedAt AS INTEGER) >= ?"); params.push(ms); }
  }
  if (endDate) {
    const ms = new Date(endDate).getTime();
    if (Number.isFinite(ms)) { conds.push("CAST(startedAt AS INTEGER) <= ?"); params.push(ms); }
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

  const cntRow = db.get(`SELECT COUNT(*) as c FROM smartRoutingRuns ${where}`, params);
  const totalItems = cntRow ? cntRow.c : 0;
  const pageSizeN = Math.min(Math.max(Number(pageSize) || 20, 1), 200);
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSizeN));
  const pageN = Math.min(Math.max(Number(page) || 1, 1), totalPages);
  const offset = (pageN - 1) * pageSizeN;

  const rows = db.all(
    `SELECT * FROM smartRoutingRuns ${where} ORDER BY startedAt DESC LIMIT ? OFFSET ?`,
    [...params, pageSizeN, offset],
  );

  return {
    runs: rows.map(rowToRun).filter(Boolean),
    pagination: {
      page: pageN,
      pageSize: pageSizeN,
      totalItems,
      totalPages,
      hasNext: pageN < totalPages,
      hasPrev: pageN > 1,
    },
  };
}

/**
 * Load the newest runs (optionally filtered) for hydration after a restart.
 * Thin wrapper over queryHistory kept for the in-memory hydrate path.
 * @returns {Promise<Array>} runs newest-first
 */
export async function loadRecentRuns({ limit = 50, comboName, status } = {}) {
  const { runs } = await queryHistory({ page: 1, pageSize: limit, comboName, status });
  return runs;
}

/**
 * Distinct combo names seen in smartRoutingRuns — powers the combo filter
 * select on the dashboard without a second round-trip per filter change.
 * @returns {Promise<string[]>}
 */
export async function getDistinctCombos() {
  const db = await getAdapter();
  const rows = db.all(
    `SELECT DISTINCT comboName FROM smartRoutingRuns WHERE comboName IS NOT NULL AND comboName != '' ORDER BY comboName`,
  );
  return rows.map((r) => r.comboName);
}
