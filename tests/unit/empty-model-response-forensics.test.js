import { describe, it, expect, vi, beforeEach } from "vitest";

const { comboSaveRequestDetail } = vi.hoisted(() => ({
  comboSaveRequestDetail: vi.fn(async () => {}),
}));

// Forensic characterization only. These tests pin the observed failure boundary
// without changing retry, cooldown, fallback, or combo behavior.
vi.mock("../../open-sse/services/providerCapabilities.js", () => ({
  validateComboRoles: () => [],
}));

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestDetail: comboSaveRequestDetail,
}));

const { handleComboChat } = await import("../../open-sse/services/combo.js");
const { createCanonicalAttemptFromNonStreaming } = await import("../../open-sse/utils/nonStreamingAttempt.js");
const { mapCanonicalAttemptToRequestStatus } = await import("../../open-sse/utils/requestDetailStatus.js");

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function emptyAttempt({ usage = null } = {}) {
  return createCanonicalAttemptFromNonStreaming({
    status: 200,
    parsed: usage ? { choices: [], usage } : { choices: [] },
    usage,
    malformed: false,
  });
}

function emptyResult({ usage = null } = {}) {
  const body = usage ? { id: "empty-usage", choices: [], usage } : { id: "empty", choices: [] };
  return {
    success: true,
    status: 200,
    response: new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    canonicalAttempt: emptyAttempt({ usage }),
  };
}

function successResult(model = "provider-b/model-b") {
  const body = {
    id: "success",
    model,
    choices: [{ message: { role: "assistant", content: "answer" }, finish_reason: "stop" }],
  };
  return {
    success: true,
    status: 200,
    response: new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    canonicalAttempt: createCanonicalAttemptFromNonStreaming({
      status: 200,
      parsed: body,
      usage: null,
      malformed: false,
    }),
  };
}

describe("empty_model_response forensic characterization", () => {
  beforeEach(() => vi.clearAllMocks());

  it("classifies HTTP 200 empty choices as empty_output, not logical success", () => {
    const attempt = emptyAttempt();

    expect(attempt.transportOk).toBe(true);
    expect(attempt.hasText).toBe(false);
    expect(attempt.hasReasoning).toBe(false);
    expect(attempt.hasToolCall).toBe(false);
    expect(attempt.hasStructuredOutput).toBe(false);
    expect(attempt.hasUsage).toBe(false);
    expect(attempt.completionState).toBe("incomplete");
    expect(attempt.logicalSuccess).toBe(false);
    expect(attempt.classification).toBe("empty_output");
    expect(attempt.reason).toBe("empty_response");
    expect(attempt.policy.fallbackEligible).toBe(true);
    expect(attempt.policy.retryable).toBe(true);
    expect(mapCanonicalAttemptToRequestStatus(attempt)).toBe("empty_output");
  });

  it("records usage evidence as usage_only without treating it as usable output", () => {
    const attempt = emptyAttempt({
      usage: { prompt_tokens: 8, completion_tokens: 0 },
    });

    expect(attempt.transportOk).toBe(true);
    expect(attempt.hasUsage).toBe(true);
    expect(attempt.usableOutput).toBe(false);
    expect(attempt.logicalSuccess).toBe(false);
    expect(attempt.classification).toBe("empty_output");
    expect(attempt.reason).toBe("usage_only");
  });

  it("retains both executed candidates when empty output falls back to success", async () => {
    const saveRequestDetail = comboSaveRequestDetail;
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce({
        ...emptyResult(),
        correlation: {
          requestId: "req_acceptance",
          attemptId: "attempt_empty",
          physicalProviderId: "provider-a",
          physicalProviderAlias: "provider-a",
          physicalModel: "model-a",
          executor: { implementation: "DefaultExecutor", dispatch: "default_executor" },
        },
      })
      .mockResolvedValueOnce({
        ...successResult(),
        correlation: {
          requestId: "req_acceptance",
          attemptId: "attempt_success",
          physicalProviderId: "provider-b",
          physicalProviderAlias: "provider-b",
          physicalModel: "model-b",
          executor: { implementation: "DefaultExecutor", dispatch: "default_executor" },
        },
      });

    const response = await handleComboChat({
      body: { model: "combo", stream: false },
      models: ["provider-a/model-a", "provider-b/model-b"],
      handleSingleModel,
      log,
      comboName: "combo",
      comboStrategy: "fallback",
      autoSwitch: false,
    });

    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(saveRequestDetail).toHaveBeenCalledTimes(2));
    const calls = saveRequestDetail.mock.calls.map(([detail]) => detail);
    expect(calls.flatMap((detail) => detail.attempts || []).map((attempt) => attempt.attemptId)).toEqual([
      "attempt_empty",
      "attempt_success",
    ]);
    expect(calls[0].attempts[0].reason).toBe("empty_response");
    expect(calls[1].attempts[0].fallbackDecision).toBe("served");
  });

  it("persists every failed candidate in an all-failed combo", async () => {
    const saveRequestDetail = comboSaveRequestDetail;
    const handleSingleModel = vi.fn()
      .mockResolvedValueOnce({
        ...emptyResult(),
        correlation: { requestId: "req_failed", attemptId: "attempt_a", physicalProviderId: "provider-a", physicalModel: "model-a" },
      })
      .mockResolvedValueOnce({
        ...emptyResult(),
        correlation: { requestId: "req_failed", attemptId: "attempt_b", physicalProviderId: "provider-b", physicalModel: "model-b" },
      });

    const response = await handleComboChat({
      body: { model: "combo", stream: false },
      models: ["provider-a/model-a", "provider-b/model-b"],
      handleSingleModel,
      log,
      comboName: "combo",
      comboStrategy: "fallback",
      autoSwitch: false,
    });

    expect(response.status).toBe(503);
    await vi.waitFor(() => expect(saveRequestDetail).toHaveBeenCalledTimes(2));
    const attempts = saveRequestDetail.mock.calls.flatMap(([detail]) => detail.attempts || []);
    expect(attempts.map((attempt) => attempt.attemptId)).toEqual(["attempt_a", "attempt_b"]);
    expect(attempts.every((attempt) => attempt.fallbackDecision === "fallback" || attempt.fallbackDecision === "stopped")).toBe(true);
  });

  it("progresses past an empty canonical candidate, then surfaces the last classification in the all-failed envelope", async () => {
    const calls = [];
    const handleSingleModel = vi.fn(async (_body, model) => {
      calls.push(model);
      return emptyResult();
    });

    const response = await handleComboChat({
      body: { model: "gpt-5.6-sol", stream: false },
      models: ["provider-a/model-a", "provider-b/model-b"],
      handleSingleModel,
      log,
      comboName: "gpt-5.6-sol",
      comboStrategy: "fallback",
      autoSwitch: false,
    });
    const body = await response.json();

    expect(calls).toEqual(["provider-a/model-a", "provider-b/model-b"]);
    expect(response.status).toBe(503);
    // A 2xx empty result has no error text — the envelope must NOT degrade to
    // the useless raw status ("200"), which clients render as generic
    // "empty response" templates. The last canonical classification is
    // surfaced instead so the failure is diagnosable.
    expect(body.error.code).toBe("all_models_failed");
    expect(body.error.message).toContain("last candidate provider-b/model-b: empty_output/empty_response");
    expect(body.error.message).not.toBe("200");
  });

  it("surfaces finish_reason=max_tokens truncation in the all-failed envelope", async () => {
    // The recurring production incident: ag/gemini-3.8-flash-high streams a
    // long answer, hits the output cap (finishReason=max_tokens → incomplete,
    // logicalSuccess=false), combo falls through everything, and the client
    // showed an uninformative "empty model response" banner.
    const truncatedResult = (model) => ({
      success: true,
      status: 200,
      response: new Response(JSON.stringify({ id: "t", choices: [{ message: { role: "assistant", content: "partial" }, finish_reason: "length" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      canonicalAttempt: {
        source: "provider",
        transportOk: true,
        completionState: "incomplete",
        terminalState: "incomplete",
        terminalType: "finish_reason",
        finishReason: "max_tokens",
        usableOutput: true,
        logicalSuccess: false,
        classification: "incomplete",
        reason: "no_successful_terminal",
        policy: { fallbackEligible: true, retryable: true, stopProgression: false },
      },
      correlation: {
        requestId: "req_trunc",
        attemptId: `attempt_${model.replace(/\W/g, "_")}`,
        physicalProviderId: model.split("/")[0],
        physicalModel: model.split("/")[1],
      },
    });

    const handleSingleModel = vi.fn(async (_body, model) => truncatedResult(model));
    const response = await handleComboChat({
      body: { model: "gpt-5.6-sol", stream: false },
      models: ["ag/gemini-3.8-flash-high", "oc/muse-spark-1.2-contributor-free"],
      handleSingleModel,
      log,
      comboName: "gpt-5.6-sol",
      comboStrategy: "fallback",
      autoSwitch: false,
    });
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("all_models_failed");
    expect(body.error.message).toContain("muse-spark-1.2-contributor-free: incomplete/no_successful_terminal (finish_reason=max_tokens)");
  });
});

// The request-details repository currently whitelists legacy fields before
// serializing. Keep this as a separate module-level characterization so a future
// forensic persistence change can prove exactly when evidence becomes durable.
const { getAdapterMock, getSettingsMock } = vi.hoisted(() => ({
  getAdapterMock: vi.fn(),
  getSettingsMock: vi.fn(),
}));

vi.mock("../../src/lib/db/driver.js", () => ({ getAdapter: getAdapterMock }));
vi.mock("../../src/lib/db/repos/settingsRepo.js", () => ({ getSettings: getSettingsMock }));

const { saveRequestDetail } = await import("../../src/lib/db/repos/requestDetailsRepo.js");

describe("request-detail forensic evidence characterization", () => {
  let inserted;

  beforeEach(() => {
    vi.clearAllMocks();
    inserted = null;
    getSettingsMock.mockResolvedValue({
      enableObservability: true,
      observabilityBatchSize: 1,
      observabilityFlushIntervalMs: 60_000,
      observabilityMaxRecords: 200,
      observabilityMaxJsonSize: 64,
    });
    getAdapterMock.mockResolvedValue({
      transaction(callback) { callback(); },
      get(sql) {
        if (sql.startsWith("SELECT COUNT")) return { c: 0 };
        return undefined;
      },
      run(sql, params) {
        if (sql.startsWith("INSERT INTO requestDetails")) inserted = JSON.parse(params[6]);
      },
    });
  });

  it("persists canonical attempt and stream observability through SQLite serialization", async () => {
    await saveRequestDetail({
      id: "forensic-detail-1",
      provider: "codex",
      model: "gpt-5.6-luna",
      status: "empty_output",
      canonicalAttempt: {
        classification: "empty_output",
        reason: "empty_response",
        transportOk: true,
        logicalSuccess: false,
      },
      streamObservability: {
        eofSeen: true,
        terminalSeen: false,
        hasText: false,
      },
    });

    await vi.waitFor(() => expect(inserted).not.toBeNull());
    expect(inserted.status).toBe("empty_output");
    expect(inserted.canonicalAttempt).toEqual({
      classification: "empty_output",
      reason: "empty_response",
      transportOk: true,
      logicalSuccess: false,
    });
    expect(inserted.streamObservability).toEqual({
      eofSeen: true,
      terminalSeen: false,
      hasText: false,
    });
  });
});
