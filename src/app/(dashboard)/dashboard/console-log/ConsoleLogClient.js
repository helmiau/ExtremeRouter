"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { Card, Button, PageHeader } from "@/shared/components";
import { CONSOLE_LOG_CONFIG } from "@/shared/constants/config";
import { cn } from "@/shared/utils/cn";

// ── Log line parsing ─────────────────────────────────────────────────────────

const LEVELS = ["error", "warn", "info", "debug", "log"];

const LEVEL_STYLE = {
  error: { label: "ERROR", text: "text-red-400", chip: "bg-red-500/15 text-red-400 border-red-500/30" },
  warn: { label: "WARN", text: "text-yellow-300", chip: "bg-yellow-500/15 text-yellow-300 border-yellow-500/30" },
  info: { label: "INFO", text: "text-sky-400", chip: "bg-sky-500/15 text-sky-400 border-sky-500/30" },
  debug: { label: "DEBUG", text: "text-purple-400", chip: "bg-purple-500/15 text-purple-400 border-purple-500/30" },
  log: { label: "LOG", text: "text-emerald-400", chip: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" },
};

// Rows cycle a small tag palette so components (STREAM, AUTH, USAGE…) are
// visually distinguishable without a hardcoded color per tag.
const TAG_PALETTE = [
  "text-cyan-300",
  "text-amber-300",
  "text-fuchsia-300",
  "text-lime-300",
  "text-orange-300",
  "text-teal-300",
];

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const LEVEL_TAGS = new Set(["LOG", "INFO", "WARN", "ERROR", "DEBUG", "TRACE", "FATAL"]);
const TS_RE = /^\[(\d{1,2}:\d{2}:\d{2})\]\s*/;

function tagColor(tag) {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
  return TAG_PALETTE[h % TAG_PALETTE.length];
}

// Find and consume the first bracketed token, tolerating a short decorative
// prefix (emoji/graphic like "📊 " before "[USAGE]"). Returns
// { token, rest, prefix } or null when there is no bracket token to take.
function takeBracketToken(rest) {
  const b = rest.indexOf("[");
  if (b === -1 || b > 6) return null;
  const prefix = rest.slice(0, b);
  if (/[A-Za-z0-9]/.test(prefix)) return null; // a word before "[" → not a tag
  const end = rest.indexOf("]", b);
  if (end === -1) return null;
  const token = rest.slice(b + 1, end);
  if (!token || token.length > 32) return null;
  // `rest` excludes the decorative prefix so callers can keep it in the text.
  return { token, rest: rest.slice(end + 1).replace(/^\s+/, ""), prefix };
}

/**
 * Parse one raw log line into { ts, level, tag, text, raw }.
 * Tolerant: anything unrecognized renders as a plain LOG line.
 * Exported for tests.
 */
export function parseLine(raw) {
  const line = String(raw).replace(ANSI_RE, "");
  let rest = line;
  let ts = null;

  const tsMatch = rest.match(TS_RE);
  if (tsMatch) {
    ts = tsMatch[1];
    rest = rest.slice(tsMatch[0].length);
  }

  let level = "log";
  let tag = null;

  const first = takeBracketToken(rest);
  if (first) {
    const token = first.token.toUpperCase();
    if (LEVEL_TAGS.has(token)) {
      level = token === "FATAL" ? "error" : token === "TRACE" ? "debug" : token.toLowerCase();
      rest = (first.prefix || "") + first.rest;
      // A second bracketed token right after the level is the component tag.
      const second = takeBracketToken(rest);
      if (second && !/^\d/.test(second.token)) {
        tag = second.token;
        rest = (second.prefix || "") + second.rest;
      }
    } else if (!/^\d/.test(first.token)) {
      tag = first.token;
      rest = (first.prefix || "") + first.rest;
    }
  }

  // Error shaping: ❌ markers and bare "Error:"-prefixed payloads are errors
  // even without an [ERROR] tag.
  if (level === "log" && (rest.includes("❌") || /^Error[:\s]/.test(rest) || /\bError\b:\s/.test(rest))) {
    level = "error";
  }

  return { ts, level, tag, text: rest.trimEnd(), raw: line };
}

// ── Small pieces ─────────────────────────────────────────────────────────────

function LevelChip({ level, count, active, onToggle }) {
  const style = LEVEL_STYLE[level];
  return (
    <button
      type="button"
      onClick={() => onToggle(level)}
      className={cn(
        "flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-semibold tracking-wide transition-colors",
        active
          ? style.chip
          : "border-white/10 bg-white/[0.03] text-zinc-500 hover:text-zinc-300"
      )}
      title={active ? `Hide ${style.label}` : `Show ${style.label}`}
    >
      {style.label}
      <span className={cn("rounded-sm px-1", active ? "bg-white/10" : "bg-white/5")}>{count}</span>
    </button>
  );
}

function Highlight({ text, query }) {
  if (!query) return text;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const parts = [];
  let from = 0;
  let idx = lower.indexOf(q);
  while (idx !== -1) {
    if (idx > from) parts.push(text.slice(from, idx));
    parts.push(
      <mark key={idx} className="rounded-sm bg-yellow-400/30 px-0.5 text-yellow-100">
        {text.slice(idx, idx + q.length)}
      </mark>
    );
    from = idx + q.length;
    idx = lower.indexOf(q, from);
  }
  if (from < text.length) parts.push(text.slice(from));
  return parts;
}

function LogRow({ entry, showTs, wrap, query }) {
  const style = LEVEL_STYLE[entry.level];
  return (
    <div className={cn("flex gap-2 px-1", wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre")}>
      {showTs && (
        <span className="w-[64px] shrink-0 select-none text-zinc-600">{entry.ts ?? ""}</span>
      )}
      <span className={cn("w-[52px] shrink-0 select-none text-[10px] font-bold leading-4", style.text)}>
        {style.label}
      </span>
      {entry.tag && (
        <span className={cn("w-[86px] shrink-0 truncate select-none text-[10px] leading-4", tagColor(entry.tag))}>
          [{entry.tag}]
        </span>
      )}
      <span className={cn("min-w-0 flex-1 text-zinc-200", !wrap && "overflow-visible")}>
        <Highlight text={entry.text} query={query} />
      </span>
    </div>
  );
}

// ── Main client ──────────────────────────────────────────────────────────────

export default function ConsoleLogClient() {
  const [logs, setLogs] = useState([]);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const [query, setQuery] = useState("");
  const [levelFilter, setLevelFilter] = useState(() => new Set());
  const [tagFilter, setTagFilter] = useState("all");
  const [showTs, setShowTs] = useState(true);
  const [wrap, setWrap] = useState(true);
  const [atBottom, setAtBottom] = useState(true);

  const logRef = useRef(null);
  const logsRef = useRef([]); // always-current buffer; paused freezes the render
  const esRef = useRef(null);

  const apply = useCallback((next) => {
    logsRef.current = next;
    setLogs(next);
  }, []);

  const pushLines = useCallback((lines) => {
    const next = [...logsRef.current, ...lines];
    apply(next.length > CONSOLE_LOG_CONFIG.maxLines ? next.slice(-CONSOLE_LOG_CONFIG.maxLines) : next);
  }, [apply]);

  const handleClear = async () => {
    try {
      await fetch("/api/translator/console-logs", { method: "DELETE" });
      // UI cleared via SSE "clear" event
    } catch (err) {
      console.error("Failed to clear console logs:", err);
    }
  };

  // Pause freezes the rendered view but never drops incoming lines — the
  // buffer (logsRef) keeps updating; resume replays it.
  const pausedRef = useRef(false);
  const togglePause = useCallback(() => {
    pausedRef.current = !pausedRef.current;
    setPaused(pausedRef.current);
    if (!pausedRef.current) setLogs(logsRef.current); // catch up on resume
  }, []);

  useEffect(() => {
    const es = new EventSource("/api/translator/console-logs/stream");
    esRef.current = es;

    es.onopen = () => setConnected(true);

    es.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === "init") {
        apply(msg.logs.slice(-CONSOLE_LOG_CONFIG.maxLines));
      } else if (msg.type === "line") {
        if (pausedRef.current) return;
        pushLines([msg.line]);
      } else if (msg.type === "lines") {
        if (pausedRef.current) return;
        pushLines(msg.lines);
      } else if (msg.type === "clear") {
        apply([]);
      }
    };

    es.onerror = () => setConnected(false);

    return () => es.close();
  }, [apply, pushLines]);

  // ── Derived data ───────────────────────────────────────────────────────────

  const parsed = useMemo(() => logs.map(parseLine), [logs]);

  const levelCounts = useMemo(() => {
    const counts = { error: 0, warn: 0, info: 0, debug: 0, log: 0 };
    for (const entry of parsed) counts[entry.level] += 1;
    return counts;
  }, [parsed]);

  const tags = useMemo(() => {
    const set = new Set();
    for (const entry of parsed) if (entry.tag) set.add(entry.tag);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [parsed]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return parsed.filter((entry) => {
      if (levelFilter.size > 0 && !levelFilter.has(entry.level)) return false;
      if (tagFilter !== "all" && entry.tag !== tagFilter) return false;
      if (q && !entry.raw.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [parsed, levelFilter, tagFilter, query]);

  // ── Auto-scroll: only when pinned to the bottom ────────────────────────────

  useEffect(() => {
    if (!atBottom && !logRef.current) return;
    if (atBottom && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [filtered, atBottom]);

  const handleScroll = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setAtBottom(true);
  }, []);

  const toggleLevel = useCallback((level) => {
    setLevelFilter((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  }, []);

  const copyAll = useCallback(() => {
    navigator.clipboard.writeText(filtered.map((entry) => entry.raw).join("\n")).catch(() => {});
  }, [filtered]);

  const downloadAll = useCallback(() => {
    const blob = new Blob([filtered.map((entry) => entry.raw).join("\n")], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `console-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.log`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [filtered]);

  const hasFilters = levelFilter.size > 0 || tagFilter !== "all" || query.trim() !== "";

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Console"
        description="Live server logs"
        icon="monitor"
        actions={
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
                connected ? "bg-success/12 text-success" : "bg-danger/12 text-danger"
              )}
            >
              <span className={cn("size-1.5 rounded-full", connected ? "bg-success" : "bg-danger")} />
              {connected ? "Live" : "Disconnected"}
            </span>
            <Button
              size="sm"
              variant="outline"
              icon={paused ? "play_arrow" : "pause"}
              onClick={togglePause}
              title={paused ? "Resume live updates" : "Pause live updates"}
            >
              {paused ? "Resume" : "Pause"}
            </Button>
            <Button size="sm" variant="outline" icon="delete" onClick={handleClear}>
              Clear
            </Button>
          </div>
        }
      />

      <Card padding="none" className="overflow-hidden">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle bg-surface-2 px-3 py-2">
          <div className="relative min-w-[180px] flex-1 sm:max-w-xs">
            <span className="material-symbols-outlined pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[16px] text-text-muted">
              search
            </span>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter logs…"
              className="h-8 w-full rounded-md border border-border bg-surface pl-8 pr-2 text-xs text-text-main placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <select
            value={tagFilter}
            onChange={(e) => setTagFilter(e.target.value)}
            className="h-8 cursor-pointer rounded-md border border-border bg-surface px-2 text-xs text-text-main focus:outline-none focus:ring-2 focus:ring-primary/30"
            title="Filter by component tag"
          >
            <option value="all">All components</option>
            {tags.map((t) => (
              <option key={t} value={t}>[{t}]</option>
            ))}
          </select>

          <div className="flex flex-wrap items-center gap-1.5">
            {LEVELS.map((level) => (
              <LevelChip
                key={level}
                level={level}
                count={levelCounts[level]}
                active={levelFilter.size === 0 || levelFilter.has(level)}
                onToggle={toggleLevel}
              />
            ))}
          </div>

          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => setShowTs((v) => !v)}
              className={cn(
                "flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-medium transition-colors",
                showTs ? "border-primary/40 bg-primary/10 text-primary" : "border-white/10 bg-white/[0.03] text-zinc-500 hover:text-zinc-300"
              )}
              title="Toggle timestamps"
            >
              <span className="material-symbols-outlined text-[14px]">schedule</span>
              Time
            </button>
            <button
              type="button"
              onClick={() => setWrap((v) => !v)}
              className={cn(
                "flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-medium transition-colors",
                wrap ? "border-primary/40 bg-primary/10 text-primary" : "border-white/10 bg-white/[0.03] text-zinc-500 hover:text-zinc-300"
              )}
              title="Toggle line wrapping"
            >
              <span className="material-symbols-outlined text-[14px]">wrap_text</span>
              Wrap
            </button>
            <button
              type="button"
              onClick={copyAll}
              className="flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 text-[10px] font-medium text-zinc-400 transition-colors hover:text-zinc-200"
              title="Copy visible logs"
            >
              <span className="material-symbols-outlined text-[14px]">content_copy</span>
              Copy
            </button>
            <button
              type="button"
              onClick={downloadAll}
              className="flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 text-[10px] font-medium text-zinc-400 transition-colors hover:text-zinc-200"
              title="Download visible logs as .log"
            >
              <span className="material-symbols-outlined text-[14px]">download</span>
              Save
            </button>
          </div>
        </div>

        {/* Log viewport */}
        <div className="relative">
          <div
            ref={logRef}
            onScroll={handleScroll}
            className="h-[calc(100vh-320px)] min-h-[320px] overflow-y-auto bg-black px-3 py-2.5 font-mono text-xs leading-5"
          >
            {filtered.length === 0 ? (
              <div className="flex h-full items-center justify-center text-zinc-600">
                {logs.length === 0
                  ? "No console logs yet."
                  : "No lines match the current filters."}
              </div>
            ) : (
              <div className="space-y-px">
                {filtered.map((entry, i) => (
                  <LogRow
                    key={`${i}-${entry.raw.slice(0, 24)}`}
                    entry={entry}
                    showTs={showTs}
                    wrap={wrap}
                    query={query.trim()}
                  />
                ))}
              </div>
            )}

            {/* Jump to latest */}
            {!atBottom && (
              <button
                type="button"
                onClick={scrollToBottom}
                className="absolute bottom-3 right-6 flex items-center gap-1.5 rounded-full border border-white/15 bg-zinc-900/95 px-3 py-1.5 text-[11px] font-medium text-zinc-200 shadow-lg transition-colors hover:bg-zinc-800"
              >
                <span className="material-symbols-outlined text-[14px]">arrow_downward</span>
                Jump to latest
              </button>
            )}
          </div>

          {/* Status bar */}
          <div className="flex items-center justify-between border-t border-border-subtle bg-surface-2 px-3 py-1 text-[10px] text-text-muted">
            <span>
              Showing {filtered.length} of {logs.length} lines
              {hasFilters && " (filtered)"}
              {paused && " · paused"}
            </span>
            <span className="flex items-center gap-1">
              <span className={cn("size-1.5 rounded-full", connected ? "bg-success" : "bg-danger")} />
              {connected ? "SSE connected" : "reconnecting…"}
            </span>
          </div>
        </div>
      </Card>
    </div>
  );
}
