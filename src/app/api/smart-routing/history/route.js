import { queryHistory, getDistinctCombos } from "src/lib/db/repos/smartRoutingRunsRepo.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/smart-routing/history — paginated history of persisted smart-routing
 * runs from the DB, with filters (reason, combo, status, date range).
 *
 * Query params: page, pageSize, comboName, status, reason, startDate, endDate.
 * Response: { runs, pagination, combos } — `combos` is the distinct combo-name
 * list used to populate the filter select.
 */
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const params = Object.fromEntries(searchParams.entries());

  const [result, combos] = await Promise.all([
    queryHistory({
      page: params.page,
      pageSize: params.pageSize,
      comboName: params.comboName || undefined,
      status: params.status || undefined,
      reason: params.reason || undefined,
      startDate: params.startDate || undefined,
      endDate: params.endDate || undefined,
    }),
    getDistinctCombos(),
  ]);

  return Response.json({ ...result, combos });
}
