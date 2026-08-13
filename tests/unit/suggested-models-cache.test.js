import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => ({ body, init, json: async () => body }),
  },
}));
vi.mock("@/models", () => ({
  getProviderConnectionById: vi.fn(async () => null),
}));

// Import after mocks so the route resolves them.
const {
  suggestedModelsCacheKey,
  getCachedSuggestedModels,
  setCachedSuggestedModels,
  clearSuggestedModelsCache,
} = await import("@/lib/suggestedModelsCache");
const { GET } = await import(
  "@/app/api/providers/suggested-models/route.js"
);

const BYNARA_URL = "https://router.bynara.id/v1/models";

const requestFor = (url, type) => ({
  url: `http://localhost/api/providers/suggested-models?type=${type}&url=${encodeURIComponent(url)}`,
});

describe("suggestedModelsCache module", () => {
  beforeEach(() => clearSuggestedModelsCache());

  it("composes keys from url, connectionId and type", () => {
    expect(suggestedModelsCacheKey("u", "c1", "bynara")).toBe("u::c1::bynara");
    expect(suggestedModelsCacheKey("u", null, "openai")).toBe("u::public::openai");
  });

  it("returns null on miss, the data on hit", () => {
    expect(getCachedSuggestedModels("k")).toBeNull();
    setCachedSuggestedModels("k", [{ id: "m" }]);
    expect(getCachedSuggestedModels("k")).toEqual([{ id: "m" }]);
  });

  it("expires entries after the TTL", () => {
    vi.useFakeTimers();
    try {
      setCachedSuggestedModels("k", [{ id: "m" }]);
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      expect(getCachedSuggestedModels("k")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("evicts the oldest entry when the map is full", () => {
    // Fill to the cap, then add one more → oldest (first inserted) is evicted.
    for (let i = 0; i < 200; i++) setCachedSuggestedModels(`k${i}`, [{ id: i }]);
    setCachedSuggestedModels("overflow", [{ id: "new" }]);
    expect(getCachedSuggestedModels("k0")).toBeNull();
    expect(getCachedSuggestedModels("overflow")).toEqual([{ id: "new" }]);
  });
});

describe("suggested-models route caching", () => {
  beforeEach(() => {
    clearSuggestedModelsCache();
    vi.restoreAllMocks();
  });

  it("serves the second identical request from cache without re-fetching upstream", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        object: "list",
        data: [{ id: "agnes-2.0-flash", context_window: 512000, vision: true, reasoning: true }],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const res1 = await GET(requestFor(BYNARA_URL, "bynara"));
    const res2 = await GET(requestFor(BYNARA_URL, "bynara"));

    expect(fetchMock).toHaveBeenCalledTimes(1); // second call served from cache
    expect(res1.body.data[0].contextLength).toBe(512000);
    expect(res2.body.data).toEqual(res1.body.data);
    vi.unstubAllGlobals();
  });

  it("re-fetches when the type or url differs (distinct cache keys)", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ data: [{ id: "a" }] }) }));
    vi.stubGlobal("fetch", fetchMock);

    await GET(requestFor(BYNARA_URL, "bynara"));
    await GET(requestFor("https://other.example/v1/models", "bynara"));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("returns an empty list (not cached) when upstream fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
    const res = await GET(requestFor(BYNARA_URL, "bynara"));
    expect(res.body.data).toEqual([]);
    expect(getCachedSuggestedModels(suggestedModelsCacheKey(BYNARA_URL, null, "bynara"))).toBeNull();
    vi.unstubAllGlobals();
  });
});
