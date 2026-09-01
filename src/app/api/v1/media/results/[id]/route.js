import { errorResponse } from "open-sse/utils/error.js";
import { resolveMediaResult } from "open-sse/services/mediaResultStore.js";
import { getProviderCredentials } from "@/sse/services/auth.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/media/results/:id
 * Streams/proxies a registered provider media artifact to the client without ever
 * exposing the provider URL, task id, or credentials. Provider credentials are
 * resolved server-side and attached to a defensive (SSRF-hardened) fetch.
 *
 * Error codes are media-specific (not the generic 404 "model_not_found"):
 *   404 → media_result_not_found   unknown/unguessable id
 *   410 → media_result_expired     registration TTL elapsed
 *   502 → media_result_unavailable source artifact missing or fetch failed
 */
export async function GET(request, { params }) {
  const { id } = await params;

  const result = await resolveMediaResult(id, { getCredentials: getProviderCredentials });

  if (!result.ok) {
    const code = {
      404: "media_result_not_found",
      410: "media_result_expired",
      502: "media_result_unavailable",
    }[result.status];
    return errorResponse(result.status, result.message, code);
  }

  return new Response(result.buffer, {
    status: 200,
    headers: {
      "Content-Type": result.mimeType,
      "Content-Length": String(result.buffer.length),
      // Conservative caching — provider artifacts are temporary; we never add
      // aggressive caching for authenticated/provider-backed media.
      "Cache-Control": "private, max-age=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
}