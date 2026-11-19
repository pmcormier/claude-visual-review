// The model the page renders: every live session (with its subagents and verdict), grouped by project, with
// each project's work tree, plus usage and headline counts. Read-only; never throws (a failing project carries
// an `error` note and the others still render).
//
// buildModel(now, {sampler, config, historyDays, commitDays}) -> Model (async: BMAD and git are async)
//   sampler: {alive(pid, procStart), descendants(pid)} from procs.mjs startCpuSampler (default: kill(0)
//            liveness, CPU unknown). config: loadConfig() result, read once per rebuild by the caller.
//
// Judgment calls (see the task report for the reasoning):
//  - Projects (R17) = live sessions' roots ∪ roots of transcripts modified in the last `historyDays` (7);
//    that scan is cached 60 s per Claude home. Roots that no longer exist are skipped.
//  - A session whose process is not alive is kept only while it still had a tool pending ("Gone"), and only
//    for GONE_KEEP_MS after its last transcript write; otherwise it closed normally and is dropped.
//  - A session record without a pid counts as not alive (Claude Code names the file after the pid).
//  - Subagents: status null, alive = the parent's, CPU = the parent's tree (subagents run in its process).
//    A finished subagent of a gone parent shows idle. The "never reports" stall needs the parent to be
//    waiting on it actively (its pending tool is an Agent/Task call); otherwise the quiet subagent shows idle.
//  - Finished/idle subagents collapse to the last KEEP_DONE_SUBAGENTS plus a count (subagentsHidden).
//  - Commits are read for the last `commitDays` (30) days, and events.jsonl lines older than that are ignored:
//    commit matching clauses b/c (plan birth from a real add, session-linked commits) only see adds and
//    activity inside that window.
//  - Project state: stuck > waiting > working (sessions and their subagents) > gone > idle (a live session,
//    none working) > quiet (no live session). Order: stuck, waiting, working, then the rest, each group by
//    last activity, newest first. open = a live session, a task in progress, or a stall (stuck/gone).
//    quietSince = last activity when nothing in the project is working, else null.
//  - Counts: stuck/waiting/working count sessions (not subagents); next counts unfinished tasks with status
//    'next' across projects.
import { readdirSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { join, basename, resolve, sep } from 'node:path';
import { claudeHome, dashHome } from './paths.mjs';
import { loadConfig } from './config.mjs';
import { readJsonl } from './jsonl.mjs';
import { readSessions, projectRoot } from './sessions.mjs';
import { scanTranscript } from './transcripts.mjs';
import { readSubagents } from './subagents.mjs';
import { outputGrowth } from './procs.mjs';
import { classify } from './stall.mjs';
import { readWorklog } from './worklog.mjs';
import { readPlans } from './sources/plans.mjs';
import { readBmad } from './sources/bmad.mjs';
import { readInbox } from './sources/inbox.mjs';
import { readCommits } from './git.mjs';
import { buildTree } from './tree.mjs';
import { readUsage } from './usage.mjs';

const DAY = 86400000;
export const HISTORY_DAYS = 7;
export const COMMIT_DAYS = 30;
const DISCOVER_TTL_MS = 60000;
const GONE_KEEP_MS = DAY;
const KEEP_DONE_SUBAGENTS = 5;
const KEEP_EVENTS = 20000;
const HEAD_BYTES = 256 * 1024;
const CMD_MAX = 200;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const keyOf = (p) => { const r = resolve(String(p)); return process.platform === 'win32' ? r.toLowerCase() : r; };
const clip = (s) => (typeof s === 'string' && s.length > CMD_MAX ? s.slice(0, CMD_MAX - 1) + '…' : s ?? null);
const errText = (e) => String(e?.message || e).replace(/\s+/g, ' ').slice(0, 200);

function killAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}
const DEFAULT_SAMPLER = { alive: (pid) => killAlive(pid), descendants: () => [] };

// ---- project discovery (R17) -------------------------------------------------------------------------------

// cwd from the first entries of a transcript that carry one.
function headCwd(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    const lines = buf.subarray(0, n).toString('utf8').split('\n');
    if (n === HEAD_BYTES) lines.pop(); // the last line may be cut
    for (const l of lines) {
      try { const e = JSON.parse(l); if (isObj(e) && typeof e.cwd === 'string' && e.cwd) return e.cwd; } catch { /* skip */ }
    }
  } catch { /* unreadable */ } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ } }
  return null;
}

const discoverCache = new Map(); // claudeHome -> {at, days, roots: Map key -> {root, lastMs}}

/** Roots of projects with a transcript modified in the last `historyDays`. Cached 60 s per Claude home. */
export function discoverRoots(now = Date.now(), historyDays = HISTORY_DAYS) {
  const home = claudeHome();
  const hit = discoverCache.get(home);
  if (hit && hit.days === historyDays && now >= hit.at && now - hit.at < DISCOVER_TTL_MS) return hit.roots;
  const roots = new Map();
  const base = join(home, 'projects');
  let folders = [];
  try { folders = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* none */ }
  const from = now - historyDays * DAY;
  for (const f of folders) {
    try {
      let best = null;
      for (const n of readdirSync(join(base, f))) {
        if (!n.endsWith('.jsonl')) continue;
        let ms;
        try { ms = statSync(join(base, f, n)).mtimeMs; } catch { continue; }
        if (ms >= from && (!best || ms > best.ms)) best = { n, ms };
      }
      if (!best) continue;
      const cwd = headCwd(join(base, f, best.n));
      if (!cwd) continue;
      const root = projectRoot(cwd);
      if (!root || !existsSync(root)) continue;
      const k = keyOf(root);
      const prev = roots.get(k);
      if (!prev || best.ms > prev.lastMs) roots.set(k, { root, lastMs: best.ms });
    } catch { /* skip this folder */ }
  }
  discoverCache.set(home, { at: now, days: historyDays, roots });
  return roots;
}

// ---- events.jsonl (plan-touch events), read incrementally ----------------------------------------------------

const eventsCache = new Map(); // path -> {endByte, records}
function readEvents(sinceMs) {
  const path = join(dashHome(), 'events.jsonl');
  let c = eventsCache.get(path);
  let size = null;
  try { size = statSync(path).size; } catch { /* missing */ }
  if (size === null) { eventsCache.delete(path); return []; }
  if (!c || size < c.endByte) { c = { endByte: 0, records: [] }; eventsCache.set(path, c); }
  const { records, endByte } = readJsonl(path, { fromByte: c.endByte });
  c.endByte = endByte;
  for (const r of records) {
    if (isObj(r) && typeof r.session === 'string' && typeof r.file === 'string') c.records.push(r);
  }
  if (c.records.length > KEEP_EVENTS) c.records.splice(0, c.records.length - KEEP_EVENTS);
  return c.records.filter((r) => { const t = Date.parse(r.at); return Number.isFinite(t) && t >= sinceMs; });
}

function inside(rootKey, file) {
  try { const k = keyOf(file); return k.startsWith(rootKey.endsWith(sep) ? rootKey : rootKey + sep); } catch { return false; }
}

// ---- sessions ------------------------------------------------------------------------------------------------

function cpuOf(sampler, pid) {
  let list;
  try { list = sampler.descendants(pid); } catch { return null; }
  if (!Array.isArray(list) || !list.length) return null;
  let sum = 0;
  for (const d of list) {
    if (!Number.isFinite(d?.cpuPct)) return null; // unknown (fewer than two samples, or stale)
    sum += d.cpuPct;
  }
  return sum;
}

function aliveOf(sampler, s) {
  if (!Number.isInteger(s.pid)) return false;
  try { return !!sampler.alive(s.pid, s.procStart); } catch { return killAlive(s.pid); }
}

const toolView = (t) => (t ? { name: t.name, command: clip(t.command), startedMs: t.startedMs ?? null, background: !!t.outputFile } : null);
const idleOf = (t, now) => (t?.outputFile ? outputGrowth(t.outputFile, now).idleMs : null);
const RANK = { stuck: 0, waiting: 1, working: 2 };
const rankOf = (state) => RANK[state] ?? 3;

function subagentView(a, parent, now, th) {
  let v = classify({
    kind: 'subagent', status: null, alive: parent.alive, signals: a.signals, cpuPct: parent.cpuPct,
    outputIdleMs: idleOf(a.signals.pendingTool, now), finished: a.finished, now,
  }, th);
  if (v.state === 'gone' && a.finished === true) v = { state: 'idle', evidence: null, hint: null, since: a.lastWriteMs };
  // "Never reports" needs the parent to be waiting on it actively; stall.mjs leaves that clause to this layer.
  if (v.state === 'stuck' && !parent.waitsOnAgent && !a.signals.pendingTool && !/^Last reply was an API error/.test(v.evidence ?? '')) {
    v = { state: 'idle', evidence: null, hint: v.hint, since: a.lastWriteMs };
  }
  return {
    agentId: a.agentId, description: a.description, model: a.model, effort: a.effort, finished: a.finished,
    lastWriteMs: a.lastWriteMs, life: a.minutes, tokens: a.signals.tokens, pendingTool: toolView(a.signals.pendingTool),
    state: v.state, evidence: v.evidence, hint: v.hint, since: v.since,
  };
}

function sessionView(s, now, th, sampler) {
  const signals = scanTranscript(s.transcriptPath ?? '', now, th);
  const alive = aliveOf(sampler, s);
  const tool = signals.pendingTool;
  if (!alive && (!tool || (signals.lastWriteMs ?? 0) < now - GONE_KEEP_MS)) return null; // closed normally
  const cpuPct = alive ? cpuOf(sampler, s.pid) : null;
  const v = classify({
    kind: 'session', status: s.status, alive, signals, cpuPct, outputIdleMs: idleOf(tool, now), finished: null, now,
    statusUpdatedAt: s.statusUpdatedAt,
  }, th);
  const parent = { alive, cpuPct, waitsOnAgent: !!tool && (tool.name === 'Agent' || tool.name === 'Task') };
  let subs = [];
  try { subs = s.transcriptPath ? readSubagents(s.transcriptPath, now, th) : []; } catch { subs = []; }
  const views = subs.map((a) => subagentView(a, parent, now, th)); // newest first (readSubagents order)
  const active = views.filter((a) => a.finished !== true && a.state !== 'idle');
  const rest = views.filter((a) => !active.includes(a));
  return {
    sessionId: s.sessionId, pid: s.pid, name: s.name, cwd: s.cwd, status: s.status, alive,
    state: v.state, evidence: v.evidence, hint: v.hint, since: v.since,
    cpuPct, lastWriteMs: signals.lastWriteMs, life: signals.minutes, tokens: signals.tokens,
    pendingTool: toolView(tool), linkedTask: null,
    subagents: [...active, ...rest.slice(0, KEEP_DONE_SUBAGENTS)],
    subagentsHidden: Math.max(0, rest.length - KEEP_DONE_SUBAGENTS),
    _signals: signals,
  };
}

// ---- projects ------------------------------------------------------------------------------------------------

function projectState(sessions) {
  const states = sessions.flatMap((s) => [s.state, ...s.subagents.map((a) => a.state)]);
  for (const st of ['stuck', 'waiting', 'working', 'gone']) if (states.includes(st)) return st;
  return sessions.some((s) => s.alive) ? 'idle' : 'quiet';
}

/** Stuck, waiting, working, then the rest; each group newest activity first. Returns a new array. */
export function orderProjects(projects) {
  return [...projects].sort((a, b) => rankOf(a.state) - rankOf(b.state)
    || (b.lastActivityMs ?? -Infinity) - (a.lastActivityMs ?? -Infinity)
    || String(a.name).localeCompare(String(b.name)));
}

function findTask(tree, id) {
  for (const e of tree?.epics ?? []) {
    const t = e.tasks.find((x) => x.id === id);
    if (t) return { id: t.id, title: t.title, epic: e.title, status: t.status };
  }
  return null;
}

async function buildProject(root, sessions, lastSeenMs, events, now, th, sinceMs) {
  const rootKey = keyOf(root);
  const lastActivityMs = Math.max(lastSeenMs ?? -Infinity, ...sessions.map((s) => s.lastWriteMs ?? -Infinity));
  const state = projectState(sessions);
  const base = {
    root, name: basename(root) || root, state, sessions,
    lastActivityMs: Number.isFinite(lastActivityMs) ? lastActivityMs : null,
  };
  let tree = null;
  let error = null;
  try {
    const [bmad, commits] = await Promise.all([readBmad(root), readCommits(root, sinceMs)]);
    tree = buildTree(root, {
      worklog: readWorklog(root), plans: readPlans(root), bmad, inbox: readInbox(root), commits,
      sessions: sessions.filter((s) => s.alive).map((s) => ({ sessionId: s.sessionId, signals: s._signals })),
      events: events.filter((e) => inside(rootKey, e.file)), now,
    }, th);
    for (const s of sessions) {
      const id = tree.links?.[s.sessionId];
      s.linkedTask = id ? findTask(tree, id) : null;
    }
  } catch (e) {
    error = `Could not read this project: ${errText(e)}`;
  }
  const doing = !!tree?.epics.some((e) => e.tasks.some((t) => t.status === 'doing'));
  return {
    ...base, tree, error,
    open: sessions.some((s) => s.alive) || doing || state === 'stuck' || state === 'gone',
    quietSince: state === 'working' ? null : base.lastActivityMs,
  };
}

/**
 * @param {number} now
 * @param {{sampler?: object, config?: {thresholds: object}, historyDays?: number, commitDays?: number}} [opts]
 */
export async function buildModel(now = Date.now(), opts = {}) {
  const usage = (() => { try { return readUsage(now); } catch { return { fiveHour: null, week: null, stale: true }; } })();
  const model = { generatedAt: now, usage, counts: { stuck: 0, waiting: 0, working: 0, next: 0 }, live: 0, projects: [], error: null };
  try {
    const th = (opts.config ?? loadConfig()).thresholds;
    const sampler = opts.sampler ?? DEFAULT_SAMPLER;
    const historyDays = Number.isFinite(opts.historyDays) ? opts.historyDays : HISTORY_DAYS;
    const sinceMs = now - (Number.isFinite(opts.commitDays) ? opts.commitDays : COMMIT_DAYS) * DAY;

    const byRoot = new Map(); // key -> {root, lastMs, sessions}
    for (const [k, d] of discoverRoots(now, historyDays)) byRoot.set(k, { root: d.root, lastMs: d.lastMs, sessions: [] });
    for (const s of readSessions()) {
      let v;
      try { v = sessionView(s, now, th, sampler); } catch { v = null; }
      if (!v) continue;
      if (v.alive) model.live += 1;
      if (!s.cwd) continue;
      const root = projectRoot(s.cwd);
      const k = keyOf(root);
      if (!byRoot.has(k)) byRoot.set(k, { root, lastMs: null, sessions: [] });
      byRoot.get(k).sessions.push(v);
    }

    const events = readEvents(sinceMs);
    const projects = await Promise.all([...byRoot.values()].map(async (p) => {
      p.sessions.sort((a, b) => rankOf(a.state) - rankOf(b.state) || (b.lastWriteMs ?? 0) - (a.lastWriteMs ?? 0));
      try {
        return await buildProject(p.root, p.sessions, p.lastMs, events, now, th, sinceMs);
      } catch (e) {
        return {
          root: p.root, name: basename(p.root), state: projectState(p.sessions), sessions: p.sessions, tree: null,
          error: `Could not read this project: ${errText(e)}`, open: true, quietSince: null, lastActivityMs: p.lastMs,
        };
      }
    }));

    for (const p of projects) {
      for (const s of p.sessions) {
        delete s._signals;
        if (s.state in RANK) model.counts[s.state] += 1;
      }
      for (const e of p.tree?.epics ?? []) model.counts.next += e.tasks.filter((t) => t.status === 'next').length;
    }
    model.projects = orderProjects(projects);
  } catch (e) {
    model.error = `Could not build the dashboard: ${errText(e)}`;
  }
  return model;
}
