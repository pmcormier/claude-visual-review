// The model the page renders: every live session (with its subagents and verdict), grouped by project, with
// each project's work tree, plus usage and headline counts. Read-only; never throws (a failing project carries
// an `error` note and the others still render).
//
// buildModel(now, {sampler, config, historyDays, commitDays, sources}) -> Model (async: BMAD and git are async)
//   sources: test seam, overrides any of {readWorklog, readPlans, readBmad, readInbox, readCommits}.
//   sampler: {alive(pid, procStart), descendants(pid) -> [{pid, cpuPct, created}]} from procs.mjs
//            startCpuSampler (default: kill(0) liveness, CPU unknown).
//   config: loadConfig() result, read once per rebuild by the caller.
//
// Judgment calls (see the task report for the reasoning):
//  - Projects (R17) = live sessions' roots ∪ roots of transcripts modified in the last `historyDays` (7);
//    that scan is cached 60 s per Claude home. Roots that no longer exist are skipped.
//  - A session whose process is not alive is kept only while it still had a tool pending ("Gone"), and only
//    for GONE_KEEP_MS after its last transcript write; otherwise it closed normally and is dropped.
//  - A session record without a pid counts as not alive (Claude Code names the file after the pid).
//  - CPU for the stall rules (R22) = the processes the pending tool started (see toolCpu); none pending, none of
//    them visible, or a creation time unknown: null (the verdict then falls back to transcript quiet).
//  - Subagents: status null, alive = the parent's, CPU = their own pending tool's processes inside the parent's
//    tree (subagents run in its process).
//    A finished subagent of a gone parent shows idle. Any "stuck" subagent verdict needs the parent to be
//    waiting on it actively (its pending tool is an Agent/Task call); otherwise the subagent shows idle.
//  - Finished/idle subagents collapse to the last KEEP_DONE_SUBAGENTS plus a count (subagentsHidden).
//  - Commits are read over the whole history (git.mjs caps the count), so a plan task a commit marked done
//    stays done however old the commit (R25). events.jsonl lines older than `commitDays` (30) are ignored, so
//    commit matching clause b (session-linked commits) only sees plan touches inside that window.
//  - A work-log task left `doing` by a session that is no longer live reads `next` (buildTree liveSessionIds).
//  - Project state: stuck > waiting > working (sessions and their subagents) > gone > idle (a live session,
//    none working) > quiet (no live session). Order: stuck, waiting, working, then the rest, each group by
//    last activity, newest first. open = a live session, a task in progress, or a stall (stuck/gone).
//    quietSince = last activity when nothing in the project is working, else null.
//  - Counts: stuck = sessions and subagents that look stuck (so the headline agrees with project state);
//    waiting/working count sessions; next counts unfinished tasks with status 'next' across projects, leaving out
//    plans from before the dashboard and dropped plans.
import { readdirSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { join, basename, resolve, sep } from 'node:path';
import { claudeHome, dashHome, plannotatorHome } from './paths.mjs';
import { loadConfig, readInstalledAt } from './config.mjs';
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
import { readSpendCached, spendFor, sessionSpend } from './spend.mjs';

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

// ---- plan and Inbox reads, reused while their files are unchanged -----------------------------------------
// Re-parsing every plan and Inbox file on each rebuild was ~85 of 91 ms of a warm build (measured 2026-11-19).
// A signature of the files each reader opens (name, mtime, size) decides reuse; buildTree copies its inputs, so
// the cached arrays are never mutated.

function statSig(path) {
  try { const st = statSync(path); return `${st.mtimeMs}:${st.size}`; } catch { return '-'; }
}

function plansSig(root) {
  const dir = join(root, 'docs', 'superpowers', 'plans');
  let names;
  try { names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.md')).sort(); } catch { return '-'; }
  return names.map((n) => `${n}=${statSig(join(dir, n))}`).join('|');
}

// One signature for the whole Inbox: every project folder's project.json, steps.jsonl and messages.jsonl.
function inboxSig() {
  const base = join(plannotatorHome(), 'inbox', 'projects');
  let keys;
  try { keys = readdirSync(base).sort(); } catch { return '-'; }
  return keys.map((k) => ['project.json', 'steps.jsonl', 'messages.jsonl']
    .map((f) => statSig(join(base, k, f))).join(',') + `@${k}`).join('|');
}

const sourceCache = new Map(); // kind + NUL + root key -> {sig, value}
function cached(kind, root, sig, read) {
  const k = `${kind}\u0000${keyOf(root)}`;
  const hit = sourceCache.get(k);
  if (hit && hit.sig === sig && sig !== '-') return hit.value;
  const value = read(root);
  sourceCache.set(k, { sig, value });
  return value;
}

// ---- sessions ------------------------------------------------------------------------------------------------

// CPU for the stall rules (R22): the summed CPU of the processes in the session's tree that the pending tool
// started, i.e. those created at or after its start (less TOOL_START_SLACK_MS for clock and rounding skew).
// Claude Code itself and its MCP servers predate the tool and never count: their idle CPU alone kept an idle
// tree above the "low" line (measured 2026-11-19: 5-102 % for idle sessions). No tool pending: null (CPU is
// not consulted). The sampler's root entry carrying no CPU (no second sample, or stale) also reads null, as
// does any counted process without a figure. A tool that started no process reads 0.
const TOOL_START_SLACK_MS = 2000;
const FILETIME_EPOCH_MS = 11644473600000n; // 1601-01-01 to 1970-01-01
const filetimeOf = (ms) => (BigInt(Math.floor(ms)) + FILETIME_EPOCH_MS) * 10000n;

export function toolCpu(sampler, pid, startedMs) {
  if (!Number.isInteger(pid) || !Number.isFinite(startedMs)) return null;
  let list;
  try { list = sampler.descendants(pid); } catch { return null; }
  if (!Array.isArray(list) || !list.length) return null;
  const root = list.find((d) => d?.pid === pid);
  if (!Number.isFinite(root?.cpuPct)) return null;
  const cutoff = filetimeOf(startedMs - TOOL_START_SLACK_MS);
  let sum = 0;
  let found = false;
  for (const d of list) {
    if (typeof d?.created !== 'bigint') return null; // creation time unknown: cannot tell the tool's processes apart
    if (d.created < cutoff) continue;
    if (!Number.isFinite(d.cpuPct)) return null;
    sum += d.cpuPct;
    found = true;
  }
  return found ? sum : null; // nothing the tool started is visible (an MCP server predates the call): unknown, not 0
}

function aliveOf(sampler, s) {
  if (!Number.isInteger(s.pid)) return false;
  try { return !!sampler.alive(s.pid, s.procStart); } catch { return killAlive(s.pid); }
}

// Dormant subagents, reused across rebuilds (see subagents.mjs). Entries unused for 10 min are pruned.
const subagentCache = new Map();
function pruneSubagentCache(now) {
  for (const [k, v] of subagentCache) if (now - v.checkedAt > 10 * 60000 || v.checkedAt > now) subagentCache.delete(k);
}

const toolView = (t) => (t ? { name: t.name, command: clip(t.command), startedMs: t.startedMs ?? null, background: !!t.outputFile } : null);
const idleOf = (t, now) => (t?.outputFile ? outputGrowth(t.outputFile, now).idleMs : null);
const RANK = { stuck: 0, waiting: 1, working: 2 };
const rankOf = (state) => RANK[state] ?? 3;

function subagentView(a, parent, now, th, sampler) {
  const own = a.signals.pendingTool;
  const cpuPct = parent.alive && own ? toolCpu(sampler, parent.pid, own.startedMs) : null;
  let v = classify({
    kind: 'subagent', status: null, alive: parent.alive, signals: a.signals, cpuPct,
    outputIdleMs: idleOf(a.signals.pendingTool, now), finished: a.finished, now,
  }, th);
  if (v.state === 'gone' && a.finished === true) v = { state: 'idle', evidence: null, hint: null, since: a.lastWriteMs };
  // A subagent is only "stuck" while its parent waits on it actively (stall.mjs leaves that clause here). It
  // gates every stuck rule, not just "never reports": a subagent left with a tool pending after its parent moved
  // on (measured 2026-11-19: one 4 days old) is history, not a stall.
  if (v.state === 'stuck' && !parent.waitsOnAgent) {
    v = { state: 'idle', evidence: null, hint: v.hint, since: a.lastWriteMs };
  }
  // Quiet since before the parent's current Agent call started, it is not the one being waited on, and its CPU
  // (every process the parent started after its tool did) is not its own (seen live 2026-11-19: a subagent with a
  // Bash call pending 4 days read Working while its parent waited on a newer subagent). It is history.
  const quiet = Number.isFinite(a.lastWriteMs) && now - a.lastWriteMs >= th.subagentQuiet * 60000;
  const beforeCall = !parent.waitsOnAgent || !Number.isFinite(parent.agentSinceMs) || a.lastWriteMs < parent.agentSinceMs;
  if (quiet && beforeCall && a.finished !== true && (v.state === 'working' || v.state === 'stuck')) {
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
  const cpuPct = alive && tool ? toolCpu(sampler, s.pid, tool.startedMs) : null;
  const v = classify({
    kind: 'session', status: s.status, alive, signals, cpuPct, outputIdleMs: idleOf(tool, now), finished: null, now,
    statusUpdatedAt: s.statusUpdatedAt,
  }, th);
  const waitsOnAgent = !!tool && (tool.name === 'Agent' || tool.name === 'Task');
  const parent = { alive, pid: s.pid, waitsOnAgent, agentSinceMs: waitsOnAgent ? tool.startedMs ?? null : null };
  let subs = [];
  try { subs = s.transcriptPath ? readSubagents(s.transcriptPath, now, th, { cache: subagentCache }) : []; } catch { subs = []; }
  const views = subs.map((a) => subagentView(a, parent, now, th, sampler)); // newest first (readSubagents order)
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

// Plan steps never appear on the page, so each task's `ticked` counts are dropped (they were ~10% of a large
// project's tree).
function trimTree(tree) {
  for (const e of tree.epics) for (const t of e.tasks) delete t.ticked;
  return tree;
}

function findTask(tree, id) {
  for (const e of tree?.epics ?? []) {
    const t = e.tasks.find((x) => x.id === id);
    if (t) return { id: t.id, title: t.title, epic: e.title, status: t.status };
  }
  return null;
}

const SOURCES = { readWorklog, readPlans, readBmad, readInbox, readCommits };

async function buildProject(root, sessions, lastSeenMs, events, now, th, liveSessionIds, inboxSigNow, src) {
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
    const [bmad, commits] = await Promise.all([src.readBmad(root), src.readCommits(root)]);
    tree = trimTree(buildTree(root, {
      worklog: src.readWorklog(root), plans: cached('plans', root, plansSig(root), src.readPlans), bmad,
      inbox: cached('inbox', root, inboxSigNow, src.readInbox), commits,
      sessions: sessions.filter((s) => s.alive).map((s) => ({ sessionId: s.sessionId, signals: s._signals })),
      events: events.filter((e) => inside(rootKey, e.file)), liveSessionIds, now, installedAtMs: readInstalledAt(),
    }, th));
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
  const model = {
    generatedAt: now, usage, counts: { stuck: 0, waiting: 0, working: 0, next: 0 }, live: 0, projects: [], error: null,
    thresholds: { waitingEscalate: 15 }, // the one config value the page needs: Triage's waiting escalation (min)
  };
  try {
    const th = (opts.config ?? loadConfig()).thresholds;
    if (Number.isFinite(th?.waitingEscalate) && th.waitingEscalate >= 0) model.thresholds.waitingEscalate = th.waitingEscalate;
    const sampler = opts.sampler ?? DEFAULT_SAMPLER;
    const historyDays = Number.isFinite(opts.historyDays) ? opts.historyDays : HISTORY_DAYS;
    const sinceMs = now - (Number.isFinite(opts.commitDays) ? opts.commitDays : COMMIT_DAYS) * DAY;

    pruneSubagentCache(now);
    const byRoot = new Map(); // key -> {root, lastMs, sessions}
    const liveSessionIds = new Set();
    for (const [k, d] of discoverRoots(now, historyDays)) byRoot.set(k, { root: d.root, lastMs: d.lastMs, sessions: [] });
    for (const s of readSessions()) {
      let v;
      try { v = sessionView(s, now, th, sampler); } catch { v = null; }
      if (!v) continue;
      if (v.alive) { model.live += 1; if (v.sessionId) liveSessionIds.add(v.sessionId); }
      if (!s.cwd) continue;
      const root = projectRoot(s.cwd);
      const k = keyOf(root);
      if (!byRoot.has(k)) byRoot.set(k, { root, lastMs: null, sessions: [] });
      byRoot.get(k).sessions.push(v);
    }

    const events = readEvents(sinceMs);
    const inboxSigNow = inboxSig();
    const src = { ...SOURCES, ...(isObj(opts.sources) ? opts.sources : {}) };
    const projects = await Promise.all([...byRoot.values()].map(async (p) => {
      p.sessions.sort((a, b) => rankOf(a.state) - rankOf(b.state) || (b.lastWriteMs ?? 0) - (a.lastWriteMs ?? 0));
      try {
        return await buildProject(p.root, p.sessions, p.lastMs, events, now, th, liveSessionIds, inboxSigNow, src);
      } catch (e) {
        return {
          root: p.root, name: basename(p.root), state: projectState(p.sessions), sessions: p.sessions, tree: null,
          error: `Could not read this project: ${errText(e)}`, open: true, quietSince: null, lastActivityMs: p.lastMs,
        };
      }
    }));

    // Session spend (decision 34): the status line's records, kept after a session ends.
    const spend = (() => { try { return readSpendCached(join(dashHome(), 'spend')); } catch { return new Map(); } })();
    for (const p of projects) {
      p.spend = spendFor(spend, p.root, now);
      for (const s of p.sessions) {
        s.spend = sessionSpend(spend.get(s.sessionId), s.tokens);
        delete s._signals;
        if (s.state in RANK) model.counts[s.state] += 1;
        model.counts.stuck += s.subagents.filter((a) => a.state === 'stuck').length;
      }
      for (const e of p.tree?.epics ?? []) if (!e.before && !e.dropped) model.counts.next += e.tasks.filter((t) => t.status === 'next').length;
    }
    model.projects = orderProjects(projects);
  } catch (e) {
    model.error = `Could not build the dashboard: ${errText(e)}`;
  }
  return model;
}
