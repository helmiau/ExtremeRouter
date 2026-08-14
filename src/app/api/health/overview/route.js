import { getAllProviderHealth } from "open-sse/services/healthMonitor.js";
import { getBreakerStates } from "open-sse/services/circuitBreaker.js";
import { buildHealthOverview } from "open-sse/services/healthOverview.js";
import { getProviderConnections } from "@/lib/localDb";

export const dynamic = "force-dynamic";

/**
 * GET /api/health/overview — one-shot merged snapshot for the Provider Health
 * Heatmap: per-provider health aggregates (error rate, latency percentiles),
 * circuit-breaker state/cooldown, and per-connection lock/cooldown status.
 */
export async function GET() {
  const [healthList, breakerList, connections] = await Promise.all([
    getAllProviderHealth(),
    getBreakerStates(),
    getProviderConnections({ isActive: true }).catch(() => []),
  ]);

  const providers = buildHealthOverview({ healthList, breakerList, connections });
  return Response.json({ providers, generatedAt: Date.now() });
}
