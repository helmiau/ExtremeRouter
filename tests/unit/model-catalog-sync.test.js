import { describe, it, expect, vi, beforeEach } from "vitest";

// Catalog sync scheduler behavior (§32-F): overlapping syncs coalesce to one
// worker run; worker failures keep last-known-good state and surface in
// getCatalogState(); success swaps the snapshot via the disk loader.

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));
vi.mock("@/shared/utils/ssrfGuard.js", () => ({ assertPublicUrl: vi.fn() }));

// Minimal registry snapshot for collectRegistryEntries.
vi.mock("open-sse/providers/registry/index.js", () => ({
  default: [{ id: "prov-a", models: [{ id: "model-x", contextWindow: 128000 }] }],
}));

// Intercept worker spawning: instances are driven manually by the tests.
const workerInstances = [];
vi.mock("node:worker_threads", () => ({
  Worker: class {
    constructor(file, opts) {
      this.file = file;
      this.opts = opts;
      this.handlers = {};
      workerInstances.push(this);
    }
    on(event, fn) {
      this.handlers[event] = fn;
      return this;
    }
    terminate() { return Promise.resolve(); }
    postResult(result) { this.handlers.message?.({ ok: true, result }); }
    postError(message) { this.handlers.message?.({ ok: false, error: message }); }
    fail(err) { this.handlers.error?.(err); }
  },
}));

// The disk loader touches the real DATA_DIR file — stub it and observe calls.
const loadFromDisk = vi.fn(() => true);
vi.mock("../../open-sse/providers/catalogSource.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadCatalogSnapshotFromDisk: (...args) => loadFromDisk(...args),
  };
});

const UPDATED = {
  status: "updated",
  etag: '"e1"',
  bytes: 128,
  snapshot: {
    schemaVersion: 1,
    source: "models.dev",
    syncedAt: Date.now(),
    etag: '"e1"',
    models: { "model-x": { vision: true } },
    providers: { "prov-a": { "model-x": { contextWindow: 1000000 } } },
  },
};

const flush = () => new Promise((r) => setTimeout(r, 5));

const { syncModelCatalog, getCatalogState, __resetSyncStateForTests } =
  await import("../../src/lib/modelCatalog/sync.js");
const catalogSource = await import("../../open-sse/providers/catalogSource.js");
const { getCapabilitiesForModel } = await import("open-sse/providers/capabilities.js");

// Install the real in-memory reader so resolver assertions see the snapshot
// (same injection the server startup performs).
catalogSource.installCatalogSource().catch(() => {});

describe("catalog sync scheduler", () => {
  beforeEach(() => {
    workerInstances.length = 0;
    loadFromDisk.mockClear();
    __resetSyncStateForTests();
    catalogSource.setCatalogSnapshot(null);
  });

  it("coalesces overlapping syncs: the second call returns null while one runs", async () => {
    const firstRun = syncModelCatalog();
    await flush();

    // One worker spawned so far; hold it in-flight.
    expect(workerInstances).toHaveLength(1);
    const second = await syncModelCatalog();
    expect(second).toBeNull(); // running → coalesced
    expect(workerInstances).toHaveLength(1); // never a second concurrent worker

    workerInstances[0].postResult(UPDATED);
    const first = await firstRun;
    expect(first.status).toBe("updated");
  });

  it("success stores the etag, reloads the snapshot, and reports ready state", async () => {
    const pending = syncModelCatalog();
    await flush();
    workerInstances[0].postResult(UPDATED);
    const result = await pending;

    expect(result.status).toBe("updated");
    expect(loadFromDisk).toHaveBeenCalled();
    // Seed the in-memory snapshot the way the real loader would after a sync.
    catalogSource.setCatalogSnapshot(catalogSource.validateCatalogSnapshot(UPDATED.snapshot));
    const state = getCatalogState();
    expect(state.enabled).toBe(true);
    expect(state.etag).toBe('"e1"');
    expect(state.lastError).toBeNull();
    expect(state.lastSuccessAt).not.toBeNull();
    expect(state.state).toBe("ready");
    expect(state.stale).toBe(false);
    expect(state.modelCount).toBe(1);
  });

  it("worker failure keeps last-known-good state and reports the error", async () => {
    const pending = syncModelCatalog();
    await flush();
    workerInstances[0].postError("HTTP 503");
    const result = await pending;

    expect(result).toBeNull();
    const state = getCatalogState();
    expect(state.lastError).toMatch(/HTTP 503/);
    // The disk loader was never invoked — last-known-good untouched.
    expect(loadFromDisk).not.toHaveBeenCalled();
  });

  it("304 unchanged completes without reloading the snapshot", async () => {
    const pending = syncModelCatalog();
    await flush();
    workerInstances[0].postResult({ status: "unchanged" });
    const result = await pending;

    expect(result.status).toBe("unchanged");
    expect(loadFromDisk).not.toHaveBeenCalled();
    expect(getCatalogState().lastError).toBeNull();
  });

  it("worker throws / non-zero exit are captured as sync failures", async () => {
    const pending = syncModelCatalog();
    await flush();
    workerInstances[0].fail(new Error("worker OOM"));
    const result = await pending;
    expect(result).toBeNull();
    expect(getCatalogState().lastError).toMatch(/worker OOM/);
  });

  it("worker payload carries the registry snapshot + config for the delta", async () => {
    const pending = syncModelCatalog();
    await flush();
    workerInstances[0].postResult({ status: "unchanged" });
    await pending;

    const opts = workerInstances[0].opts.workerData; // mock captures the Worker constructor wrapper
    expect(opts.url).toMatch(/^https:\/\//);
    expect(opts.entries).toEqual([
      {
        provider: "prov-a",
        model: "model-x",
        contextLength: 128000,
        current: expect.objectContaining({ contextWindow: 128000 }),
      },
    ]);
    expect(opts.minModalityShare).toBe(0.5);
    expect(opts.limitTolerance).toBe(0.1);
  });

  it("stale detection: an old snapshot reports stale but stays usable", async () => {
    catalogSource.setCatalogSnapshot(catalogSource.validateCatalogSnapshot({
      schemaVersion: 1,
      source: "models.dev",
      syncedAt: Date.now() - 30 * 24 * 60 * 60 * 1000, // 30 days old
      models: { "m/v": { vision: true } },
      providers: {},
    }));
    const state = getCatalogState();
    expect(state.stale).toBe(true);
    expect(state.state).toBe("stale");
    // Staleness never disables the resolver — lookups still serve catalog data.
    expect(getCapabilitiesForModel("openai", "m/v").vision).toBe(true);
  });
});
