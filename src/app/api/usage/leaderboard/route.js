import { NextResponse } from "next/server";
import { getUsageStats, getUsageHistory } from "@/lib/usageDb";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { getProviderNodes } from "@/lib/db/repos/nodesRepo";
import { percentile, aggregateModelLatency } from "@/lib/usageStats";

export const dynamic = "force-dynamic";

/**
 * GET /api/usage/leaderboard?period=7d
 *
 * Returns provider performance ranking aggregated from usage data.
 * Each row: provider, displayName, icon, color, requests, tokens, cost,
 * avgTtft, avgLatency, p95Latency, successRate, errorCount.
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";

    const [stats, history, nodes] = await Promise.all([
      getUsageStats(period),
      getUsageHistory({ period }),
      getProviderNodes(),
    ]);

    // Build a name/icon/color map from both built-in providers AND custom nodes
    // (openai-compatible-xxx, anthropic-compatible-xxx) so the leaderboard
    // shows human-readable names instead of UUIDs.
    const nodeMap = {};
    for (const node of nodes) {
      nodeMap[node.id] = { name: node.name || node.id, color: "#6b7280" };
    }

    // Build TTFT + latency aggregates per provider (leaderboard) and per model
    // (modelLatency — the combo simulator consumes this for expected latency per
    // combo member). Keyed by fullModel "provider/model".
    const ttftByProvider = {};
    const latencyByProvider = {};
    const errorsByProvider = {};

    for (const row of history) {
      const p = row.provider || "unknown";
      if (row.latencyTtftMs > 0) {
        if (!ttftByProvider[p]) ttftByProvider[p] = [];
        ttftByProvider[p].push(row.latencyTtftMs);
      }
      if (row.latencyTotalMs > 0) {
        if (!latencyByProvider[p]) latencyByProvider[p] = [];
        latencyByProvider[p].push(row.latencyTotalMs);
      }
      if (row.status && row.status !== "ok") {
        errorsByProvider[p] = (errorsByProvider[p] || 0) + 1;
      }
    }

    const mean = (arr) => (arr.length > 0 ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);

    // Per-model latency aggregates (nearest-rank percentiles, same convention as
    // the provider rows and usageRepo). sampleCount lets consumers render
    // "insufficient data" instead of trusting a p95 built on a handful of rows.
    const modelLatency = Object.values(aggregateModelLatency(history))
      .sort((a, b) => b.sampleCount - a.sampleCount);

    // Merge stats.byProvider with TTFT/latency/error data.
    const byProvider = stats.byProvider || {};
    const leaderboard = Object.entries(byProvider)
      .map(([id, data]) => {
        const info = AI_PROVIDERS[id] || nodeMap[id] || {};
        const ttfts = ttftByProvider[id] || [];
        const latencies = latencyByProvider[id] || [];
        const total = data.requests || 0;
        const errors = errorsByProvider[id] || 0;

        const sortedLat = [...latencies].sort((a, b) => a - b);

        return {
          provider: id,
          displayName: info.name || id,
          icon: info.icon || "smart_toy",
          color: info.color || "#6b7280",
          requests: total,
          promptTokens: data.promptTokens || 0,
          completionTokens: data.completionTokens || 0,
          totalTokens: (data.promptTokens || 0) + (data.completionTokens || 0),
          cost: data.cost || 0,
          avgTtft: mean(ttfts),
          avgLatency: mean(latencies),
          p50Latency: percentile(sortedLat, 50),
          p95Latency: percentile(sortedLat, 95),
          // How many non-zero latency samples back the percentiles — lets the UI
          // show "insufficient data" instead of trusting a p95 from 3 samples.
          latencySampleCount: latencies.length,
          successRate: total > 0 ? ((total - errors) / total) * 100 : 100,
          errorCount: errors,
        };
      })
      .sort((a, b) => b.requests - a.requests);

    return NextResponse.json({ leaderboard, modelLatency, period });
  } catch (error) {
    console.error("[API] Failed to get leaderboard:", error);
    return NextResponse.json({ error: "Failed to fetch leaderboard" }, { status: 500 });
  }
}
