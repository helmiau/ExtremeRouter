import { describe, it, expect, vi } from "vitest";

import { handleFusionChat } from "../../open-sse/services/combo.js";

const log = { info: () => {}, warn: () => {}, debug: () => {} };

// Minimal OpenAI-chat stub wrapped in the ChatResult envelope the engine
// consumes since Wave 1C (application success via .success, transport via
// .response). The response stub keeps the .clone()/.json() surface.
function okResponse(content, { delayMs = 0 } = {}) {
  const json = { choices: [{ message: { role: "assistant", content } }] };
  const make = () => ({ ok: true, status: 200, clone: make, json: async () => json });
  const res = make();
  const envelope = { success: true, status: 200, response: res };
  return delayMs > 0 ? new Promise((r) => setTimeout(() => r(envelope), delayMs)) : envelope;
}

function errResponse(status = 500) {
  const make = () => ({ ok: false, status, clone: make, json: async () => ({ error: { message: "boom" } }) });
  return { success: false, status, response: make() };
}

describe("fusion combo", () => {
  it("answers directly with a single-model panel (nothing to fuse)", async () => {
    const handleSingleModel = vi.fn(async () => okResponse("solo"));
    await handleFusionChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["anthropic/only"],
      handleSingleModel,
      log,
    });
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(handleSingleModel.mock.calls[0][1]).toBe("anthropic/only");
  });

  it("fans out to the panel then routes a synthesis turn to the judge", async () => {
    const seen = [];
    const handleSingleModel = vi.fn(async (body, model, isPanel) => {
      seen.push(model);
      if (model === "anthropic/judge") return okResponse("FINAL");
      return okResponse(`ans-${model}`);
    });

    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }], stream: true, tools: [{ name: "x" }] },
      models: ["anthropic/a", "anthropic/b", "anthropic/c"],
      handleSingleModel,
      log,
      judgeModel: "anthropic/judge",
    });

    // 3 panel calls + 1 judge call.
    expect(handleSingleModel).toHaveBeenCalledTimes(4);
    expect(seen.slice(0, 3).sort()).toEqual(["anthropic/a", "anthropic/b", "anthropic/c"]);
    expect(seen[3]).toBe("anthropic/judge");

    // Panel calls are non-streaming with tools stripped.
    for (const [body, model, isPanel] of handleSingleModel.mock.calls.filter(([, m]) => m !== "anthropic/judge")) {
      expect(body.stream).toBe(false);
      expect(body.tools).toBeUndefined();
      expect(isPanel?.isPanel).toBe(true);
    }

    // Judge call carries every panel answer + keeps the client's stream flag.
    const [judgeBody, , isPanel] = handleSingleModel.mock.calls.find(([, m]) => m === "anthropic/judge");
    const judgeText = judgeBody.messages.at(-1).content;
    expect(judgeText).toContain("ans-anthropic/a");
    expect(judgeText).toContain("ans-anthropic/b");
    expect(judgeText).toContain("ans-anthropic/c");
    expect(judgeText).toContain("Source 1");
    expect(judgeBody.stream).toBe(true);
    expect(isPanel?.isPanel).toBeFalsy();

    expect(res.ok).toBe(true);
  });

  it("defaults the judge to the first panel model when none is set", async () => {
    const seen = [];
    const handleSingleModel = vi.fn(async (_body, model) => { seen.push(model); return okResponse(`ans-${model}`); });
    await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["anthropic/first", "anthropic/second"],
      handleSingleModel,
      log,
    });
    // Last call is the judge; defaults to panel[0].
    expect(seen.at(-1)).toBe("anthropic/first");
  });

  it("proceeds on quorum without waiting for a straggler (grace window)", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => {
      if (model === "anthropic/slow") return okResponse("slow", { delayMs: 5000 });
      if (model === "anthropic/judge") return okResponse("FINAL");
      return okResponse(`fast-${model}`);
    });

    const t0 = Date.now();
    await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["anthropic/x", "anthropic/y", "anthropic/slow"],
      handleSingleModel,
      log,
      judgeModel: "anthropic/judge",
      tuning: { minPanel: 2, stragglerGraceMs: 50, panelHardTimeoutMs: 10000 },
    });
    const elapsed = Date.now() - t0;

    // Two fast answers reach quorum; grace is 50ms, so we never wait ~5s for p/slow.
    expect(elapsed).toBeLessThan(2000);

    const judgeCall = handleSingleModel.mock.calls.find(([, m]) => m === "anthropic/judge");
    const judgeText = judgeCall[0].messages.at(-1).content;
    expect(judgeText).toContain("fast-anthropic/x");
    expect(judgeText).toContain("fast-anthropic/y");
    expect(judgeText).not.toContain("slow");
  });

  it("returns the lone survivor directly when only one panel model succeeds", async () => {
    const handleSingleModel = vi.fn(async (_body, model) => {
      if (model === "anthropic/ok") return okResponse("lone");
      return errResponse(500);
    });
    await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["anthropic/ok", "anthropic/bad"],
      handleSingleModel,
      log,
      judgeModel: "anthropic/judge",
      tuning: { minPanel: 2, stragglerGraceMs: 50, panelHardTimeoutMs: 5000 },
    });
    // No judge call — single answer means there is nothing to fuse.
    const judged = handleSingleModel.mock.calls.some(([, m]) => m === "anthropic/judge");
    expect(judged).toBe(false);
  });

  it("returns 503 when the whole panel fails", async () => {
    const handleSingleModel = vi.fn(async () => errResponse(500));
    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["anthropic/a", "anthropic/b"],
      handleSingleModel,
      log,
      tuning: { minPanel: 2, stragglerGraceMs: 50, panelHardTimeoutMs: 5000 },
    });
    expect(res.status).toBe(503);
  });

  it("flattens previous tool history and assistant tool_calls into prose for panel calls", async () => {
    const handleSingleModel = vi.fn(async () => okResponse("ans"));
    await handleFusionChat({
      body: {
        messages: [
          { role: "user", content: "find files" },
          { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "find" } }] },
          { role: "tool", tool_call_id: "c1", content: "['a.js']" },
          { role: "user", content: "describe it" }
        ],
        tools: [{ type: "function" }]
      },
      models: ["anthropic/a", "anthropic/b"],
      handleSingleModel,
      log,
      judgeModel: "anthropic/judge"
    });

    // Panel calls keep every turn but tool turns are flattened to assistant prose.
    const panelCalls = handleSingleModel.mock.calls.filter(([,, isPanel]) => isPanel?.isPanel === true);
    expect(panelCalls.length).toBe(2);
    for (const [panelBody] of panelCalls) {
      expect(panelBody.tools).toBeUndefined();
      expect(panelBody.messages.length).toBe(4);
      expect(panelBody.messages[0]).toEqual({ role: "user", content: "find files" });
      expect(panelBody.messages[1].tool_calls).toBeUndefined();
      expect(panelBody.messages[1].content).toContain("find");
      expect(panelBody.messages[2].role).toBe("assistant");
      expect(panelBody.messages[2].content).toContain("['a.js']");
      expect(panelBody.messages[3]).toEqual({ role: "user", content: "describe it" });
    }

    // Judge call still receives the unmodified history + synthesis prompt.
    const judgeCall = handleSingleModel.mock.calls.find(([, m]) => m === "anthropic/judge");
    expect(judgeCall).toBeDefined();
    const judgeBody = judgeCall[0];
    expect(judgeBody.messages.length).toBe(5); // original 4 + judge prompt turn
    expect(judgeBody.messages[1].tool_calls).toBeDefined();
    expect(judgeBody.messages[2].role).toBe("tool");
  });

  it("flattens Anthropic-style tool_use and tool_result blocks in arrays", async () => {
    const handleSingleModel = vi.fn(async () => okResponse("ans"));
    await handleFusionChat({
      body: {
        messages: [
          { role: "user", content: "do it" },
          { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "t1", name: "run" }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] }
        ],
        tools: [{ name: "run", description: "d" }]
      },
      models: ["anthropic/a", "anthropic/b"],
      handleSingleModel,
      log,
      judgeModel: "anthropic/judge"
    });

    const panelCalls = handleSingleModel.mock.calls.filter(([,, isPanel]) => isPanel?.isPanel === true);
    expect(panelCalls.length).toBe(2);
    const panelBody = panelCalls[0][0];
    
    expect(panelBody.tools).toBeUndefined();
    expect(panelBody.messages.length).toBe(3);
    
    // Flattened tool_use
    expect(panelBody.messages[1].content).toBe("ok\n[Called tool: run]");
    
    // Flattened tool_result
    expect(panelBody.messages[2].content).toBe("[Tool result: done]");
  });

  it("returns 504 when the hung judge leg hits the same hard cap as the panel", async () => {
    const handleSingleModel = vi.fn((_body, model, opts = {}) => {
      if (opts?.isPanel) return okResponse(`ans-${model}`);
      return new Promise(() => {}); // judge never settles → hard cap must fire
    });

    const t0 = Date.now();
    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["anthropic/a", "anthropic/b"],
      handleSingleModel,
      log,
      judgeModel: "anthropic/judge",
      tuning: { minPanel: 2, stragglerGraceMs: 10, panelHardTimeoutMs: 50 },
    });

    expect(res.status).toBe(504);
    expect(Date.now() - t0).toBeLessThan(2000); // did not stall on the hung judge
    // The judge leg was actually reached (2 panel + 1 judge call).
    expect(handleSingleModel.mock.calls.length).toBe(3);
  });

  it("re-runs the lone survivor with the original stream:true body (wrapped in the leg cap)", async () => {
    const handleSingleModel = vi.fn(async (_body, model, opts = {}) => {
      if (model === "anthropic/ok" && !opts?.isPanel) return okResponse("re-run-stream");
      if (model === "anthropic/ok") return okResponse("lone");
      return errResponse(500);
    });

    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }], stream: true },
      models: ["anthropic/ok", "anthropic/bad"],
      handleSingleModel,
      log,
      judgeModel: "anthropic/judge",
      tuning: { minPanel: 2, stragglerGraceMs: 10, panelHardTimeoutMs: 5000 },
    });

    // No judge call — single answer. Survivor re-run preserves the stream flag.
    expect(handleSingleModel.mock.calls.some(([, m]) => m === "anthropic/judge")).toBe(false);
    const rerun = handleSingleModel.mock.calls.find(([, m, o]) => m === "anthropic/ok" && !o?.isPanel);
    expect(rerun).toBeDefined();
    expect(rerun[0].stream).toBe(true);
    expect(res.ok).toBe(true);
  });

  it("returns 502 when the judge leg throws", async () => {
    const handleSingleModel = vi.fn((_body, model, opts = {}) => {
      if (opts?.isPanel) return okResponse(`ans-${model}`);
      return Promise.reject(new Error("judge exploded"));
    });

    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["anthropic/a", "anthropic/b"],
      handleSingleModel,
      log,
      judgeModel: "anthropic/judge",
      tuning: { minPanel: 2, stragglerGraceMs: 10, panelHardTimeoutMs: 5000 },
    });

    expect(res.status).toBe(502);
    const json = await res.clone().json();
    expect(json.error.message).toContain("judge exploded");
  });

  it("rethrows AbortError on client disconnect instead of swallowing it", async () => {
    const makeJudge = (_body, _model, opts = {}) => new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("client disconnected"), { name: "AbortError" }));
      }, { once: true });
    });
    const handleSingleModel = vi.fn((body, model, opts = {}) => {
      if (opts?.isPanel) return okResponse(`ans-${model}`);
      return makeJudge(body, model, opts);
    });

    const ctrl = new AbortController();
    const call = handleFusionChat({
      body: { messages: [{ role: "user", content: "Q" }] },
      models: ["anthropic/a", "anthropic/b"],
      handleSingleModel,
      log,
      judgeModel: "anthropic/judge",
      tuning: { minPanel: 2, stragglerGraceMs: 10, panelHardTimeoutMs: 5000 },
      signal: ctrl.signal,
    });

    setTimeout(() => ctrl.abort(new Error("client disconnected")), 20);
    await expect(call).rejects.toMatchObject({ name: "AbortError" });
  });
});
