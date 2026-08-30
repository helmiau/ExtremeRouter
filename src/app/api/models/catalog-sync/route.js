import { NextResponse } from "next/server";
import { getCatalogState, syncModelCatalog } from "@/lib/modelCatalog/sync";

/**
 * GET /api/models/catalog-sync — Dynamic Model Capability Catalog status.
 *
 * Answers the admin questions: enabled? state (ready/syncing/stale/
 * unavailable)? last success/attempt? last error? how many models/providers
 * are loaded? Sits under /api/models so the dashboard auth model applies.
 */
export async function GET() {
  return NextResponse.json(getCatalogState());
}

/**
 * POST /api/models/catalog-sync — run a sync now instead of waiting for the
 * scheduled timer. Returns 503 when a sync is already running (never runs two
 * concurrently); the scheduled lifecycle is untouched either way.
 */
export async function POST() {
  const result = await syncModelCatalog();
  if (!result) {
    const state = getCatalogState();
    return NextResponse.json(
      { error: state.running ? "sync already in progress" : (state.lastError || "sync unavailable (disabled or failed); keeping last-known-good catalog") },
      { status: 503 },
    );
  }
  return NextResponse.json({
    success: true,
    status: result.status,
    etag: result.etag ?? null,
    models: result.snapshot ? Object.keys(result.snapshot.models).length : 0,
    providers: result.snapshot ? Object.keys(result.snapshot.providers).length : 0,
    state: getCatalogState(),
  });
}
