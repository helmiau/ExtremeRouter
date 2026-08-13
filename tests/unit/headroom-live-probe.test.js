// @vitest-environment node
// Live regression for the "cannot activate headroom" bug: after a fresh
// managed spawn, /api/headroom/status must report running=true immediately.
// The old probe hit /health whose lazy upstream check (api.anthropic.com) can
// take seconds or hang, keeping the token-saver toggle disabled.
//
// Gated (requires headroom CLI installed):
//   RUN_HEADROOM_E2E=1 npx vitest run --config tests/vitest.config.js tests/unit/headroom-live-probe.test.js
import { describe, it, expect } from "vitest";
import { getHeadroomStatus } from "@/lib/headroom/detect";
import { stopHeadroomProxy, startHeadroomProxy } from "@/lib/headroom/process";

const RUN = process.env.RUN_HEADROOM_E2E === "1";
const maybe = RUN ? describe : describe.skip;

maybe("headroom live probe (managed proxy)", () => {
  it("reports running immediately after a fresh spawn", async () => {
    stopHeadroomProxy();
    const result = await startHeadroomProxy({ port: 8787 });
    expect(result.pid).toBeGreaterThan(0);

    // Exact path /api/headroom/status takes — must be true while the proxy's
    // upstream check is still in-flight (that is the regression).
    const status = await getHeadroomStatus("http://localhost:8787");
    expect(status.installed).toBe(true);
    expect(status.running).toBe(true);

    await stopHeadroomProxy();
  }, 30000);
});
