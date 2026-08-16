import { getRecentSmartRuns, hydrateSmartRunsFromDb } from "open-sse/services/smartRoutingTelemetry.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/smart-routing/active — one-shot snapshot of recent smart-routing
 * runs. Used for dashboard initial load without SSE. Hydrates persisted
 * history from the DB first so runs survive server restarts.
 */
export async function GET() {
  await hydrateSmartRunsFromDb({ limit: 50 });
  return Response.json({ runs: getRecentSmartRuns(20) });
}
