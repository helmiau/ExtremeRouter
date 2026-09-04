// Forensic correctness review (commit 00def322 / 63d9573) — targeted audits:
//   1. attemptId semantics: unique per physical execution, requestId stable
//      across a whole logical/combo request.
//   2. persistence durability: deterministic attempts[] order within a request.
//   3. root vs leaf correlation: reconstructable requestId -> attempts -> leaves.
//   4. nested redaction: no credential shape can persist inside correlation,
//      attempts[], canonicalAttempt, or streamObservability.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { comboSaveRequestDetail } = vi.hoisted(() => ({
  comboSaveRequestDetail: vi.fn(async () => {}),
}));

vi.mock("../../open-sse/services/providerCapabilities.js", () => ({
  validateComboRoles: () => [],
}));

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestDetail: comboSaveRequestDetail,
}));

const { handleComboChat } = await import("../../open-sse/services/combo.js");
const { createCanonicalAttemptFromNonStreaming } = await import("../../open-sse/utils/nonStreamingAttempt.js");

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function emptyResult({ attemptId, requestId }) {
  const body = { id: "empty", choices: [] };
  return {
    success: true,
    status: 200,
    response: new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
    canonicalAttempt: createCanonicalAttemptFromNonStreaming({ status: 200, parsed: body, usage: null, malformed: false }),
    correlation: {
      requestId,
      attemptId,
      physicalProviderId: "provider-a",
      physicalProviderAlias: "provider-a",
      physicalModel: "provider-a/model-a",
      executor: { implementation: "DefaultExecutor", dispatch: "default_executor" },
    },
  };
}

function successResult({ attemptId, requestId }) {
  const body = { id: "success", model: "provider-b/model-b", choices: [{ message: { role: "assistant", content: "answer" }, finish_reason: "stop" }] };
  return {
    success: true,
    status: 200,
    response: new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
    canonicalAttempt: createCanonicalAttemptFromNonStreaming({ status: 200, parsed: body, usage: null, malformed: false }),
    correlation: {
      requestId,
      attemptId,
      physicalProviderId: "provider-b",
      physicalProviderAlias: "provider-b",
      physicalModel: "provider-b/model-b",
      executor: { implementation: "DefaultExecutor", dispatch: "default_executor" },
    },
  };
}

describe("issue 1 — requestId stable / attemptId unique per physical execution", () => {
  beforeEach(() => vi.clearAllMocks());

  it("combo: both candidates share the dispatch requestId, each has its own attemptId", async () => {
    const save = comboSaveRequestDetail;
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(emptyResult({ requestId: "req_combo", attemptId: "attempt_a" }))
      .mockResolvedValueOnce(successResult({ requestId: "req_combo", attemptId: "attempt_b" }));

    await handleComboChat({
      body: { model: "combo", stream: false },
      models: ["provider-a/model-a", "provider-b/model-b"],
      handleSingleModel,
      log,
      comboName: "combo",
      comboStrategy: "fallback",
      autoSwitch: false,
    });

    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    const attempts = save.mock.calls.flatMap(([detail]) => detail.attempts || []);
    expect(attempts.map((a) => a.requestId)).toEqual(["req_combo", "req_combo"]);
    expect(new Set(attempts.map((a) => a.attemptId)).size).toBe(2);
  });

  it("combo: repeated executions of the same candidate keep requestId, distinct attemptIds", async () => {
    const save = comboSaveRequestDetail;
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(emptyResult({ requestId: "req_multi", attemptId: "attempt_1" }))
      .mockResolvedValueOnce(emptyResult({ requestId: "req_multi", attemptId: "attempt_2" }))
      .mockResolvedValueOnce(successResult({ requestId: "req_multi", attemptId: "attempt_3" }));

    await handleComboChat({
      body: { model: "combo", stream: false },
      models: ["provider-a/model-a", "provider-a/model-a", "provider-b/model-b"],
      handleSingleModel,
      log,
      comboName: "combo",
      comboStrategy: "fallback",
      autoSwitch: false,
    });

    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(3));
    const attempts = save.mock.calls.flatMap(([detail]) => detail.attempts || []);
    expect(attempts.map((a) => a.requestId)).toEqual(["req_multi", "req_multi", "req_multi"]);
    expect(attempts.map((a) => a.attemptId)).toEqual(["attempt_1", "attempt_2", "attempt_3"]);
  });
});

describe("issue 2 — deterministic attempts[] order within a request", () => {
  beforeEach(() => vi.clearAllMocks());

  it("two candidates persist in candidate order, no reordering", async () => {
    const save = comboSaveRequestDetail;
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce(emptyResult({ requestId: "req_order", attemptId: "attempt_1" }))
      .mockResolvedValueOnce(successResult({ requestId: "req_order", attemptId: "attempt_2" }));

    await handleComboChat({
      body: { model: "combo", stream: false },
      models: ["provider-a/model-a", "provider-b/model-b"],
      handleSingleModel,
      log,
      comboName: "combo",
      comboStrategy: "fallback",
      autoSwitch: false,
    });

    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    const attempts = save.mock.calls.flatMap(([detail]) => detail.attempts || []);
    expect(attempts.map((a) => a.attemptId)).toEqual(["attempt_1", "attempt_2"]);
    expect(attempts.map((a) => a.fallbackDecision)).toEqual(["fallback", "served"]);
  });
});

describe("issue 3 — root request -> leaf evidence reconstructable", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ledger row id equals requestId and correlation carries the (requestId, attemptId) pair", async () => {
    const save = comboSaveRequestDetail;
    const handleSingleModel = vi.fn().mockResolvedValueOnce(
      successResult({ requestId: "req_root", attemptId: "attempt_leaf" })
    );

    await handleComboChat({
      body: { model: "combo", stream: false },
      models: ["provider-a/model-a"],
      handleSingleModel,
      log,
      comboName: "combo",
      comboStrategy: "fallback",
      autoSwitch: false,
    });

    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const detail = save.mock.calls[0][0];
    expect(detail.id).toBe("req_root");
    expect(detail.correlation.requestId).toBe("req_root");
    expect(detail.correlation.attemptId).toBe("attempt_leaf");
  });
});

// --- Real requestDetailsRepo persistence-level audits (Issues 3 + 4) ---
// These import the REAL repo with a scripted adapter, so evidence is proved
// through the actual flush/redaction/merge path, not through mocks of it.
const runMock = vi.fn();
const allMock = vi.fn();
const transactionMock = vi.fn();

vi.mock("../../src/lib/db/driver.js", () => ({
  getAdapter: vi.fn(async () => ({
    run: runMock,
    all: allMock,
    get: vi.fn((sql) => (sql.startsWith("SELECT COUNT") ? { c: 0 } : undefined)),
    transaction: transactionMock,
  })),
}));

vi.mock("../../src/lib/db/repos/settingsRepo.js", () => ({
  getSettings: vi.fn(async () => ({
    enableObservability: true,
    observabilityBatchSize: 1,
    observabilityFlushIntervalMs: 60_000,
    observabilityMaxRecords: 200,
    observabilityMaxJsonSize: 64,
  })),
}));

process.env.OBSERVABILITY_ENABLED = "true";
process.env.OBSERVABILITY_BATCH_SIZE = "1";
process.env.OBSERVABILITY_FLUSH_INTERVAL_MS = "1";

const { saveRequestDetail, getRequestDetailsByCorrelation } = await import("../../src/lib/db/repos/requestDetailsRepo.js");

function lastInserted() {
  const insertCall = runMock.mock.calls.find((c) => c[0].startsWith("INSERT INTO requestDetails"));
  return insertCall ? JSON.parse(insertCall[1][6]) : null;
}

describe("issue 4 — nested forensic fields cannot persist credentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transactionMock.mockImplementation((fn) => fn());
  });

  it("correlation/attempts/canonicalAttempt/streamObservability are redacted through the real flush", async () => {
    await saveRequestDetail({
      id: "forensic-redact-1",
      provider: "codex",
      model: "grok",
      status: "empty_output",
      correlation: {
        requestId: "req_sec",
        attemptId: "attempt_sec",
        authorization: "Bearer sk-live-abc1234567890",
        "x-api-key": "sk-abcdef12345678",
        cookie: "session=abc123; csrf=xyz789",
        captchaVerifyParam: "abc123xyz",
      },
      attempts: [{
        attemptId: "attempt_sec",
        captchaProof: "captcha_verify_param=abc123xyz",
        accessToken: "tok-abc123456789",
        inner: { apiKey: "sk-abcdef12345678", authorization: "Basic dXNj" },
      }],
      canonicalAttempt: {
        classification: "empty_output",
        reason: "empty_response",
        nested: { cookie: "csrftoken=xyz789", raw: "Bearer eyJabc123.def456.ghi789" },
      },
      streamObservability: {
        eofSeen: true,
        token: "sk-abcdef12345678",
        headers: { Authorization: "Bearer eyJabc123.def456.ghi789" },
      },
    });

    await vi.waitFor(() => expect(lastInserted()).not.toBeNull());
    const stored = lastInserted();
    const json = JSON.stringify(stored);
    // Values must never survive; key NAMES are preserved so the forensic
    // structure stays queryable (e.g. "authorization":"[REDACTED]").
    for (const secret of [
      "sk-live-abc1234567890",
      "sk-abcdef12345678",
      "abc123xyz",
      "session=abc123",
      "tok-abc123456789",
      "Basic dXNj",
      "eyJabc123.def456.ghi789",
      "csrftoken=xyz789",
    ]) {
      expect(json, `stored JSON must not contain ${secret}`).not.toContain(secret);
    }
    expect(json).toContain("[REDACTED]");
    expect(json).not.toContain('"sk-live-');
  });
});

describe("issue 3 (repo) — getRequestDetailsByCorrelation finds leaf evidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transactionMock.mockImplementation((fn) => fn());
  });

  it("returns rows whose correlation.requestId matches the root", async () => {
    allMock.mockReturnValue([
      { data: JSON.stringify({ id: "root-1", correlation: { requestId: "req_abc", attemptId: "attempt_1" } }) },
      { data: JSON.stringify({ id: "leaf-a", correlation: { requestId: "req_abc", attemptId: "attempt_2" } }) },
      { data: JSON.stringify({ id: "other", correlation: { requestId: "req_xyz", attemptId: "attempt_9" } }) },
    ]);

    const leaves = await getRequestDetailsByCorrelation("req_abc");
    expect(leaves.map((l) => l.correlation.attemptId)).toEqual(["attempt_1", "attempt_2"]);
  });
});