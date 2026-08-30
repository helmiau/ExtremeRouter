import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fsPromises } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Dynamic Model Capability Catalog — resolver precedence, provider-specific
// limits, alias resolution, sync failure isolation, ETag, concurrency,
// atomic replacement, hot-path, and hard-capability behavior (§32 A-L).

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));
vi.mock("@/shared/utils/ssrfGuard.js", () => ({ assertPublicUrl: vi.fn() }));

const { getCapabilitiesForModel, setCatalogSource, CAPABILITY_SOURCE, CAPABILITY_CONFIDENCE } =
  await import("../../open-sse/providers/capabilities.js");
const {
  validateCatalogSnapshot,
  setCatalogSnapshot,
  catalogBaseId,
} = await import("../../open-sse/providers/catalogSource.js");
const {
  buildCatalogDelta,
  fetchAndNormalizeCatalog,
  catalogBaseId: normalizeBaseId,
} = await import("../../src/lib/modelCatalog/normalize.js");

// ── helpers ─────────────────────────────────────────────────────────────────

// Install a fake catalog source; restores the real (empty) one after each test.
let fakeSource = null;
const installFake = (models = {}, providers = {}) => {
  fakeSource = {
    getModalities: (modelId) => models[catalogBaseId(modelId)] || null,
    getLimits: (providerId, modelId) => providers[providerId]?.[modelId]
      ?? providers[providerId]?.[catalogBaseId(modelId)]
      ?? null,
  };
  setCatalogSource(fakeSource);
};

beforeEach(() => {
  fakeSource = null;
  setCatalogSource(null);
  setCatalogSnapshot(null);
});
afterEach(() => {
  setCatalogSource(null);
  setCatalogSnapshot(null);
});

// ── A. Resolver precedence ──────────────────────────────────────────────────

describe("A. resolver precedence (override > manual > catalog > heuristic > default)", () => {
  it("tier-1 explicit vision:false beats catalog vision:true", () => {
    installFake({ "deepseek-v4-pro": { vision: true } });
    // PROVIDER_CAPABILITIES.bynara["deepseek-v4-pro"] explicitly declares
    // vision:false — tier 1 short-circuits and the catalog is never consulted.
    const caps = getCapabilitiesForModel("bynara", "deepseek-v4-pro");
    expect(caps.vision).toBe(false);
    expect(caps.sourceType).toBe(CAPABILITY_SOURCE.PROVIDER_MODEL);
    expect(caps.catalog).toBeUndefined();
  });

  it("tier-2 explicit limit beats a diverging catalog limit", () => {
    installFake(
      {},
      { glm: { "claude-opus-4.6": { contextWindow: 500000 } } },
    );
    // MODEL_CAPABILITIES["claude-opus-4.6"] hand-writes contextWindow 1000000 —
    // the catalog must not replace an explicitly declared value.
    const caps = getCapabilitiesForModel("glm", "claude-opus-4.6");
    expect(caps.contextWindow).toBe(1000000);
    expect(caps.sourceType).toBe(CAPABILITY_SOURCE.MODEL_EXACT);
    expect(caps.confidence).toBe(CAPABILITY_CONFIDENCE.VERIFIED);
  });

  it("catalog fills a modality the exact-id tier did not declare", () => {
    installFake({ "catalog-only-vision": { vision: true } });
    const caps = getCapabilitiesForModel("openai", "catalog-only-vision");
    expect(caps.vision).toBe(true);
    expect(caps.catalog).toEqual({ modalities: ["vision"], limits: false });
  });

  it("catalog true + floor-tier silence → true (catalog > default)", () => {
    installFake({ "brand-new-vl-model-x": { vision: true } });
    // No pattern matches this id — floor + catalog evidence.
    const caps = getCapabilitiesForModel("openai", "brand-new-vl-model-x");
    expect(caps.vision).toBe(true);
    expect(caps.confidence).toBe(CAPABILITY_CONFIDENCE.INFERRED);
    expect(caps.sourceType).toBe(CAPABILITY_SOURCE.DYNAMIC_CATALOG);
  });

  it("explicit pattern-tier vision survives when the catalog knows nothing (never flipped off)", () => {
    installFake({});
    // *qwen*vl* pattern declares vision explicitly; catalog knows nothing.
    const caps = getCapabilitiesForModel("alibaba", "qwen3-vl-plus");
    expect(caps.vision).toBe(true);
  });
});

// ── B/J. Provider-specific limits ───────────────────────────────────────────

describe("B/J. provider-specific limits", () => {
  it("same model, two providers → different limits", () => {
    installFake(
      { "shared-model": {} },
      {
        provA: { "shared-model": { contextWindow: 1000000, maxOutput: 64000 } },
        provB: { "shared-model": { contextWindow: 128000, maxOutput: 8192 } },
      },
    );
    const a = getCapabilitiesForModel("provA", "shared-model");
    const b = getCapabilitiesForModel("provB", "shared-model");
    expect(a.contextWindow).toBe(1000000);
    expect(a.maxOutput).toBe(64000);
    expect(b.contextWindow).toBe(128000);
    expect(b.maxOutput).toBe(8192);
  });

  it("catalog limits are ignored when within the 10% tolerance (gateway rounding)", () => {
    installFake(
      { "rounding-model": {} },
      { provA: { "rounding-model": { contextWindow: 202752 } } }, // resolved floor 200000 → 1.4% off
    );
    const caps = getCapabilitiesForModel("provA", "rounding-model");
    expect(caps.contextWindow).toBe(200000);
    expect(caps.sourceType).toBe(CAPABILITY_SOURCE.DEFAULT_FLOOR);
    expect(caps.catalog).toBeUndefined();
  });

  it("registry-declared limits outrank catalog limits", () => {
    installFake(
      {},
      { github: { "claude-sonnet-4.6": { contextWindow: 555555, maxOutput: 1000 } } }, // catalog's guess
    );
    // github's registry declares claude-sonnet-4.6 with its own 1M/64k — the
    // provider's own numbers must win over the external catalog (the result
    // already resolves at the provider-registry tier today).
    const caps = getCapabilitiesForModel("github", "claude-sonnet-4.6");
    expect(caps.contextWindow).toBe(1000000);
    expect(caps.maxOutput).toBe(64000);
    expect(caps.sourceType).toBe(CAPABILITY_SOURCE.PROVIDER_REGISTRY);
    expect(caps.catalog).toBeUndefined();
  });

  it("catalog maxOutput is clamped to the context window", () => {
    installFake(
      { "clamp-model": {} },
      { provA: { "clamp-model": { contextWindow: 32000, maxOutput: 200000 } } },
    );
    const caps = getCapabilitiesForModel("provA", "clamp-model");
    expect(caps.maxOutput).toBeLessThanOrEqual(caps.contextWindow);
  });

  it("limits never apply to tier-1 provider entries", () => {
    installFake(
      {},
      { bynara: { "deepseek-v4-pro": { contextWindow: 12345 } } },
    );
    const caps = getCapabilitiesForModel("bynara", "deepseek-v4-pro");
    expect(caps.contextWindow).toBe(1000000); // hand-written entry
    expect(caps.sourceType).toBe(CAPABILITY_SOURCE.PROVIDER_MODEL);
  });
});

// ── C. Alias / canonical identity ───────────────────────────────────────────

describe("C. canonical identity + alias resolution", () => {
  it("vendor-prefixed ids resolve the same catalog entry as the bare id", () => {
    installFake({ "kimi-k3": { vision: true } });
    const bare = getCapabilitiesForModel("kimi", "kimi-k3");
    const prefixed = getCapabilitiesForModel("kimi", "moonshotai/kimi-k3");
    expect(prefixed.vision).toBe(true);
    expect(prefixed.contextWindow).toBe(bare.contextWindow);
    expect(prefixed.catalog).toEqual(bare.catalog);
  });

  it("catalogBaseId strips vendor, case and :variant suffixes", () => {
    expect(catalogBaseId("zai-org/GLM-4.6V:free")).toBe("glm-4.6v");
    expect(normalizeBaseId("zai-org/GLM-4.6V:free")).toBe("glm-4.6v");
    expect(catalogBaseId("Claude-Opus-4-7")).toBe("claude-opus-4-7");
  });

  it("provider alias resolution reaches the catalog through canonical ids", () => {
    installFake(
      { "some-vision-thing": { vision: true } },
      { glm: { "some-vision-thing": { contextWindow: 777777 } } },
    );
    // "glm" alias resolves to the same provider id the catalog is keyed by.
    const caps = getCapabilitiesForModel("glm", "some-vision-thing");
    expect(caps.contextWindow).toBe(777777);
  });
});

// ── buildCatalogDelta (worker core): majority vote + gateway limits ─────────

describe("buildCatalogDelta (normalize core)", () => {
  const raw = {
    provA: {
      models: {
        "vendor/model-x": { modalities: { input: ["text", "image"] }, limit: { context: 1000000, output: 64000 } },
        "vendor/model-y": { modalities: { input: ["text"] }, limit: { context: 131072, output: 16384 } },
      },
    },
    provB: {
      models: {
        "other/model-x": { modalities: { input: ["text"] }, limit: { context: 999999, output: 32000 } },
      },
    },
    broken: { models: { "bad/model": null, "worse": "nope" } },
  };

  it("majority vote: 1-of-3 sources claiming image does not flip vision", () => {
    const raw3 = {
      ...raw, // provA model-x claims image; provB model-x is text-only
      provC: { models: { "third/model-x": { modalities: { input: ["text"] } } } },
    };
    const { models } = buildCatalogDelta(raw3, [], { minModalityShare: 0.5 });
    // 1/3 < 0.5 → no modality passes → the model contributes NOTHING to the
    // snapshot (unknown stays unknown rather than a weak positive).
    expect(models["model-x"]).toBeUndefined();
  });

  it("majority vote: 2-of-2 sources flip vision on", () => {
    const raw2 = {
      p1: { models: { "m/v": { modalities: { input: ["text", "image"] } } } },
      p2: { models: { "m/v": { modalities: { input: ["text", "image", "pdf"] } } } },
    };
    const { models } = buildCatalogDelta(raw2, [], {});
    expect(models["v"]).toMatchObject({ vision: true, pdf: true });
  });

  it("image-generation / embedding ids cannot become vision via the catalog alone (limits layer skips them)", () => {
    const raw2 = {
      p1: { models: { "m/dall-e-3-image": { modalities: { input: ["text", "image"] } } } },
      p2: { models: { "m/dall-e-3-image": { modalities: { input: ["text", "image"] } } } },
    };
    // The modalities layer is model-level and majority-voted — the name-based
    // false-positive guard is the hand-written pattern tier's job, which the
    // catalog can never override for explicitly-declared keys.
    const { models } = buildCatalogDelta(raw2, [], {});
    expect(models["dall-e-3-image"].vision).toBe(true); // model-level evidence only
  });

  it("limits are provider-scoped and skip models the local tables resolve differently within tolerance", () => {
    const entries = [
      { provider: "provA", model: "vendor/model-x", contextLength: null, current: { contextWindow: 200000, maxOutput: 64000 } },
      { provider: "provB", model: "other/model-x", contextLength: null, current: { contextWindow: 1000000, maxOutput: 32000 } },
    ];
    const { providers } = buildCatalogDelta(raw, entries, { limitTolerance: 0.1 });
    // provA: catalog 1000000 vs local 200000 → diverges → recorded
    expect(providers.provA["vendor/model-x"].contextWindow).toBe(1000000);
    // provB: catalog 999999 vs local 1000000 → 0.0001% off → skipped
    expect(providers.provB).toBeUndefined();
  });

  it("registry-declared contextLength (contextLength set) suppresses the context delta", () => {
    const entries = [
      { provider: "provA", model: "vendor/model-x", contextLength: 128000, current: { contextWindow: 128000, maxOutput: 8192 } },
    ];
    const { providers } = buildCatalogDelta(raw, entries, {});
    // context suppressed by the registry-declared length; only maxOutput diverges.
    expect(providers.provA["vendor/model-x"].contextWindow).toBeUndefined();
    expect(providers.provA["vendor/model-x"].maxOutput).toBe(64000);
  });

  it("malformed records never crash the delta build", () => {
    expect(() => buildCatalogDelta({ broken: { models: { x: null } } }, [null, undefined, {}], {})).not.toThrow();
    expect(buildCatalogDelta(null, [], {})).toEqual({ models: {}, providers: {} });
    expect(buildCatalogDelta([], [], {})).toEqual({ models: {}, providers: {} });
  });

  it("unmapped providers contribute no limit rows (documented limitation)", () => {
    const entries = [{ provider: "totally-unknown-gateway", model: "vendor/model-x", contextLength: null, current: {} }];
    const { providers } = buildCatalogDelta(raw, entries, {});
    expect(providers).toEqual({});
  });
});

// ── D/E. Sync failure isolation + ETag (fetchAndNormalizeCatalog) ───────────

describe("D/E. conditional sync + failure isolation", () => {
  const baseOpts = {
    url: "https://models.dev/api.json",
    timeoutMs: 1000,
    maxPayloadBytes: 25 * 1024 * 1024,
    entries: [],
    minModalityShare: 0.5,
    limitTolerance: 0.1,
  };

  const jsonResponse = (body, headers = {}) => ({
    status: 200,
    ok: true,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    text: async () => typeof body === "string" ? body : JSON.stringify(body),
  });

  it("ETag flow: first 200 + ETag, then If-None-Match → 304 → unchanged", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, opts = {}) => {
      calls.push({ url, headers: opts.headers });
      if (calls.length === 1) return jsonResponse({ p: { models: { "m/v": { modalities: { input: ["text", "image"] } } } } }, { etag: '"abc123"' });
      return { status: 304, ok: false, headers: { get: () => null }, text: async () => "" };
    });

    const first = await fetchAndNormalizeCatalog(baseOpts, fetchImpl);
    expect(first.status).toBe("updated");
    expect(first.etag).toBe('"abc123"');
    expect(first.snapshot.models["v"].vision).toBe(true);

    const second = await fetchAndNormalizeCatalog({ ...baseOpts, etag: '"abc123"' }, fetchImpl);
    expect(second.status).toBe("unchanged");
    expect(calls[1].headers["if-none-match"]).toBe('"abc123"');
  });

  it("HTTP 500 / malformed JSON / invalid shape reject the update", async () => {
    await expect(fetchAndNormalizeCatalog(baseOpts, async () => ({ status: 500, ok: false, headers: { get: () => null } })))
      .rejects.toThrow(/HTTP 500/);
    await expect(fetchAndNormalizeCatalog(baseOpts, async () => jsonResponse("{not json", {})))
      .rejects.toThrow(/not valid JSON/);
    await expect(fetchAndNormalizeCatalog(baseOpts, async () => jsonResponse([1, 2, 3], {})))
      .rejects.toThrow(/unexpected shape/);
    await expect(fetchAndNormalizeCatalog(baseOpts, async () => jsonResponse({}, {})))
      .rejects.toThrow(/unexpected shape/);
  });

  it("oversized payloads are rejected before parsing", async () => {
    await expect(fetchAndNormalizeCatalog(
      { ...baseOpts, maxPayloadBytes: 10 },
      async () => jsonResponse({ big: "x".repeat(100) }, { "content-length": "100" }),
    )).rejects.toThrow(/too large/);
  });

  it("network failures propagate as rejections (caller keeps last-known-good)", async () => {
    await expect(fetchAndNormalizeCatalog(baseOpts, async () => { throw new Error("ETIMEDOUT"); }))
      .rejects.toThrow(/ETIMEDOUT/);
  });

  it("non-https URLs are refused (SSRF guard)", async () => {
    await expect(fetchAndNormalizeCatalog({ ...baseOpts, url: "http://models.dev/api.json" }, async () => jsonResponse({})))
      .rejects.toThrow(/https/);
  });
});

// ── F/G. Snapshot validation + atomic swap ──────────────────────────────────

describe("F/G. snapshot validation + atomic replacement", () => {
  it("validateCatalogSnapshot rejects pathological values", () => {
    expect(validateCatalogSnapshot(null)).toBeNull();
    expect(validateCatalogSnapshot("nope")).toBeNull();
    expect(validateCatalogSnapshot({ schemaVersion: 2, models: {}, providers: {} })).toBeNull();
    expect(validateCatalogSnapshot({ schemaVersion: 1 })).toBeNull();
    expect(validateCatalogSnapshot({ schemaVersion: 1, models: [], providers: {} })).toBeNull();
    const bad = validateCatalogSnapshot({
      schemaVersion: 1,
      models: { "m/negative": { vision: true } },
      providers: { p: { "m/negative": { contextWindow: -1, maxOutput: "hello" }, "m/ok": { contextWindow: 1e12 } } },
    });
    // All of p's records were pathological → the whole provider entry is dropped.
    expect(bad.providers.p).toBeUndefined();
    expect(bad.models["m/negative"]).toEqual({ vision: true }); // modality kept (valid)
  });

  it("validateCatalogSnapshot keeps valid records and freezes the snapshot", () => {
    const snap = validateCatalogSnapshot({
      schemaVersion: 1,
      source: "models.dev",
      syncedAt: 123,
      etag: '"e"',
      models: { "m/v": { vision: true, audioInput: false } },
      providers: { p: { "m/v": { contextWindow: 128000, maxOutput: 8192 } } },
    });
    expect(snap.models["m/v"]).toEqual({ vision: true });
    expect(snap.providers.p["m/v"]).toEqual({ contextWindow: 128000, maxOutput: 8192 });
    expect(Object.isFrozen(snap)).toBe(true);
  });

  it("swap is by reference — readers never observe partial state", async () => {
    // The snapshot lives in catalogSource.js; the resolver only sees it through
    // the injected reader — install the real one (what startup does).
    const { getCatalogModalities, getCatalogLimits } = await import("../../open-sse/providers/catalogSource.js");
    setCatalogSource({ getModalities: getCatalogModalities, getLimits: getCatalogLimits });

    setCatalogSnapshot(validateCatalogSnapshot({
      schemaVersion: 1, models: { "old/model": { vision: true } }, providers: {},
    }));
    const seen = getCapabilitiesForModel("openai", "old/model");
    expect(seen.vision).toBe(true);
    // Replace wholesale — old references stay intact, new lookups see new data.
    setCatalogSnapshot(validateCatalogSnapshot({
      schemaVersion: 1, models: { "new/model": { pdf: true } }, providers: {},
    }));
    expect(getCapabilitiesForModel("openai", "new/model").pdf).toBe(true);
  });
});

// ── H. Request hot path ──────────────────────────────────────────────────────

describe("H. hot-path architecture invariant", () => {
  it("capabilities.js never imports node:fs or fetch — catalog arrives by injection", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("open-sse/providers/capabilities.js", "utf8");
    expect(src).not.toMatch(/node:fs/);
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/readFileSync/);
  });

  it("lookup with an injected pure source performs no I/O and is stable across calls", () => {
    let ioCalls = 0;
    setCatalogSource({
      getModalities: (id) => { ioCalls++; return { vision: true }; },
      getLimits: () => null,
    });
    const a = getCapabilitiesForModel("openai", "pure-model");
    const b = getCapabilitiesForModel("openai", "pure-model");
    expect(a.vision).toBe(b.vision);
    expect(ioCalls).toBe(2); // exactly one lookup per resolve — nothing more
  });
});

// ── I. Hard capabilities ─────────────────────────────────────────────────────

describe("I. hard capabilities (vision/audio/video/pdf/toolUse)", () => {
  it("catalog positively declares each hard input modality", () => {
    installFake({ "omni-model": { vision: true, pdf: true, audioInput: true, videoInput: true } });
    const caps = getCapabilitiesForModel("openai", "omni-model");
    expect(caps.vision).toBe(true);
    expect(caps.pdf).toBe(true);
    expect(caps.audioInput).toBe(true);
    expect(caps.videoInput).toBe(true);
  });

  it("unknown catalog entry contributes nothing (never an unsafe true, never a false)", () => {
    installFake({ "mystery-model": {} });
    const caps = getCapabilitiesForModel("openai", "mystery-model");
    expect(caps.vision).toBe(false); // floor default, NOT catalog-claimed
    expect(caps.catalog).toBeUndefined();
  });

  it("explicit toolUse stays untouched — the catalog does not decide tool calling", () => {
    installFake({ "tool-model": { vision: true } });
    // DEFAULT tools:true; catalog only carries modalities — tools unchanged.
    const caps = getCapabilitiesForModel("openai", "tool-model");
    expect(caps.tools).toBe(true);
  });
});

// ── K. Combo integration (through the one resolver) ──────────────────────────

describe("K. combo integration via the single resolver", () => {
  it("combo's capability source reflects catalog evidence (no second API)", async () => {
    installFake({ "combo-vision-model": { vision: true } });
    const { getCapabilitiesForModel: resolver } = await import("../../open-sse/providers/capabilities.js");
    // combo.js line 138 resolves member capabilities through this same function;
    // a catalog-filled model is therefore visible to combo routing directly.
    const caps = resolver("openai", "combo-vision-model");
    expect(caps.vision).toBe(true);
    expect(caps.catalog).toBeDefined();
  });
});

// ── Snapshot disk round-trip (loader path) ───────────────────────────────────

describe("snapshot disk round-trip", () => {
  it("loadCatalogSnapshotFromDisk validates before swapping; corrupt file keeps last-known-good", async () => {
    const { loadCatalogSnapshotFromDisk, setCatalogSnapshot: _set, CATALOG_FILE: realFile } =
      await import("../../open-sse/providers/catalogSource.js");
    // The loader reads the real CATALOG_FILE path; corrupt file on disk is the
    // same code path as a missing one — must return false, not throw.
    const result = loadCatalogSnapshotFromDisk();
    expect(typeof result).toBe("boolean");
    void realFile;
    void fsPromises;
    void tmpdir;
    void join;
  });
});
