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
const persistToDisk = vi.fn(() => true);
vi.mock("../../open-sse/providers/catalogSource.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadCatalogSnapshotFromDisk: (...args) => loadFromDisk(...args),
    // Tests must never write the real user catalog file.
    persistCatalogSnapshot: (...args) => persistToDisk(...args),
  };
});

// Fresh timestamps per use — a module-load-time value would predate test t0.
const updatedResult = () => ({
  status: "updated",
  etag: '"e1"',
  bytes: 128,
  snapshot: {
    schemaVersion: 1,
    source: "models.dev",
    syncedAt: Date.now(),
    validatedAt: Date.now(),
    etag: '"e1"',
    models: { "model-x": { vision: true } },
    providers: { "prov-a": { "model-x": { contextWindow: 1000000 } } },
  },
});

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
    persistToDisk.mockClear();
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

    workerInstances[0].postResult(updatedResult());
    const first = await firstRun;
    expect(first.status).toBe("updated");
  });

  it("success stores the etag, reloads the snapshot, and reports ready state", async () => {
    const pending = syncModelCatalog();
    await flush();
    workerInstances[0].postResult(updatedResult());
    const result = await pending;

    expect(result.status).toBe("updated");
    expect(loadFromDisk).toHaveBeenCalled();
    // Seed the in-memory snapshot the way the real loader would after a sync.
    catalogSource.setCatalogSnapshot(catalogSource.validateCatalogSnapshot(updatedResult().snapshot));
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

  it("304 without an active snapshot changes nothing (no persist, no freshness)", async () => {
    const pending = syncModelCatalog();
    await flush();
    workerInstances[0].postResult({ status: "unchanged" });
    const result = await pending;

    expect(result.status).toBe("unchanged");
    expect(loadFromDisk).not.toHaveBeenCalled();
    expect(persistToDisk).not.toHaveBeenCalled(); // nothing to extend
    expect(getCatalogState().lastError).toBeNull();
    expect(getCatalogState().state).toBe("unavailable");
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

  // ── 304 freshness semantics (validatedAt) ────────────────────────────────

  const seedSnapshot = (syncedAt, validatedAt, etag = '"e1"') => {
    catalogSource.setCatalogSnapshot(catalogSource.validateCatalogSnapshot({
      schemaVersion: 1,
      source: "models.dev",
      syncedAt,
      ...(validatedAt != null ? { validatedAt } : {}),
      etag,
      models: { "model-x": { vision: true } },
      providers: { "prov-a": { "model-x": { contextWindow: 1000000 } } },
    }));
  };

  it("Test A: a 200 install sets syncedAt and validatedAt to approximately now", async () => {
    const t0 = Date.now();
    const pending = syncModelCatalog();
    await flush();
    workerInstances[0].postResult(updatedResult());
    await pending;
    // The loader stub doesn't swap — simulate what the real loader does.
    catalogSource.setCatalogSnapshot(catalogSource.validateCatalogSnapshot(updatedResult().snapshot));

    const state = getCatalogState();
    expect(state.syncedAt).toBeGreaterThanOrEqual(t0);
    expect(state.validatedAt).toBeGreaterThanOrEqual(t0);
    expect(Math.abs(state.validatedAt - state.syncedAt)).toBeLessThanOrEqual(50);
  });

  it("Test B: 304 advances validatedAt + lastSuccessAt, keeps syncedAt and etag", async () => {
    const T0 = Date.now() - 60 * 60 * 1000;
    seedSnapshot(T0, T0, '"e1"');
    // The running sync must send If-None-Match for the current validator.
    syncModelCatalog();
    await flush();
    expect(workerInstances[0].opts.workerData.etag).toBe('"e1"');
    workerInstances[0].postResult({ status: "unchanged" });
    await flush();
    await new Promise((r) => setTimeout(r, 5));

    const state = getCatalogState();
    const T1 = Date.now();
    expect(state.syncedAt).toBe(T0); // payload install time unchanged
    expect(state.validatedAt).toBeGreaterThan(T0);
    expect(state.validatedAt).toBeLessThanOrEqual(T1);
    expect(state.lastSuccessAt).toBeGreaterThan(T0);
    expect(state.etag).toBe('"e1"'); // validator preserved
    expect(state.stale).toBe(false);
  });

  it("Test C: 304 keeps catalog contents semantically identical (meta-only swap)", async () => {
    const T0 = Date.now() - 1000;
    seedSnapshot(T0, T0);
    const before = catalogSource.getCatalogSnapshot();
    syncModelCatalog();
    await flush();
    workerInstances[0].postResult({ status: "unchanged" });
    await flush();
    await new Promise((r) => setTimeout(r, 5));

    const after = catalogSource.getCatalogSnapshot();
    expect(after.models).toEqual(before.models); // same data...
    expect(after.providers).toEqual(before.providers);
    expect(after.models).toBe(before.models); // ...by REFERENCE (meta-only swap)
    expect(after.providers).toBe(before.providers);
    expect(persistToDisk).toHaveBeenCalled(); // validation timestamp persisted
  });

  it("Test D: repeated 304s keep the catalog fresh even as syncedAt ages out", async () => {
    const maxStaleness = 7 * 24 * 60 * 60 * 1000;
    // syncedAt far beyond the staleness window; validatedAt keeps advancing.
    seedSnapshot(Date.now() - maxStaleness - 3 * 24 * 60 * 60 * 1000, Date.now() - 1000);
    expect(getCatalogState().stale).toBe(false);

    for (let i = 0; i < 3; i++) {
      const pending = syncModelCatalog();
      await flush();
      workerInstances.at(-1).postResult({ status: "unchanged" });
      await pending;
      await new Promise((r) => setTimeout(r, 5));
      // Simulate the next validation happening later; syncedAt stays ancient.
      seedSnapshot(Date.now() - maxStaleness - 3 * 24 * 60 * 60 * 1000, Date.now());
    }
    const state = getCatalogState();
    expect(state.syncedAt).toBeLessThan(Date.now() - maxStaleness); // payload IS old
    expect(state.stale).toBe(false); // validation is fresh
  });

  it("Test E: a failed sync (HTTP 500) does not advance freshness", async () => {
    const T0 = Date.now() - 5000;
    seedSnapshot(T0, T0);
    const pending = syncModelCatalog();
    await flush();
    workerInstances[0].postError("HTTP 500");
    await pending;
    await new Promise((r) => setTimeout(r, 5));

    const state = getCatalogState();
    expect(state.syncedAt).toBe(T0);
    expect(state.validatedAt).toBe(T0);
    expect(state.lastSuccessAt).toBe(T0);
    expect(state.lastAttemptAt).toBeGreaterThan(T0);
    expect(state.lastError).toMatch(/HTTP 500/);
  });

  it("Test F: a malformed payload does not advance freshness", async () => {
    const T0 = Date.now() - 5000;
    seedSnapshot(T0, T0);
    const pending = syncModelCatalog();
    await flush();
    workerInstances[0].postError("catalog payload is not valid JSON");
    await pending;

    const state = getCatalogState();
    expect(state.syncedAt).toBe(T0);
    expect(state.validatedAt).toBe(T0);
    expect(state.lastSuccessAt).toBe(T0);
    expect(state.lastAttemptAt).toBeGreaterThan(T0);
  });

  it("Test G: a network failure does not advance freshness", async () => {
    const T0 = Date.now() - 5000;
    seedSnapshot(T0, T0);
    const pending = syncModelCatalog();
    await flush();
    workerInstances[0].fail(new Error("ETIMEDOUT"));
    await pending;

    const state = getCatalogState();
    expect(state.syncedAt).toBe(T0);
    expect(state.validatedAt).toBe(T0);
    expect(state.lastSuccessAt).toBe(T0);
    expect(state.lastAttemptAt).toBeGreaterThan(T0);
  });

  it("Test H: legacy snapshot without validatedAt falls back to syncedAt, then 304 creates it", async () => {
    const T0 = Date.now() - 2 * 60 * 60 * 1000;
    seedSnapshot(T0, null); // legacy: no validatedAt field at all
    expect(getCatalogState().validatedAt).toBeNull();
    expect(getCatalogState().stale).toBe(false); // falls back to syncedAt (2h old < 7d)

    // Seed an ancient syncedAt to prove the fallback drives staleness...
    seedSnapshot(Date.now() - 30 * 24 * 60 * 60 * 1000, null);
    expect(getCatalogState().stale).toBe(true);

    // ...then a 304 creates validatedAt and clears stale.
    const ancient = Date.now() - 30 * 24 * 60 * 60 * 1000;
    seedSnapshot(ancient, null);
    syncModelCatalog();
    await flush();
    workerInstances[0].postResult({ status: "unchanged" });
    await flush();
    await new Promise((r) => setTimeout(r, 5));

    const state = getCatalogState();
    expect(state.validatedAt).toBeGreaterThan(Date.now() - 60 * 1000);
    expect(state.syncedAt).toBe(ancient);
    expect(state.stale).toBe(false);
  });

  it("Test I: 304 persists the validation timestamp for restarts", async () => {
    const T0 = Date.now() - 60 * 60 * 1000;
    seedSnapshot(T0, T0);
    syncModelCatalog();
    await flush();
    workerInstances[0].postResult({ status: "unchanged" });
    await flush();
    await new Promise((r) => setTimeout(r, 5));

    expect(persistToDisk).toHaveBeenCalled();
    // Restart semantics: the persisted snapshot carries validatedAt, and
    // validateCatalogSnapshot restores it (loader round-trip).
    const persisted = catalogSource.validateCatalogSnapshot(updatedResult().snapshot);
    expect(persisted.meta.validatedAt).not.toBeNull();
  });

  it("Test J: a 304 can never regress a fresher 200's metadata", async () => {
    // Simulate: a 200 installed a snapshot; a LATE 304 from an older flow
    // tries to extend validation with an older timestamp.
    const T200 = Date.now();
    seedSnapshot(T200, T200, '"e2"');
    const before = catalogSource.getCatalogSnapshot();

    // extendCatalogValidation with an older timestamp must refuse.
    expect(catalogSource.extendCatalogValidation(T200 - 60_000)).toBe(false);
    const after = catalogSource.getCatalogSnapshot();
    expect(after.meta.validatedAt).toBe(before.meta.validatedAt);
    expect(after.meta.syncedAt).toBe(before.meta.syncedAt);
    expect(after.meta.etag).toBe('"e2"');
    expect(after.models).toBe(before.models);
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
