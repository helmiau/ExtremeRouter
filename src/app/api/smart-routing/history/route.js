import { queryHistory, getDistinctCombos } from "@/lib/db/repos/smartRoutingRunsRepo.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/smart-routing/history — paginated history of persisted smart-routing
 * runs from the DB, with filters (reason, combo, status, date range).
 *
 * Query params: page, pageSize, comboName, status, reason, startDate, endDate.
 * Response: { runs, pagination, combos } — `combos` is the distinct combo-name
 * list used to populate the filter select.
 *
 * Always returns JSON: any DB error becomes a { error } body so the dashboard
 * client can surface the real cause instead of crashing on an empty body.
 */
export async function GET(request) {
  try {
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
  } catch (error) {
    console.error("smart-routing history query failed:", error?.message || error);
    return Response.json(
      { error: "Failed to load smart-routing history" },
      { status: 500 },
    );
  }
}
