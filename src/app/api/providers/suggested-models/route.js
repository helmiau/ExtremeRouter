import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/models";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { FILTERS } from "./filters.js";
import {
  suggestedModelsCacheKey,
  getCachedSuggestedModels,
  setCachedSuggestedModels,
} from "@/lib/suggestedModelsCache";

export const dynamic = "force-dynamic";

/**
 * GET /api/providers/suggested-models
 *
 * Query params:
 *   type         — FILTERS key (required)
 *   url          — models endpoint URL (used only when connectionId is absent)
 *   connectionId — optional. When set, the server resolves the URL from
 *                  trusted provider registry config (not from query param)
 *                  and sends the connection's API key. This prevents SSRF —
 *                  an attacker URL can never exfiltrate the token because the
 *                  server controls both the destination and the credential.
 *
 * Used by the provider detail page to populate the "suggested models" list.
 */
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const type = searchParams.get("type");
  const connectionId = searchParams.get("connectionId");

  if (!type) {
    return NextResponse.json({ error: "Missing type" }, { status: 400 });
  }

  const filter = FILTERS[type];
  if (!filter) {
    return NextResponse.json({ error: "Unknown filter type" }, { status: 400 });
  }

  let url = null;
  let authHeader = null;

  if (connectionId) {
    // Resolve URL from trusted registry config using the connection's provider ID.
    // This prevents SSRF — the URL comes from the codebase, not from user input.
    // The API key also stays server-side (connections are sanitized before reaching the browser).
    try {
      const connection = await getProviderConnectionById(connectionId);
      if (!connection) {
        return NextResponse.json({ error: "Connection not found" }, { status: 404 });
      }
      const provider = AI_PROVIDERS[connection.provider];
      const modelsFetcher = provider?.modelsFetcher;
      if (!modelsFetcher?.url) {
        return NextResponse.json({ error: "Provider does not support model discovery" }, { status: 400 });
      }
      url = modelsFetcher.url;
      const token = connection.apiKey || connection.accessToken;
      if (token) {
        authHeader = `Bearer ${token}`;
      }
    } catch {
      return NextResponse.json({ error: "Failed to resolve provider config" }, { status: 500 });
    }
  } else {
    // Fallback: no connection, use query param URL (public catalogs).
    // This path is for providers without auth (e.g., OpenRouter free models).
    url = searchParams.get("url");
  }

  if (!url) {
    return NextResponse.json({ error: "Missing url" }, { status: 400 });
  }

  // Serve key-gated catalogs from the in-process cache when fresh: the list
  // barely changes, so avoid re-hitting upstream on every page open. The key
  // includes connectionId because different keys see different catalogs.
  const cacheKey = suggestedModelsCacheKey(url, connectionId, type);
  const cached = getCachedSuggestedModels(cacheKey);
  if (cached) {
    return NextResponse.json({ data: cached });
  }

  try {
    const headers = { Accept: "application/json" };
    if (authHeader) headers.Authorization = authHeader;

    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) {
      return NextResponse.json({ data: [] });
    }
    const json = await res.json();
    const raw = json.data ?? json.models ?? json;
    const data = filter(Array.isArray(raw) ? raw : []);
    setCachedSuggestedModels(cacheKey, data);
    return NextResponse.json({ data });
  } catch {
    return NextResponse.json({ data: [] });
  }
}
