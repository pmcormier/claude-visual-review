// Signals from one session transcript (JSONL). Incremental: per path we remember how far we read and the
// running aggregates, so a scan only parses new bytes. Never throws; a missing file yields empty signals.
import { statSync } from 'node:fs';
import { readJsonl } from './jsonl.mjs';
import { loadConfig } from './config.mjs';

const MIN = 60000;
const KEEP_REFS = 200;
const KEEP_EVENTS = 500;
// Claude Code's reply to a run_in_background call starts with this line. It is matched only at the start of the
// result of such a call: a command whose output quotes it (a transcript excerpt) has finished, not left a job running.
const BG_RE = /^\s*Command running in background with ID: (\S+?)\.?\s+Output is being written to: (.+?\.output)/;
// Tools that end a background job by its ID. A stopped job gets no completion note, so a successful stop ends it.
const STOP_TOOLS = new Set(['TaskStop', 'KillShell', 'KillBash']);
const TASK_RE = /\bTask (\d+)\b/g;
// Same patterns as plan-hook.mjs: case-insensitive (Windows paths), either separator.
const PLAN_RE = /(?:^|[\\/])docs[\\/]superpowers[\\/]plans[\\/][^\\/]+\.md$/i;
const BMAD_RE = /(?:^|[\\/])_bmad-output[\\/](?:[^\\/]+[\\/])*[^\\/]+\.md$/i;

// path -> running state. A path not scanned for PRUNE_AFTER_MS (its session closed long ago) is dropped, swept
// at most once a minute.
const states = new Map();
const PRUNE_AFTER_MS = 60 * MIN;
let sweptAt = -Infinity;
function sweep(now) {
  if (now - sweptAt < MIN && now >= sweptAt) return;
  sweptAt = now;
  for (const [p, st] of states) if (!(now - st.seenAt < PRUNE_AFTER_MS)) states.delete(p);
}

/** Number of transcripts tracked (tests). */
export const trackedTranscripts = () => states.size;

function fresh() {
  return {
    endByte: 0, minuteSet: new Set(), pending: new Map(), lastEntryIsApiError: false, lastEntryMs: null,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }, seenIds: new Set(),
    events: [], planRefs: [], taskRefs: [], customTitle: null, aiTitle: null,
  };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (Number.isFinite(v) ? v : 0);

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (isObj(c) && typeof c.text === 'string' ? c.text : '')).join('\n');
}

// A finished background job (or subagent) is recorded as a <task-notification> in a
// queue-operation entry (content) and an attachment entry (attachment.prompt). Either one
// resolves the tool_use it names, as if its tool_result had arrived.
const NOTIF_RE = /<task-notification>[\s\S]*?<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>[\s\S]*?<status>[^<]*<\/status>/;
function resolveNotification(st, e) {
  let text = null;
  if (e.type === 'queue-operation' && typeof e.content === 'string') text = e.content;
  else if (e.type === 'attachment' && isObj(e.attachment) && typeof e.attachment.prompt === 'string') text = e.attachment.prompt;
  if (!text) return;
  const m = NOTIF_RE.exec(text);
  if (m) st.pending.delete(m[1]);
}

function ingest(st, e) {
  const ms = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
  const hasMs = Number.isFinite(ms);
  if (hasMs) {
    st.minuteSet.add(Math.floor(ms / MIN) * MIN);
  }
  // Only conversation entries decide "last entry"; system, queue-operation etc. are written after errors.
  if (e.type === 'user' || e.type === 'assistant') {
    if (hasMs) st.lastEntryMs = ms;
    st.lastEntryIsApiError = e.isApiErrorMessage === true;
  }
  resolveNotification(st, e);
  // Claude Code's own name for the session: a title the person set wins over its generated one; newest of each.
  if (e.type === 'custom-title' && typeof e.customTitle === 'string' && e.customTitle.trim()) st.customTitle = e.customTitle.trim();
  if (e.type === 'ai-title' && typeof e.aiTitle === 'string' && e.aiTitle.trim()) st.aiTitle = e.aiTitle.trim();
  const msg = isObj(e.message) ? e.message : null;
  const content = msg && Array.isArray(msg.content) ? msg.content : [];

  if (e.type === 'assistant') {
    const u = msg && isObj(msg.usage) ? msg.usage : null;
    if (u) {
      const id = e.requestId ?? msg.id ?? null;
      if (id === null || !st.seenIds.has(id)) {
        if (id !== null) st.seenIds.add(id);
        st.tokens.input += num(u.input_tokens);
        st.tokens.output += num(u.output_tokens);
        st.tokens.cacheRead += num(u.cache_read_input_tokens);
        st.tokens.cacheCreate += num(u.cache_creation_input_tokens);
      }
    }
    for (const b of content) {
      if (!isObj(b)) continue;
      if (b.type === 'text' && typeof b.text === 'string') scanTasks(st, b.text, ms, hasMs);
      if (b.type === 'tool_use') toolUse(st, b, ms, hasMs);
    }
  } else if (e.type === 'user') {
    for (const b of content) {
      if (!isObj(b) || b.type !== 'tool_result') continue;
      const p = st.pending.get(b.tool_use_id);
      if (!p) continue;
      const m = p.bg ? BG_RE.exec(resultText(b.content)) : null;
      if (m) { p.jobId = m[1]; p.outputFile = m[2]; } // job still running: stays pending
      else st.pending.delete(b.tool_use_id);
      if (p.stops && b.is_error !== true) {
        for (const [id, q] of st.pending) if (q.jobId === p.stops) st.pending.delete(id);
      }
    }
  }
}

function scanTasks(st, text, ms, hasMs) {
  if (!hasMs) return;
  for (const m of text.matchAll(TASK_RE)) st.taskRefs.push({ n: Number(m[1]), ms });
  if (st.taskRefs.length > KEEP_REFS) st.taskRefs.splice(0, st.taskRefs.length - KEEP_REFS);
}

function toolUse(st, b, ms, hasMs) {
  const input = isObj(b.input) ? b.input : {};
  const name = typeof b.name === 'string' ? b.name : 'unknown';
  const file = typeof input.file_path === 'string' ? input.file_path : null;
  const command = typeof input.command === 'string' ? input.command : file;
  const stops = STOP_TOOLS.has(name) ? [input.task_id, input.shell_id, input.bash_id].find((v) => typeof v === 'string') ?? null : null;
  if (typeof b.id === 'string') st.pending.set(b.id, { name, command, startedMs: hasMs ? ms : null, outputFile: null, bg: input.run_in_background === true, jobId: null, stops });
  if (hasMs) {
    if (name === 'Bash' && typeof input.command === 'string') {
      st.events.push({ key: 'B\0' + input.command, command: input.command, ms });
    } else if (name === 'Edit' && file && typeof input.old_string === 'string') {
      st.events.push({ key: 'E\0' + file + '\0' + input.old_string, command: file, ms });
    }
    if (st.events.length > KEEP_EVENTS) st.events.splice(0, st.events.length - KEEP_EVENTS);
    if ((name === 'Read' || name === 'Edit' || name === 'Write') && file && (PLAN_RE.test(file) || BMAD_RE.test(file))) {
      st.planRefs = st.planRefs.filter((r) => r.file !== file);
      st.planRefs.push({ file, ms });
      if (st.planRefs.length > KEEP_REFS) st.planRefs.shift();
    }
    scanTasks(st, JSON.stringify(input), ms, hasMs);
  }
}

function repeatOf(st, now, windowMin) {
  const counts = new Map();
  let best = null;
  for (const ev of st.events) {
    if (ev.ms < now - windowMin * MIN) continue;
    const c = (counts.get(ev.key) ?? 0) + 1;
    counts.set(ev.key, c);
    if (c >= 2 && (!best || c > best.count)) best = { command: ev.command, count: c };
  }
  return best;
}

export function scanTranscript(path, now = Date.now(), thresholds = loadConfig().thresholds) {
  let size = null;
  let lastWriteMs = null;
  try { const s = statSync(path); size = s.size; lastWriteMs = s.mtimeMs; } catch { /* missing */ }
  let st = states.get(path);
  if (size === null) { states.delete(path); st = null; }
  else if (!st || st.endByte > size) { st = fresh(); states.set(path, st); }
  if (st) st.seenAt = now;
  sweep(now);

  if (st) {
    const { records, endByte } = readJsonl(path, { fromByte: st.endByte });
    st.endByte = endByte;
    for (const r of records) if (isObj(r)) ingest(st, r);
  }
  const view = st ?? fresh();

  const minutes = new Array(60).fill(0);
  const nowMin = Math.floor(now / MIN) * MIN;
  for (const m of view.minuteSet) {
    const idx = 59 - (nowMin - m) / MIN;
    if (idx >= 0 && idx < 60) minutes[idx] = 1;
    else if (idx < 0 || nowMin - m > 120 * MIN) view.minuteSet.delete(m);
  }

  const pendings = [...view.pending.values()];
  return {
    lastWriteMs,
    minutes,
    pendingTool: pendings.length ? { ...pendings[pendings.length - 1] } : null,
    lastEntryIsApiError: view.lastEntryIsApiError,
    lastEntryMs: view.lastEntryMs,
    tokens: { ...view.tokens },
    repeat: repeatOf(view, now, thresholds.loopWindow),
    planRefs: view.planRefs.map((r) => ({ ...r })),
    taskRefs: view.taskRefs.map((r) => ({ ...r })),
    title: view.customTitle ?? view.aiTitle ?? null,
  };
}
