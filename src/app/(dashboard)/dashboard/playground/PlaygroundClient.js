"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { PageHeader, SegmentedControl, Button, CardSkeleton, ConfirmModal, Modal } from "@/shared/components";
import ModelPicker from "./components/ModelPicker";
import ParameterPanel from "./components/ParameterPanel";
import StatsBar from "./components/StatsBar";
import HistoryPanel from "./components/HistoryPanel";
import ChatArea from "./components/ChatArea";
import MessageContent from "./components/MessageContent";
import { usePlaygroundStream } from "./usePlaygroundStream";
import {
  appendDelta,
  compareSlotKey,
  emptyCompareResult,
  mergeCompareDelta,
  mergeCompareFinal,
  patchMessage,
  displayMessages,
  buildSession,
  saveSessionsToStorage,
  MAX_STORED_MESSAGES,
  MAX_SESSIONS,
} from "./playgroundCore";

const STORAGE_KEY = "extremerouter.playground.sessions";

function createId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// Strip provider internals from upstream error messages before display.
// Removes URLs, request_ids, bearer/API-key fragments, and collapses long
// embedded JSON so the bubble stays readable and doesn't leak internals.
function sanitizeProviderError(message) {
  let s = typeof message === "string" ? message : String(message ?? "");
  // Strip http(s) URLs.
  s = s.replace(/https?:\/\/[^\s"'<>]+/g, "[url]");
  // Strip common token shapes (bearer tokens, AWS sig, long hex/base64 blobs).
  s = s.replace(/(Bearer\s+)[A-Za-z0-9._\-]{16,}/gi, "$1[token]");
  s = s.replace(/(signature=)[A-Za-z0-9%+/=]{16,}/gi, "$1[sig]");
  // Collapse embedded JSON objects (common in 4xx/5xx provider bodies).
  s = s.replace(/\{[\s\S]{80,}\}/g, "[provider json]");
  // Cap total length to keep the bubble sane.
  if (s.length > 300) s = s.slice(0, 297) + "...";
  return s.trim();
}

function loadSessions() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

// Returns "saved" | "stripped" | "failed" so the UI can surface quota outcomes
// instead of failing silently. Persistence logic (capping, quota fallback with
// stripped image payloads) lives in playgroundCore for testability.
function saveSessions(sessions) {
  return saveSessionsToStorage(localStorage, sessions);
}

export default function PlaygroundClient() {
  const [loading, setLoading] = useState(true);
  const [models, setModels] = useState([]);
  // Active provider connections + model aliases — fed to ModelSelectModal so the
  // picker shows the user's actually-connected providers + custom models, not the
  // flat /v1/models list. Mirrors the pattern used by cli-tools ToolDetailClient.
  const [activeProviders, setActiveProviders] = useState([]);
  const [modelAliases, setModelAliases] = useState({});
  const [sessions, setSessions] = useState([]);
  const [currentSession, setCurrentSession] = useState(null);

  // Chat state
  const [messages, setMessages] = useState([]);
  const [compareResults, setCompareResults] = useState({});

  // Mode: "single" or "compare"
  const [mode, setMode] = useState("single");

  // Selected models (1 for single, 2-4 for compare)
  const [selectedModels, setSelectedModels] = useState([""]);

  // Parameters
  const [params, setParams] = useState({
    systemPrompt: "",
    temperature: 0.7,
    maxTokens: 4096,
    topP: 1,
    frequencyPenalty: 0,
    presencePenalty: 0,
    topK: null,
    seed: null,
    reasoningEffort: "",
  });

  // Stats
  const [stats, setStats] = useState({});
  const apiKeyRef = useRef(null);

  // Per-stream context: { id → { mode, assistantId, modelId, startTime } }
  // Lets the shared hook callbacks know which message/result slot to update.
  const streamContextRef = useRef({});

  // B1: pending compare send awaiting cost confirmation + one-time skip flag per
  // compare session so we don't nag on every subsequent message.
  const [pendingSend, setPendingSend] = useState(null); // { text, attachments }
  const compareSkippedRef = useRef(false);

  // B2: transient save-feedback ("saved" | "stripped" | "failed").
  const [saveStatus, setSaveStatus] = useState(null);
  const saveStatusTimer = useRef(null);

  const flashSaveStatus = useCallback((status) => {
    setSaveStatus(status);
    if (saveStatusTimer.current) clearTimeout(saveStatusTimer.current);
    saveStatusTimer.current = setTimeout(() => setSaveStatus(null), 3000);
  }, []);

  // B3: gateway requires an API key but none exists → show a CTA instead of
  // letting every request fail with an opaque 401.
  const [authBanner, setAuthBanner] = useState(false);
  // B4: model/provider-load diagnostics + retry instead of a silently empty picker.
  const [modelError, setModelError] = useState(null);
  // B5: which side panel is open on mobile (history | params | null).
  const [mobilePanel, setMobilePanel] = useState(null);

  // ── Stream callbacks (stable — read context from ref) ──────────────────────
  //
  // These use functional state updates so concurrent compare-mode streams never
  // race on a shared mutable object. Each stream owns its `id` slot.

  const handleDelta = useCallback((id, parsed) => {
    const ctx = streamContextRef.current[id];
    if (!ctx) return;
    if (ctx.mode === "single") {
      setMessages(prev => patchMessage(prev, ctx.assistantId, {
        content: appendDelta(prev.find(m => m.id === ctx.assistantId)?.content, parsed.content),
        reasoning: appendDelta(prev.find(m => m.id === ctx.assistantId)?.reasoning, parsed.reasoning),
      }));
    } else {
      setCompareResults(prev => mergeCompareDelta(prev, id, parsed));
    }
  }, []);

  const handleComplete = useCallback((id, { usage }) => {
    const ctx = streamContextRef.current[id];
    if (!ctx) return;
    if (ctx.mode === "single") {
      setMessages(prev => patchMessage(prev, ctx.assistantId, { streaming: false }));
      setStats({
        model: ctx.modelId,
        inputTokens: usage?.prompt_tokens || 0,
        outputTokens: usage?.completion_tokens || 0,
        latencyMs: Date.now() - ctx.startTime,
      });
    } else {
      setCompareResults(prev => mergeCompareFinal(prev, id, { streaming: false, usage }));
    }
    delete streamContextRef.current[id];
  }, []);

  const handleError = useCallback((id, message) => {
    const ctx = streamContextRef.current[id];
    if (!ctx) return;
    // #10: strip provider internals from error messages before showing — upstream
    // errors can leak URLs, auth fragments, request_ids, and verbose JSON that
    // shouldn't surface in the chat bubble.
    const cleaned = sanitizeProviderError(message);
    if (ctx.mode === "single") {
      setMessages(prev => patchMessage(prev, ctx.assistantId, {
        content: `❌ Error: ${cleaned}`, streaming: false, error: true,
      }));
    } else {
      setCompareResults(prev => mergeCompareFinal(prev, id, {
        content: `❌ ${cleaned}`, streaming: false, error: true,
      }));
    }
    delete streamContextRef.current[id];
  }, []);

  const { streamChat, abortAll, streaming } = usePlaygroundStream({
    onDelta: handleDelta,
    onComplete: handleComplete,
    onError: handleError,
  });

  // ── Init ──────────────────────────────────────────────────────────────────

  // B4: (re)load active provider connections + model aliases + model catalog.
  // Extracted so the picker gets a working retry button when it fails.
  const refreshModels = useCallback(async () => {
    setModelError(null);
    try {
      const [providersRes, aliasesRes, modelsRes] = await Promise.all([
        fetch("/api/providers"),
        fetch("/api/models/alias"),
        fetch("/api/v1/models"),
      ]);
      const providersData = await providersRes.json();
      setActiveProviders((providersData.connections || []).filter((c) => c.isActive !== false));
      const aliasesData = await aliasesRes.json();
      setModelAliases(aliasesData.aliases || {});
      const modelsData = await modelsRes.json();
      const list = (modelsData.data || []).map((m) => ({
        id: m.id,
        name: m.id,
        provider: m.owned_by || m.id.split("/")[0],
      }));
      setModels(list);
      if (list.length > 0) setSelectedModels((prev) => (prev[0] ? prev : [list[0].id]));
    } catch (e) {
      setModelError(e?.message || "Failed to load models");
    }
  }, []);

  useEffect(() => {
    (async () => {
      const loaded = loadSessions();
      setSessions(loaded);
      // Fetch API key for auth (needed if requireApiKey is on)
      try {
        const keysRes = await fetch("/api/keys");
        const keysData = await keysRes.json();
        const activeKey = (keysData.keys || keysData || []).find?.((k) => k.isActive !== false);
        if (activeKey?.key) apiKeyRef.current = activeKey.key;
      } catch {}
      // B3: if the gateway requires an API key but none exists, tell the user how
      // to fix it instead of letting requests fail with an opaque 401.
      try {
        const sRes = await fetch("/api/settings");
        const sData = await sRes.json();
        const required = sData.requireApiKey === true;
        setAuthBanner(required && !apiKeyRef.current);
      } catch {
        setAuthBanner(false);
      }
      await refreshModels();
      setLoading(false);
    })();
  }, [refreshModels]);

  // ── Session management ────────────────────────────────────────────────────

  // B1: reset the compare cost-confirmation skip flag whenever the user leaves
  // compare mode, so re-entering compare asks to confirm again.
  useEffect(() => {
    if (mode === "single") compareSkippedRef.current = false;
  }, [mode]);

  const newSession = useCallback(() => {
    if (messages.length > 0 && currentSession) {
      updateSession(currentSession, messages);
    }
    setPendingSend(null);
    setMessages([]);
    setCurrentSession(null);
    setStats({});
    setCompareResults({});
  }, [messages, currentSession]);

  const loadSession = useCallback((session) => {
    if (messages.length > 0 && currentSession) {
      updateSession(currentSession, messages);
    }
    setMessages(session.messages || []);
    setCurrentSession(session.id);
    // Restore the full playground state: mode + model list (compare) + the
    // last compare round. Previously only a single `model` string was stored,
    // so compare chats could never be restored.
    if (Array.isArray(session.models) && session.models.length > 0) {
      setSelectedModels([...session.models]);
    } else if (session.model) {
      setSelectedModels([session.model]);
    }
    if (session.mode) setMode(session.mode);
    if (session.params) setParams(session.params);
    setStats({});
    setCompareResults(session.compareResults ? { ...session.compareResults } : {});
  }, [messages, currentSession]);

  const deleteSession = useCallback((id) => {
    const updated = sessions.filter((s) => s.id !== id);
    setSessions(updated);
    saveSessions(updated);
    if (currentSession === id) {
      setCurrentSession(null);
      setMessages([]);
    }
  }, [sessions, currentSession]);

  const updateSession = useCallback((id, msgs) => {
    const updated = sessions
      .map((s) =>
        s.id === id ? { ...s, messages: msgs.slice(-MAX_STORED_MESSAGES), updatedAt: Date.now() } : s
      )
      .slice(0, MAX_SESSIONS);
    setSessions(updated);
    saveSessions(updated);
  }, [sessions]);

  const saveCurrentSession = useCallback(() => {
    // Compare mode writes to compareResults (not messages); single mode writes
    // to messages. A session is savable as long as EITHER has content.
    const hasMessages = messages.length > 0;
    const hasCompare = mode === "compare" && Object.keys(compareResults).length > 0;
    if (!hasMessages && !hasCompare) return;
    const id = currentSession || createId();
    const session = buildSession({
      id,
      messages,
      params,
      selectedModels,
      mode,
      compareResults,
    });
    const existing = sessions.find((s) => s.id === id);
    const updated = existing
      ? sessions.map((s) => (s.id === id ? { ...s, ...session } : s))
      : [session, ...sessions];
    const capped = updated.slice(0, MAX_SESSIONS);
    setSessions(capped);
    const status = saveSessions(capped);
    setCurrentSession(id);
    flashSaveStatus(status);
  }, [messages, currentSession, sessions, selectedModels, params, mode, compareResults, flashSaveStatus]);

  // ── Chat send ─────────────────────────────────────────────────────────────

  // #19: Cap conversation length to avoid unbounded memory + localStorage growth.
  // Keeps the last MAX_MESSAGES turns; older context is dropped from the request
  // body (the user can still see them in the rendered history above).
  const MAX_MESSAGES = 50;

  const buildRequestBody = useCallback((text, attachments = []) => {
    // Build OpenAI multimodal content when images are attached:
    //   content: [{ type: "text", text }, { type: "image_url", image_url: { url: dataUrl } }]
    // Plain text stays a string (most efficient + universally accepted).
    const hasImages = attachments.length > 0;
    const userContent = hasImages
      ? [
          { type: "text", text },
          ...attachments.map((att) => ({
            type: "image_url",
            image_url: { url: att.dataUrl },
          })),
        ]
      : text;
    // For display we keep a plain-text version (images rendered separately
    // via the attachments preview that already showed before send).
    const userMsg = { role: "user", content: userContent, id: createId(),
      // Display-only metadata so the bubble can render a thumbnail.
      displayText: text, displayAttachments: hasImages ? attachments : undefined };

    // Cap history: keep system prompt + last MAX_MESSAGES turns.
    const history = [...messages];
    if (params.systemPrompt) history.unshift({ role: "system", content: params.systemPrompt });
    const trimmed = history.slice(-MAX_MESSAGES);
    const baseMessages = [...trimmed, userMsg];

    // Build optional params — only include fields the user actually set, so we
    // don't push defaults/nulls upstream (some providers reject `seed: null`).
    const requestParams = {
      temperature: params.temperature,
      max_tokens: params.maxTokens,
      top_p: params.topP,
    };
    if (params.frequencyPenalty) requestParams.frequency_penalty = params.frequencyPenalty;
    if (params.presencePenalty) requestParams.presence_penalty = params.presencePenalty;
    if (params.topK) requestParams.top_k = params.topK;
    if (params.seed != null) requestParams.seed = params.seed;
    if (params.reasoningEffort) requestParams.reasoning_effort = params.reasoningEffort;
    return { userMsg, baseMessages, requestParams };
  }, [messages, params]);

  // B1: the actual send (single or compare fan-out). Kept separate from
  // `sendMessage` so compare sends can be gated behind a cost confirmation.
  const runSend = useCallback(async (text, attachments = []) => {
    const { userMsg, baseMessages, requestParams } = buildRequestBody(text, attachments);
    const apiKey = apiKeyRef.current;
    const startTime = Date.now();

    if (mode === "single") {
      const modelId = selectedModels[0];
      if (!modelId) return;

      const assistantId = createId();
      const assistantMsg = { role: "assistant", content: "", reasoning: "", id: assistantId, model: modelId, streaming: true };
      // Display messages: strip system prompt (sent in body only) + normalize
      // user content to plain text for the bubble (attachments rendered via
      // the `attachments` field, not inlined as a content array).
      setMessages([...displayMessages(baseMessages), assistantMsg]);

      streamContextRef.current["single"] = { mode: "single", assistantId, modelId, startTime };
      await streamChat("single", {
        body: { model: modelId, messages: baseMessages, ...requestParams },
        apiKey,
      });
    } else {
      // Compare mode: send to all selected models simultaneously. Each slot gets
      // its own key (compareSlotKey) so the SAME model in two slots streams into
      // two separate panels — keying by modelId alone made the second stream
      // overwrite the first's context and freeze at "Waiting…".
      const slots = selectedModels
        .map((modelId, idx) => ({ modelId, key: compareSlotKey(idx, modelId) }))
        .filter((s) => s.modelId);
      if (slots.length === 0) return;

      const seeded = {};
      for (const s of slots) seeded[s.key] = emptyCompareResult();
      setCompareResults(seeded);
      slots.forEach((s) => {
        streamContextRef.current[s.key] = { mode: "compare", modelId: s.modelId, startTime };
      });

      await Promise.allSettled(slots.map((s) =>
        streamChat(s.key, {
          body: { model: s.modelId, messages: baseMessages, ...requestParams },
          apiKey,
        })
      ));

      setStats({ compareLatencyMs: Date.now() - startTime, models: slots.length });
    }
  }, [mode, selectedModels, buildRequestBody, streamChat]);

  const sendMessage = useCallback(async (text, attachments = []) => {
    if ((!text.trim() && attachments.length === 0) || streaming) return;

    // B1: cost-amplification guard — a compare fan-out turns one request into N
    // upstream calls (~N× tokens). Require an explicit confirmation the first
    // time, then don't nag again within the same compare session.
    if (mode === "compare" && !compareSkippedRef.current) {
      const fanout = selectedModels.filter(Boolean).length;
      if (fanout > 1) {
        setPendingSend({ text, attachments });
        return;
      }
    }

    await runSend(text, attachments);
  }, [mode, streaming, selectedModels, runSend]);

  // B1: user confirmed the compare fan-out → remember the choice AND dispatch.
  const handleConfirmCompare = useCallback(() => {
    compareSkippedRef.current = true;
    if (pendingSend) {
      runSend(pendingSend.text, pendingSend.attachments);
      setPendingSend(null);
    }
  }, [pendingSend, runSend]);

  const handleStop = useCallback(() => {
    abortAll();
    // B5: drop stale per-stream context entries — the AbortError path never calls
    // handleComplete/handleError, so without this they'd leak for the session.
    streamContextRef.current = {};
    // Mark all in-flight messages/results as not streaming. The hook's
    // AbortError path doesn't call onError, so we finalize the UI here.
    setMessages(prev => prev.map(m => m.streaming ? { ...m, streaming: false } : m));
    setCompareResults(prev => {
      const updated = {};
      for (const [k, v] of Object.entries(prev)) updated[k] = { ...v, streaming: false };
      return updated;
    });
  }, [abortAll]);

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Playground" description="Test models, compare outputs, tune parameters" icon="science" />
        <CardSkeleton />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PageHeader
        title="Playground"
        description="Test models, compare outputs, tune parameters"
        icon="science"
        actions={
          <div className="flex items-center gap-2">
            <SegmentedControl
              options={[
                { value: "single", label: "Chat" },
                { value: "compare", label: "Compare" },
              ]}
              value={mode}
              onChange={setMode}
              size="sm"
            />
            <Button size="sm" variant="ghost" icon={streaming ? "stop" : "save"} onClick={streaming ? handleStop : saveCurrentSession} disabled={!streaming && messages.length === 0}>
              {streaming ? "Stop" : "Save"}
            </Button>
            {/* B5: side panels reachable on mobile (hidden on lg+ where they're inline) */}
            <Button size="sm" variant="ghost" icon="history" className="lg:hidden" aria-label="Open history" onClick={() => setMobilePanel("history")} />
            <Button size="sm" variant="ghost" icon="tune" className="lg:hidden" aria-label="Open parameters" onClick={() => setMobilePanel("params")} />
            {saveStatus && (
              <span className="text-xs text-text-muted" role="status" aria-live="polite">
                {saveStatus === "saved" && "Saved"}
                {saveStatus === "stripped" && "Saved — images removed to fit storage"}
                {saveStatus === "failed" && "Save failed"}
              </span>
            )}
          </div>
        }
      />

      {/* B3/B4: actionable diagnostics instead of opaque failures */}
      {(authBanner || modelError) && (
        <div className="flex flex-col gap-2">
          {authBanner && (
            <div className="flex items-center justify-between gap-3 rounded-brand border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
              <span>
                <b>API key required.</b> The gateway requires an API key for requests, but no active key was found — sends will fail with a 401.
              </span>
              <a href="/dashboard/endpoint" className="shrink-0 font-semibold underline hover:text-warning/80">Create an API key →</a>
            </div>
          )}
          {modelError && (
            <div className="flex items-center justify-between gap-3 rounded-brand border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
              <span className="truncate">Failed to load models: {modelError}</span>
              <Button size="sm" variant="outline" icon="refresh" onClick={refreshModels}>Retry</Button>
            </div>
          )}
        </div>
      )}

      <div className="flex min-w-0 gap-4">
        {/* History sidebar (hidden on mobile) */}
        <div className="hidden w-56 shrink-0 lg:block">
          <HistoryPanel
            sessions={sessions}
            currentSession={currentSession}
            onNew={newSession}
            onLoad={loadSession}
            onDelete={deleteSession}
          />
        </div>

        {/* Center: chat / compare area */}
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {/* Model picker(s) */}
          {mode === "single" ? (
            <ModelPicker
              models={models}
              value={selectedModels[0]}
              onChange={(val) => setSelectedModels([val])}
              activeProviders={activeProviders}
              modelAliases={modelAliases}
            />
          ) : (
            <div className="flex flex-wrap gap-2">
              {selectedModels.map((modelId, idx) => (
                <div key={idx} className="flex items-center gap-1">
                  <ModelPicker
                    models={models}
                    value={modelId}
                    onChange={(val) => {
                      const next = [...selectedModels];
                      next[idx] = val;
                      setSelectedModels(next);
                    }}
                    compact
                    activeProviders={activeProviders}
                    modelAliases={modelAliases}
                  />
                  {selectedModels.length > 2 && (
                    <button
                      onClick={() => setSelectedModels(selectedModels.filter((_, i) => i !== idx))}
                      className="rounded-lg p-1.5 text-text-muted hover:bg-surface-2 hover:text-danger"
                    >
                      <span className="material-symbols-outlined text-[16px]">close</span>
                    </button>
                  )}
                </div>
              ))}
              {selectedModels.length < 4 && (
                <button
                  onClick={() => setSelectedModels([...selectedModels, ""])}
                  className="flex items-center gap-1 rounded-lg border border-dashed border-border px-3 py-1.5 text-xs text-text-muted hover:border-primary/40 hover:text-primary"
                >
                  <span className="material-symbols-outlined text-[14px]">add</span>
                  Add Model
                </button>
              )}
            </div>
          )}

          {/* Chat area or compare results */}
          {mode === "single" ? (
            <ChatArea
              messages={messages}
              onSend={sendMessage}
              streaming={streaming}
              stats={stats}
            />
          ) : (
            <div className="flex min-w-0 gap-3">
              {selectedModels.map((modelId, idx) => {
                if (!modelId) return null;
                // Per-slot key (not bare modelId) so duplicate models render
                // as separate panels with independent streams.
                const slotKey = compareSlotKey(idx, modelId);
                const result = compareResults[slotKey];
                return (
                  <div key={slotKey} className="flex min-w-0 flex-1 flex-col rounded-brand border border-border-subtle bg-panel">
                    <div className="border-b border-border-subtle px-3 py-2">
                      <span className="truncate text-xs font-medium text-text-main">{modelId}</span>
                    </div>
                    <div className="custom-scrollbar max-h-[60vh] min-h-[200px] overflow-y-auto p-3">
                      {result?.reasoning && (
                        <details className="mb-2 rounded bg-black/5 px-2 py-1 dark:bg-white/5">
                          <summary className="cursor-pointer text-[10px] font-medium text-text-muted">Reasoning</summary>
                          <p className="mt-1 whitespace-pre-wrap text-xs italic text-text-muted">{result.reasoning}</p>
                        </details>
                      )}
                      {result?.content ? (
                        <div className={`text-sm ${result.error ? "text-danger" : "text-text-main"}`}>
                          {result.error ? (
                            <p className="whitespace-pre-wrap break-words">{result.content}</p>
                          ) : (
                            <MessageContent content={result.content} role="assistant" />
                          )}
                          {result.streaming && <span className="ml-0.5 inline-block size-3 animate-pulse rounded-full bg-primary/50 align-middle" />}
                        </div>
                      ) : (
                        <p className="text-sm text-text-muted">
                          {streaming ? "Waiting..." : "Send a message to compare"}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Composer */}
          <Composer onSend={sendMessage} streaming={streaming} onStop={handleStop} />

          {/* Stats */}
          {Object.keys(stats).length > 0 && (
            <StatsBar stats={stats} mode={mode} />
          )}
        </div>

        {/* Parameters sidebar (hidden on mobile) */}
        <div className="hidden w-60 shrink-0 xl:block">
          <ParameterPanel
            params={params}
            onChange={setParams}
            selectedModel={selectedModels[0]}
          />
        </div>
      </div>

      {/* B1: compare fan-out cost confirmation */}
      <ConfirmModal
        isOpen={!!pendingSend}
        onClose={() => setPendingSend(null)}
        onConfirm={handleConfirmCompare}
        title="Send to multiple models at once?"
        message={
          pendingSend
            ? `Compare mode sends this exact prompt to ${selectedModels.filter(Boolean).length} models simultaneously. One request becomes ${selectedModels.filter(Boolean).length} upstream calls (~${selectedModels.filter(Boolean).length}× the tokens of a single request), billed by each provider.`
            : ""
        }
        confirmText="Compare all"
        cancelText="Cancel"
        variant="secondary"
      />

      {/* B5: history / params accessible on mobile via a modal (they're hidden
          inline below lg) */}
      <Modal isOpen={mobilePanel === "history"} onClose={() => setMobilePanel(null)} title="History" size="lg">
        <div className="max-h-[70vh] overflow-y-auto">
          <HistoryPanel
            sessions={sessions}
            currentSession={currentSession}
            onNew={newSession}
            onLoad={(s) => { loadSession(s); setMobilePanel(null); }}
            onDelete={deleteSession}
          />
        </div>
      </Modal>
      <Modal isOpen={mobilePanel === "params"} onClose={() => setMobilePanel(null)} title="Parameters" size="lg">
        <ParameterPanel params={params} onChange={setParams} selectedModel={selectedModels[0]} />
      </Modal>
    </div>
  );
}

// ── Inline composer (simpler than a separate file for this) ─────────────────

function Composer({ onSend, streaming, onStop }) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [imageNotice, setImageNotice] = useState(null);
  const noticeTimer = useRef(null);
  const ref = useRef(null);

  // MAX_IMAGE_SIZE: 5MB — base64 encoding ~4/3x the binary, so a 5MB image
  // becomes ~6.7MB in the request body. Larger images should be rejected to
  // avoid blowing the body-size limit (10MB) and to keep localStorage sane.
  const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

  const flashImageNotice = (msg) => {
    setImageNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setImageNotice(null), 4000);
  };

  const addImage = (file) => {
    if (!file || !file.type.startsWith("image/")) {
      flashImageNotice("Only image files can be attached");
      return;
    }
    if (file.size > MAX_IMAGE_SIZE) {
      flashImageNotice("Image too large — max 5MB");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setAttachments((prev) => [...prev, { id: createId(), dataUrl: reader.result, name: file.name }]);
    };
    reader.readAsDataURL(file);
  };

  const handlePaste = (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    let hadImage = false;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        hadImage = true;
        addImage(item.getAsFile());
      }
    }
    if (hadImage) e.preventDefault(); // don't paste image filename as text
  };

  const handleSend = () => {
    if ((!text.trim() && attachments.length === 0) || streaming) return;
    onSend(text, attachments);
    setText("");
    setAttachments([]);
    if (ref.current) ref.current.style.height = "auto";
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const canSend = (text.trim() || attachments.length > 0) && !streaming;

  return (
    <div className="flex flex-col gap-2 rounded-brand border border-border-subtle bg-panel p-2">
      {/* Attachment previews */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {attachments.map((att) => (
            <div key={att.id} className="group relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={att.dataUrl}
                alt={att.name}
                className="h-16 w-16 rounded-lg border border-border-subtle object-cover"
              />
              <button
                onClick={() => setAttachments((prev) => prev.filter((a) => a.id !== att.id))}
                className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-danger text-white opacity-0 transition-opacity group-hover:opacity-100"
                title="Remove"
              >
                <span className="material-symbols-outlined text-[12px]">close</span>
              </button>
            </div>
          ))}
        </div>
      )}
      {imageNotice && (
        <p className="px-1 text-[10px] text-warning" role="status" aria-live="polite">{imageNotice}</p>
      )}
      <div className="flex items-end gap-2">
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
          }}
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
          placeholder="Send a message... (Enter to send, Shift+Enter for newline, paste images)"
          rows={1}
          className="custom-scrollbar max-h-[120px] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-text-main placeholder:text-text-muted focus:outline-none"
        />
        {streaming ? (
          <button
            onClick={onStop}
            className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-danger/15 text-danger hover:bg-danger/25"
            title="Stop"
            aria-label="Stop"
          >
            <span className="material-symbols-outlined text-[18px]">stop</span>
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!canSend}
            className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-white hover:bg-primary-hover disabled:opacity-40"
            title="Send"
            aria-label="Send"
          >
            <span className="material-symbols-outlined text-[18px]">send</span>
          </button>
        )}
      </div>
    </div>
  );
}
