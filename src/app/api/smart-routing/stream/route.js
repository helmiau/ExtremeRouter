import { smartRoutingEmitter, getRecentSmartRuns, hydrateSmartRunsFromDb } from "open-sse/services/smartRoutingTelemetry.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/smart-routing/stream — Server-Sent Events stream of Smart Routing
 * combo runs. Pushes each routing decision (reason + selected pool + excluded
 * cookies) as it happens, plus a 25s keepalive.
 */
export async function GET() {
  const encoder = new TextEncoder();
  const state = { closed: false, keepalive: null, onEvent: null };

  const stream = new ReadableStream({
    async start(controller) {
      // Initial snapshot: hydrate persisted history (runs survive restarts),
      // then send recent runs so the dashboard renders immediately.
      try {
        await hydrateSmartRunsFromDb({ limit: 50 });
        const initial = getRecentSmartRuns(20);
        controller.enqueue(encoder.encode(`retry: 3000\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "snapshot", runs: initial })}\n\n`));
      } catch {
        // ignore
      }

      // Live event relay with backpressure check (drop transient updates when
      // the client is slow — the next event will catch up).
      state.onEvent = (payload) => {
        if (state.closed) return;
        if (controller.desiredSize !== null && controller.desiredSize <= 0) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          cleanup();
        }
      };

      smartRoutingEmitter.on("smart:start", state.onEvent);
      smartRoutingEmitter.on("smart:route", state.onEvent);
      smartRoutingEmitter.on("smart:served", state.onEvent);
      smartRoutingEmitter.on("smart:complete", state.onEvent);
      smartRoutingEmitter.on("smart:error", state.onEvent);

      // Keepalive to prevent proxy/load-balancer idle timeout.
      state.keepalive = setInterval(() => {
        if (state.closed) { clearInterval(state.keepalive); return; }
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          cleanup();
        }
      }, 25000);
    },

    cancel() {
      cleanup();
    },
  });

  function cleanup() {
    state.closed = true;
    if (state.onEvent) {
      smartRoutingEmitter.off("smart:start", state.onEvent);
      smartRoutingEmitter.off("smart:route", state.onEvent);
      smartRoutingEmitter.off("smart:served", state.onEvent);
      smartRoutingEmitter.off("smart:complete", state.onEvent);
      smartRoutingEmitter.off("smart:error", state.onEvent);
    }
    if (state.keepalive) clearInterval(state.keepalive);
  }

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // Tell nginx/proxies not to buffer the SSE stream (buffering delays events).
      "X-Accel-Buffering": "no",
    },
  });
}
