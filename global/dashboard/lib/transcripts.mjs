// Signals from one session transcript (JSONL). Incremental: per path we remember how far we read and the
// running aggregates, so a scan only parses new bytes. Never throws; a missing file yields empty signals.
import { statSync } from 'node:fs';
import { readJsonl } from './jsonl.mjs';
import { loadConfig } from './config.mjs';

const MIN = 60000;
const KEEP_REFS = 200;
const KEEP_EVENTS = 500;
const BG_RE = /Command running in background with ID: .*?Output is being written to: (.+?\.output)/s;
const TASK_RE = /\bTask (\d+)\b/g;
const PLAN_RE = /(?:^|[\\/])docs[\\/]superpowers[\\/]plans[\\/][^\\/]+\.md$/;
const BMAD_RE = /(?:^|[\\/])_bmad-output[\\/].*\.md$/;

const states = new Map();

function fresh() {
  return {
    endByte: 0, minuteSet: new Set(), pending: new Map(), lastEntryIsApiError: false, lastEntryMs: null,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }, seenIds: new Set(),
    events: [], planRefs: [], taskRefs: [],
  };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (Number.isFinite(v) ? v : 0);

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (isObj(c) && typeof c.text === 'string' ? c.text : '')).join('\n');
}

function ingest(st, e) {
  const ms = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
  const hasMs = Number.isFinite(ms);
  if (hasMs) {
    st.minuteSet.add(Math.floor(ms / MIN) * MIN);
    st.lastEntryMs = ms;
  }
  st.lastEntryIsApiError = e.isApiErrorMessage === true;
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
      const m = BG_RE.exec(resultText(b.content));
      if (m) p.outputFile = m[1]; // job still running: stays pending
      else st.pending.delete(b.tool_use_id);
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
  if (typeof b.id === 'string') st.pending.set(b.id, { name, command, startedMs: hasMs ? ms : null, outputFile: null });
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

export function scanTranscript(path, now = Date.now()) {
  let size = null;
  let lastWriteMs = null;
  try { const s = statSync(path); size = s.size; lastWriteMs = s.mtimeMs; } catch { /* missing */ }
  let st = states.get(path);
  if (size === null) { states.delete(path); st = null; }
  else if (!st || st.endByte > size) { st = fresh(); states.set(path, st); }

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
    repeat: repeatOf(view, now, loadConfig().thresholds.loopWindow),
    planRefs: view.planRefs.map((r) => ({ ...r })),
    taskRefs: view.taskRefs.map((r) => ({ ...r })),
  };
}
