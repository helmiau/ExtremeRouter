/**
 * Hierarchical Swarm Engine — flagship multi-agent orchestration strategy.
 *
 * Pipeline:
 *   Stage 0  Gatekeeper (Manager)     classify: simple → direct answer, complex → swarm
 *   Stage 1  Manager Analyze          decompose prompt → JSON execution strategy
 *   Stage 2  Staff Dispatch           assign subtasks → fan-out parallel workers
 *   Stage 3  Workers Execute          each worker runs its subtask (parallel, quorum)
 *   Stage 4  Staff Audit              compile worker outputs → technical audit report
 *   Stage 5  Manager Synthesis        produce final answer from audit (streamed to client)
 *
 * Persona-bleed protection: coordinators (Manager/Staff) get IDE system prompts
 * stripped; workers receive full unsanitized context so they write contextual code.
 *
 * Mirrors handleFusionChat's shape: takes `handleSingleModel` closure, reuses
 * flattenToolHistory / extractPanelText / appendUserTurn / collectPanel / withTimeout.
 */
import {
  flattenToolHistory,
  extractPanelText,
  appendUserTurn,
  collectPanel,
  withTimeout,
} from "./combo.js";
import { stripIdeSystemPrompt, buildWorkerDirective } from "./swarmPersona.js";
import { validateComboRoles } from "./providerCapabilities.js";
import {
  createSwarmRun,
  markStageStart,
  markStageDone,
  markWorkerStatus,
  markRunError,
  markRunComplete,
} from "./swarmTelemetry.js";

// Tuning defaults. Overridable per-combo via settings.comboStrategies[name].swarmTuning.
export const SWARM_DEFAULTS = {
  workerHardTimeoutMs: 90000,  // absolute cap per worker call
  workerQuorum: 2,             // min workers that must succeed before grace window
  stragglerGraceMs: 10000,     // wait this long for laggard workers once quorum hit
  managerTimeoutMs: 60000,     // cap for each coordinator (gatekeeper/manager/audit) call
  minWorkers: 2,               // if fewer workers succeed, fall back to direct
  maxWorkers: 8,               // safety cap on fan-out width
};

// ── Role prompts ──────────────────────────────────────────────────────────

const GATEKEEPER_PROMPT = [
  "=== SWARM GATEKEEPER ===",
  "You are the GATEKEEPER of a hierarchical swarm. Classify the user's most recent request as SIMPLE or COMPLEX.",
  "",
  "SIMPLE = greeting, small talk, a factual question, a one-line clarification, or anything answerable in under ~50 tokens without decomposition.",
  "COMPLEX = a coding task, multi-step build request, design problem, debugging session, or anything benefiting from decomposition into parallel specialist work.",
  "",
  "Respond with EXACTLY one line, nothing else:",
  "VERDICT: SIMPLE",
  "or",
  "VERDICT: COMPLEX",
].join("\n");

function buildManagerStrategyPrompt(userPrompt) {
  return [
    "=== SWARM MANAGER (STRATEGY) ===",
    "You are the MANAGER of a hierarchical swarm. Analyze the user's request and produce a high-level execution strategy that decomposes it into independent parallel subtasks.",
    "",
    "Respond with ONLY a JSON object (no markdown fences, no prose) of this exact shape:",
    `{`,
    `  "assessment": "<1-2 sentence summary of what the request needs>",`,
    `  "subtasks": [`,
    `    { "id": 1, "title": "<short title>", "role": "<architecture|game-logic|data-layer|ui|testing|security|devops|default>", "instruction": "<detailed instruction for the specialist worker>" }`,
    `  ]`,
    `}`,
    "",
    "Rules:",
    "- Aim for 2-5 subtasks. Each must be independently executable in parallel.",
    "- `role` must be one of the listed values; pick the best specialist fit.",
    "- `instruction` must be self-contained — a worker sees only its own subtask.",
    "- Do NOT include integration/assembly as a subtask; the Staff auditor + Manager synthesis handle that.",
    "",
    "=== USER REQUEST ===",
    userPrompt,
  ].join("\n");
}

function buildStaffAuditPrompt(subtasks) {
  // Use the id-matched `st.output` field (set by the caller) rather than
  // positional indexing into workerOutputs — positional breaks when any worker
  // fails or drops, misaligning every subsequent subtask→output mapping.
  const report = subtasks
    .map((st) => {
      const out = st.output || "(worker did not produce output)";
      return `### Subtask ${st.id}: ${st.title}\nRole: ${st.role}\nInstruction: ${st.instruction}\n\n#### Worker Output\n${out}`;
    })
    .join("\n\n---\n\n");

  return [
    "=== SWARM STAFF (AUDIT) ===",
    "You are the STAFF auditor of a hierarchical swarm. Specialist workers have independently completed their assigned subtasks. Your job is to produce a TECHNICAL AUDIT REPORT that the Manager will use to synthesize the final answer.",
    "",
    "For each worker output, evaluate:",
    "- Completeness: did it fulfill the subtask instruction?",
    "- Correctness: any bugs, type errors, logic flaws, or missing edge cases?",
    "- Consistency: naming conflicts, duplicated logic, or mismatched interfaces with other workers?",
    "- Integration risks: what will need reconciliation when combining outputs?",
    "",
    "Then provide a CONSOLIDATION PLAN: the order in which outputs should be merged, what conflicts to resolve, and what gaps remain.",
    "",
    "=== SUBTASKS & WORKER OUTPUTS ===",
    report,
    "=== END ===",
    "",
    "Now write the technical audit report. Be concrete and specific. Reference subtask IDs.",
  ].join("\n");
}

function buildManagerSynthesisPrompt(auditReport, userPrompt) {
  return [
    "=== SWARM MANAGER (SYNTHESIS) ===",
    "You are the MANAGER producing the FINAL ANSWER. A Staff auditor has reviewed the parallel worker outputs and produced a technical audit report below. Synthesize ONE cohesive, complete, production-quality answer for the user's original request.",
    "",
    "Rules:",
    "- Resolve any conflicts the auditor flagged.",
    "- Integrate all worker outputs into a single coherent result (codebase, explanation, or both).",
    "- Do NOT mention the swarm, workers, audit, or that multiple agents were used. The user sees only your final answer.",
    "- Match the user's language and intent exactly.",
    "",
    "=== TECHNICAL AUDIT REPORT ===",
    auditReport,
    "=== END AUDIT ===",
    "",
    "=== ORIGINAL USER REQUEST ===",
    userPrompt,
    "",
    "Now produce the final answer.",
  ].join("\n");
}

// ── Helpers ───────────────────────────────────────────────────────────────

function extractUserPrompt(body) {
  // Get the last user message text across formats.
  for (const key of ["messages", "input"]) {
    if (Array.isArray(body[key])) {
      for (let i = body[key].length - 1; i >= 0; i--) {
        const m = body[key][i];
        if (m?.role === "user") {
          if (typeof m.content === "string") return m.content;
          if (Array.isArray(m.content)) {
            return m.content.map((p) => (typeof p === "string" ? p : p?.text || "")).join("");
          }
        }
      }
    }
  }
  if (Array.isArray(body.contents)) {
    const last = body.contents[body.contents.length - 1];
    if (last?.role === "user" && Array.isArray(last.parts)) {
      return last.parts.map((p) => p?.text || "").join("");
    }
  }
  return "";
}

/**
 * Scan a string for top-level JSON object blocks using brace-depth tracking
 * with string-context awareness. Unlike a regex, this correctly handles braces
 * inside string values (e.g. code snippets like "function foo() { return 1; }").
 *
 * Yields each complete `{...}` substring. Incomplete trailing blocks (unbalanced)
 * are skipped — this is intentional for recovering subtasks from truncated output.
 */
function* scanJsonBlocks(text) {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        yield text.slice(start, i + 1);
        start = -1;
      }
    }
  }
}

function parseStrategy(text) {
  if (!text) return null;
  // Strip markdown fences if present.
  const cleaned = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();

  // Attempt 1: full strict JSON parse of the outermost object.
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    try {
      const obj = JSON.parse(cleaned.slice(start, end + 1));
      if (Array.isArray(obj.subtasks) && obj.subtasks.length > 0) return obj;
    } catch {
      // fall through to lenient recovery
    }
  }

  // Attempt 2: lenient recovery for truncated JSON. Reasoning models that hit
  // max_tokens mid-output produce a strategy whose trailing braces are missing,
  // so the strict parse above fails. Salvage whatever complete subtask objects
  // already landed on the wire. Uses a brace-depth scanner that respects
  // string context (quotes) — the old regex [^{}] broke on braces inside
  // string values (e.g. code snippets like "return { foo: 1 }").
  const subtaskBlocks = [];
  for (const blockText of scanJsonBlocks(cleaned)) {
    // Only accept blocks that look like subtask objects (have an "id" field).
    if (!/"id"\s*:/.test(blockText)) continue;
    try {
      const parsed = JSON.parse(blockText);
      if (parsed && (parsed.title || parsed.instruction || parsed.role)) {
        subtaskBlocks.push({
          id: typeof parsed.id === "number" ? parsed.id : subtaskBlocks.length + 1,
          title: parsed.title || `Subtask ${subtaskBlocks.length + 1}`,
          role: parsed.role || "default",
          instruction: parsed.instruction || parsed.title || "",
        });
      }
    } catch {
      // skip unparseable individual block
    }
  }
  if (subtaskBlocks.length > 0) {
    return { assessment: "(recovered from truncated output)", subtasks: subtaskBlocks };
  }

  return null;
}

// Build a non-streaming, tool-stripped body for coordinator/worker calls.
function buildPanelBody(body) {
  const { tools, tool_choice, ...rest } = body;
  const panelBody = { ...rest, stream: false };
  if (Array.isArray(panelBody.messages)) {
    panelBody.messages = flattenToolHistory(panelBody.messages);
  }
  return panelBody;
}

// ── Stage runners ─────────────────────────────────────────────────────────

// Track consecutive gatekeeper failures per provider. If the same provider's
// gatekeeper keeps failing (timeout, parse error), log a warning so operators
// can investigate — the fallback to "complex" wastes a full swarm pipeline
// on every request when the manager model is broken.
const _gatekeeperFailures = new Map(); // provider → consecutive failure count
const GATEKEEPER_WARN_THRESHOLD = 3;

async function runGatekeeper({ runId, body, managerModel, handleSingleModel, cfg, log }) {
  markStageStart(runId, "gatekeeper", { model: managerModel });
  const prompt = extractUserPrompt(body);
  const gateBody = stripIdeSystemPrompt(buildPanelBody(body));
  const directiveBody = appendUserTurn(gateBody, GATEKEEPER_PROMPT);

  try {
    const res = await withTimeout(handleSingleModel(directiveBody, managerModel, { isPanel: true, role: "gatekeeper" }), cfg.managerTimeoutMs);
    if (res?.__timeout || res?.__error) {
      markStageDone(runId, "gatekeeper", { verdict: "complex" }); // assume complex on failure
      _trackGatekeeperFailure(managerModel, log);
      return "complex";
    }
    const text = extractPanelText(await res.response.clone().json().catch(() => ({})));
    const verdict = /VERDICT:\s*SIMPLE/i.test(text) ? "simple" : "complex";
    markStageDone(runId, "gatekeeper", { verdict });
    // Reset failure counter on any successful response (even if verdict is "complex"
    // — "complex" is a valid verdict, not a failure).
    _gatekeeperFailures.delete(managerModel);
    log?.info?.("SWARM", `Gatekeeper verdict: ${verdict}`);
    return verdict;
  } catch (e) {
    log?.warn?.("SWARM", `Gatekeeper error, assuming complex: ${e?.message || e}`);
    markStageDone(runId, "gatekeeper", { verdict: "complex" });
    _trackGatekeeperFailure(managerModel, log);
    return "complex";
  }
}

function _trackGatekeeperFailure(managerModel, log) {
  const count = (_gatekeeperFailures.get(managerModel) || 0) + 1;
  _gatekeeperFailures.set(managerModel, count);
  if (count === GATEKEEPER_WARN_THRESHOLD) {
    log?.warn?.("SWARM", `Gatekeeper has failed ${count} consecutive times for ${managerModel}. Every request is falling through to a full swarm pipeline — the manager model may be degraded.`);
  }
}

async function runManagerStrategy({ runId, body, managerModel, handleSingleModel, cfg, log }) {
  markStageStart(runId, "manager", { model: managerModel });
  const userPrompt = extractUserPrompt(body);
  const mgrBody = stripIdeSystemPrompt(buildPanelBody(body));
  const directiveBody = appendUserTurn(mgrBody, buildManagerStrategyPrompt(userPrompt));

  try {
    const res = await withTimeout(handleSingleModel(directiveBody, managerModel, { isPanel: true, role: "manager" }), cfg.managerTimeoutMs);
    if (res?.__timeout || res?.__error) {
      markStageDone(runId, "manager", { strategy: null });
      return null;
    }
    const text = extractPanelText(await res.response.clone().json().catch(() => ({})));
    const strategy = parseStrategy(text);
    markStageDone(runId, "manager", { strategy: strategy ? { subtaskCount: strategy.subtasks.length } : null });
    if (!strategy) log?.warn?.("SWARM", "Manager produced unparseable strategy");
    return strategy;
  } catch (e) {
    log?.warn?.("SWARM", `Manager strategy error: ${e?.message || e}`);
    markStageDone(runId, "manager", { strategy: null });
    return null;
  }
}

async function dispatchWorkers({ runId, strategy, models, body, handleSingleModel, cfg, log, runBudget }) {
  markStageStart(runId, "workers", { workerCount: strategy.subtasks.length });
  const subtasks = strategy.subtasks;
  const workerModels = models.filter(Boolean);
  if (workerModels.length === 0) {
    markStageDone(runId, "workers", { workers: [] });
    return [];
  }

  // Assign each subtask to a worker model (round-robin across available combo models).
  // `body` is threaded explicitly (NOT via module-level ref) to be safe under
  // concurrent swarm requests — a module-level ref would let two in-flight
  // requests clobber each other's prompt (cross-request leak + wrong output).
  const calls = subtasks.map((subtask, i) => {
    const workerModel = workerModels[i % workerModels.length];
    // Workers get FULL unsanitized context (no IDE strip) + specialist directive as user turn.
    const workerBody = appendUserTurn(buildPanelBody(body), buildWorkerDirective(subtask));
    markWorkerStatus(runId, i, "running", { model: workerModel });
    return withTimeout(handleSingleModel(workerBody, workerModel, { isPanel: true, role: "worker" }), cfg.workerHardTimeoutMs)
      .then(async (res) => {
        if (res?.__timeout || res?.__error) {
          markWorkerStatus(runId, i, "error", { model: workerModel });
          return { ok: false, text: "" };
        }
        // Wave 1C: application success comes from ChatResult.success — a
        // non-2xx Response (or any failed leg) is not usable worker output.
        if (!res?.success) {
          markWorkerStatus(runId, i, "error", { model: workerModel, status: res?.status ?? res?.response?.status });
          return { ok: false, text: "" };
        }
        const rawText = extractPanelText(await res.response.clone().json().catch(() => ({})));
        // Budget guard: clamp the worker's output so internal fan-out can never
        // exceed the combo's output cap. Over-budget output is dropped (worker fail).
        const text = runBudget ? runBudget.clampOutput(rawText) : rawText;
        if (rawText && !text) {
          markWorkerStatus(runId, i, "error", { model: workerModel, reason: "over_budget" });
          return { ok: false, text: "" };
        }
        markWorkerStatus(runId, i, "done", { model: workerModel, outputLen: text.length });
        return { ok: true, text, subtask };
      })
      .catch(() => {
        markWorkerStatus(runId, i, "error", { model: workerModel });
        return { ok: false, text: "" };
      });
  });

  const settled = await collectPanel(calls, {
    minPanel: Math.min(cfg.workerQuorum, calls.length),
    stragglerGraceMs: cfg.stragglerGraceMs,
    panelHardTimeoutMs: cfg.workerHardTimeoutMs,
  });

  const outputs = [];
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r && r.ok) outputs.push({ subtask: subtasks[i], text: r.text });
  }
  markStageDone(runId, "workers", { workers: settled.map((r, i) => ({ index: i, ok: !!r?.ok })) });
  return outputs;
}

async function runStaffAudit({ runId, strategy, workerOutputs, staffModel, auditModel, body, handleSingleModel, cfg, log, runBudget }) {
  const model = staffModel || auditModel;
  if (!model) {
    markStageDone(runId, "audit", { skipped: true });
    return null;
  }
  markStageStart(runId, "audit", { model });
  // Match worker outputs to subtasks by reference (not id) — the dispatch
  // stores the original subtask object reference, so this is always correct
  // even if the Manager emitted duplicate ids.
  const subtasksWithOutputs = strategy.subtasks.map((st) => {
    const match = workerOutputs.find((w) => w.subtask === st);
    return { ...st, output: match?.text || "(no output)" };
  });
  const auditBody = stripIdeSystemPrompt(buildPanelBody(body));
  const directiveBody = appendUserTurn(auditBody, buildStaffAuditPrompt(subtasksWithOutputs));

  try {
    const res = await withTimeout(handleSingleModel(directiveBody, model, { isPanel: true, role: "audit" }), cfg.managerTimeoutMs);
    if (res?.__timeout || res?.__error) {
      markStageDone(runId, "audit", { skipped: true });
      return null;
    }
    const text = extractPanelText(await res.response.clone().json().catch(() => ({})));
    markStageDone(runId, "audit", { reportLen: text.length });
    return runBudget ? runBudget.clampOutput(text) : text;
  } catch (e) {
    log?.warn?.("SWARM", `Staff audit error: ${e?.message || e}`);
    markStageDone(runId, "audit", { skipped: true });
    return null;
  }
}

// NOTE: `body` is threaded explicitly through every stage runner (not via a
// module-level ref). A module-level ref would be unsafe under concurrent swarm
// requests in the same process — two in-flight runs would clobber each other's
// prompt, leaking one user's content into the other's workers.

// ── Main entry ────────────────────────────────────────────────────────────

/**
 * Hierarchical Swarm orchestration. Mirrors handleFusionChat's contract.
 * @param {object} opts
 * @returns {Promise<Response>}
 */
export async function handleSwarmChat({
  body,
  models,
  handleSingleModel,
  log,
  comboName,
  managerModel,
  staffModel,
  auditModel,
  workerCount,
  swarmTuning,
  telemetry = true,
  signal,
  runBudget,
  principalId,
  autoScale,
}) {
  const panel = models.filter(Boolean);
  if (panel.length === 0) {
    return new Response(JSON.stringify({ error: "Swarm requires at least one worker model" }), { status: 400 });
  }

  const cfg = { ...SWARM_DEFAULTS, ...(swarmTuning || {}) };
  const manager = (managerModel || "").trim() || panel[0];
  const userPrompt = extractUserPrompt(body);

  // Single-model fast path: no point orchestrating a swarm over one model.
  // Wave 1C: unwrap ChatResult to the transport Response at the return boundary.
  if (panel.length === 1 && !managerModel && !staffModel && !auditModel) {
    const single = await handleSingleModel(body, panel[0], { role: "manager" });
    return single.response;
  }

  // Capability gate: control roles (Manager/Staff/Audit) require tool use +
  // file access. Web cookie providers cannot serve these roles — reject early
  // with a clear error rather than failing mid-pipeline. Pass `panel` as
  // fallback so empty role models (Auto) are validated against panel[0].
  const roleViolations = validateComboRoles("swarm", { managerModel, staffModel, auditModel }, panel);
  if (roleViolations.length > 0) {
    const details = roleViolations.map((v) => v.reason).join(" ");
    return new Response(
      JSON.stringify({ error: { message: `Swarm role validation failed: ${details}`, type: "capability_error" } }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const run = telemetry
    ? createSwarmRun({
        comboName,
        promptPreview: userPrompt,
        managerModel: manager,
        staffModel,
        auditModel,
        workerCount: workerCount || cfg.minWorkers,
      })
    : null;
  const runId = run?.runId;

  try {
    // ── Stage 0: Gatekeeper ──
    const verdict = telemetry
      ? await runGatekeeper({ runId, body, managerModel: manager, handleSingleModel, cfg, log })
      : (await runGatekeeperNoTelemetry({ body, managerModel: manager, handleSingleModel, cfg, log }));

    if (verdict === "simple") {
      // Manager answers directly, streaming to client (original body preserved).
      log?.info?.("SWARM", "Gatekeeper bypass — simple request, direct answer");
      if (runId) markRunComplete(runId, { bypassed: true });
      const direct = await handleSingleModel(body, manager, { role: "manager" });
      return direct.response;
    }

    // ── Stage 1: Manager Strategy ──
    const strategy = telemetry
      ? await runManagerStrategy({ runId, body, managerModel: manager, handleSingleModel, cfg, log })
      : (await runManagerStrategyNoTelemetry({ body, managerModel: manager, handleSingleModel, cfg, log }));

    if (!strategy || !Array.isArray(strategy.subtasks) || strategy.subtasks.length === 0) {
      // Strategy parse failed → fall back to direct answer.
      log?.warn?.("SWARM", "Strategy decomposition failed — falling back to direct answer");
      if (runId) markRunComplete(runId, { fallback: true });
      const fallbackAnswer = await handleSingleModel(body, manager, { role: "manager" });
      return fallbackAnswer.response;
    }

	    // Dynamic worker scaling: autoScale overrides static workerCount when enabled.
	    // When the gatekeeper finds many subtasks, more workers are dispatched up to
	    // autoScale.maxWorkers; few subtasks → minWorkers. Less manual tuning needed.
	    let effectiveWorkerCount;
	    if (autoScale?.enabled) {
	      effectiveWorkerCount = Math.min(
	        Math.max(strategy.subtasks.length, autoScale.minWorkers || 1),
	        autoScale.maxWorkers || cfg.maxWorkers,
	      );
	      log?.info?.("SWARM", `Auto-scale: ${strategy.subtasks.length} subtasks → ${effectiveWorkerCount} workers (${autoScale.minWorkers || 1}–${autoScale.maxWorkers || cfg.maxWorkers})`);
	    } else {
	      // Static: honor per-combo workerCount if set, else fall back to maxWorkers cap.
	      effectiveWorkerCount = (typeof workerCount === "number" && workerCount > 0)
	        ? Math.min(workerCount, cfg.maxWorkers)
	        : cfg.maxWorkers;
	    }
	    const effectiveSubtasks = strategy.subtasks.slice(0, effectiveWorkerCount);

    // ── Stage 2+3: Dispatch Workers (parallel) ──
    const workerOutputs = telemetry
      ? await dispatchWorkers({ runId, strategy: { subtasks: effectiveSubtasks }, models: panel, body, handleSingleModel, cfg, log, runBudget })
      : (await dispatchWorkersNoTelemetry({ strategy: { subtasks: effectiveSubtasks }, models: panel, body, handleSingleModel, cfg, log, runBudget }));

    if (workerOutputs.length < cfg.minWorkers) {
      // Too few workers succeeded → fall back to direct answer from best worker or manager.
      log?.warn?.("SWARM", `Only ${workerOutputs.length}/${effectiveSubtasks.length} workers succeeded — fallback`);
      if (runId) markRunComplete(runId, { fallback: true });
      if (workerOutputs.length === 1) {
        // Return the single worker's output directly — include the actual text
        // so the manager has visibility (previously the text was discarded).
        const workerText = workerOutputs[0].text || "";
        const workerAnswer = await handleSingleModel(appendUserTurn(body, `The specialist worker produced this answer for the subtask "${workerOutputs[0].subtask?.title || ""}". Output it verbatim to the user, adjusting only for formatting if needed:\n\n${workerText}`), manager, { role: "manager" });
        return workerAnswer.response;
      }
      const fallbackManager = await handleSingleModel(body, manager, { role: "manager" });
      return fallbackManager.response;
    }

    // ── Stage 4: Staff Audit ──
    const auditReport = telemetry
      ? await runStaffAudit({ runId, strategy: { subtasks: effectiveSubtasks }, workerOutputs, staffModel, auditModel, body, handleSingleModel, cfg, log, runBudget })
      : (await runStaffAuditNoTelemetry({ strategy: { subtasks: effectiveSubtasks }, workerOutputs, staffModel, auditModel, body, handleSingleModel, cfg, log, runBudget }));

    // ── Stage 5: Manager Synthesis (STREAMED to client) ──
    const synthesisDirective = auditReport
      ? buildManagerSynthesisPrompt(auditReport, userPrompt)
      : buildManagerSynthesisPrompt(workerOutputs.map((w) => w.text).join("\n\n---\n\n"), userPrompt);

    // Final call uses ORIGINAL body (tools restored, stream flag intact) so SSE reaches client.
    const synthBody = appendUserTurn(body, synthesisDirective);
    log?.info?.("SWARM", `Synthesizing final answer from ${workerOutputs.length} worker outputs`);

    // Wrap the synthesis call so telemetry completes when the stream actually
    // finishes — not when headers arrive. handleSingleModel returns a streaming
    // Response whose body may still be sending tokens. We tee the body's
    // completion to fire markStageDone + markRunComplete after the last chunk.
    if (runId) {
      markStageStart(runId, "synthesis", { model: manager });
      // Wave 1C: unwrap ChatResult — transport fields come from result.response.
      const res = (await handleSingleModel(synthBody, manager, { role: "manager" })).response;
      // If the response has a streaming body, wrap it to detect completion.
      if (res?.body) {
        const originalBody = res.body;
        const trackStream = new ReadableStream({
          start(controller) {
            const reader = originalBody.getReader();
            const pump = () =>
              reader.read().then(({ done, value }) => {
                if (done) {
                  controller.close();
                  markStageDone(runId, "synthesis");
                  markRunComplete(runId, { workerCount: workerOutputs.length });
                  return;
                }
                controller.enqueue(value);
                return pump();
              }).catch(() => {
                // Stream error (client disconnect, upstream failure) — mark as
                // done anyway so the telemetry run doesn't stay stuck "running".
                try { controller.close(); } catch { /* already closed */ }
                markStageDone(runId, "synthesis");
                markRunComplete(runId, { workerCount: workerOutputs.length });
              });
            pump();
          },
          cancel(reason) {
            // Client disconnected — mark complete to avoid stuck telemetry.
            markStageDone(runId, "synthesis");
            markRunComplete(runId, { workerCount: workerOutputs.length });
          },
        });
        return new Response(trackStream, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        });
      }
      // Non-streaming response — mark complete immediately.
      markStageDone(runId, "synthesis");
      markRunComplete(runId, { workerCount: workerOutputs.length });
      return res;
    }

    const synthNoTelemetry = await handleSingleModel(synthBody, manager, { role: "manager" });
    return synthNoTelemetry.response;
  } catch (e) {
    log?.error?.("SWARM", `Swarm failed: ${e?.message || e}`);
    if (runId) markRunError(runId, e);
    // Graceful degradation: fall back to direct answer on any uncaught error.
    const degraded = await handleSingleModel(body, manager, { role: "manager" });
    return degraded.response;
  }
}

// ── No-telemetry variants (leaner, used when telemetry disabled) ──────────

async function runGatekeeperNoTelemetry({ body, managerModel, handleSingleModel, cfg, log }) {
  const gateBody = stripIdeSystemPrompt(buildPanelBody(body));
  const directiveBody = appendUserTurn(gateBody, GATEKEEPER_PROMPT);
  try {
    const res = await withTimeout(handleSingleModel(directiveBody, managerModel, { isPanel: true, role: "gatekeeper" }), cfg.managerTimeoutMs);
    if (res?.__timeout || res?.__error) return "complex";
    const text = extractPanelText(await res.response.clone().json().catch(() => ({})));
    return /VERDICT:\s*SIMPLE/i.test(text) ? "simple" : "complex";
  } catch {
    return "complex";
  }
}

async function runManagerStrategyNoTelemetry({ body, managerModel, handleSingleModel, cfg, log }) {
  const userPrompt = extractUserPrompt(body);
  const mgrBody = stripIdeSystemPrompt(buildPanelBody(body));
  const directiveBody = appendUserTurn(mgrBody, buildManagerStrategyPrompt(userPrompt));
  try {
    const res = await withTimeout(handleSingleModel(directiveBody, managerModel, { isPanel: true, role: "manager" }), cfg.managerTimeoutMs);
    if (res?.__timeout || res?.__error) return null;
    const text = extractPanelText(await res.response.clone().json().catch(() => ({})));
    return parseStrategy(text);
  } catch {
    return null;
  }
}

async function dispatchWorkersNoTelemetry({ strategy, models, body, handleSingleModel, cfg, log, runBudget }) {
  const workerModels = models.filter(Boolean);
  if (workerModels.length === 0) return [];
  // Parse JSON in the parallel .then() (like the telemetry path) instead of
  // serially after collectPanel settles — avoids N×json-parse latency on the
  // critical path. Also checks ChatResult.success (Wave 1C) and filters empty
  // output consistently with the telemetry variant.
  const calls = strategy.subtasks.map((subtask, i) => {
    const workerModel = workerModels[i % workerModels.length];
    const workerBody = appendUserTurn(buildPanelBody(body), buildWorkerDirective(subtask));
    return withTimeout(handleSingleModel(workerBody, workerModel, { isPanel: true, role: "worker" }), cfg.workerHardTimeoutMs)
      .then(async (res) => {
        if (res?.__timeout || res?.__error) return { ok: false, text: "" };
        if (!res?.success) return { ok: false, text: "" };
        const rawText = extractPanelText(await res.response.clone().json().catch(() => ({})));
        // Budget guard: clamp worker output; drop over-budget output (worker fail).
        const text = runBudget ? runBudget.clampOutput(rawText) : rawText;
        if (rawText && !text) return { ok: false, text: "" };
        return { ok: true, text, subtask };
      })
      .catch(() => ({ ok: false, text: "" }));
  });
  const settled = await collectPanel(calls, {
    minPanel: Math.min(cfg.workerQuorum, calls.length),
    stragglerGraceMs: cfg.stragglerGraceMs,
    panelHardTimeoutMs: cfg.workerHardTimeoutMs,
  });
  // Filter: only include workers with ok:true AND non-empty text.
  // This matches the telemetry path's behavior (empty output → not counted).
  const outputs = [];
  for (const r of settled) {
    if (r && r.ok && r.text) outputs.push({ subtask: r.subtask, text: r.text });
  }
  return outputs;
}

async function runStaffAuditNoTelemetry({ strategy, workerOutputs, staffModel, auditModel, body, handleSingleModel, cfg, log, runBudget }) {
  const model = staffModel || auditModel;
  if (!model) return null;
  // Match by reference (same as telemetry path) — robust against duplicate ids.
  const subtasksWithOutputs = strategy.subtasks.map((st) => {
    const match = workerOutputs.find((w) => w.subtask === st);
    return { ...st, output: match?.text || "(no output)" };
  });
  const auditBody = stripIdeSystemPrompt(buildPanelBody(body));
  const directiveBody = appendUserTurn(auditBody, buildStaffAuditPrompt(subtasksWithOutputs));
  try {
    const res = await withTimeout(handleSingleModel(directiveBody, model, { isPanel: true, role: "audit" }), cfg.managerTimeoutMs);
    if (res?.__timeout || res?.__error) return null;
    const text = extractPanelText(await res.response.clone().json().catch(() => ({})));
    return runBudget ? runBudget.clampOutput(text) : text;
  } catch {
    return null;
  }
}
