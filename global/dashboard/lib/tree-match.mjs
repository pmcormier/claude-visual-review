// Helpers for tree.mjs: finding a plan from a file path, per-session activity, and conservative
// commit <-> plan task matching (spec "Calls made": a commit marks a task done only when its message names
// `Task N` and the plan is unambiguous). Pure; never throws on odd input.
import { resolve, basename, relative } from 'node:path';

export const MIN = 60000;
const TASK_RE = /\bTask (\d+)\b/g;
const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}-/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const arr = (v) => (Array.isArray(v) ? v : []);
export const toMs = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

export function normPath(root, file) {
  try {
    const p = resolve(String(root || ''), String(file)).replace(/\\/g, '/');
    return process.platform === 'win32' ? p.toLowerCase() : p;
  } catch { return null; }
}

/**
 * Index of plan epics by full path and by file name (the name is used only when it is unique).
 * @returns {{plans: object[], find: (file: string) => object|null}}
 */
export function planIndex(root, plans) {
  const byPath = new Map();
  const byName = new Map();
  for (const p of plans) {
    if (typeof p.file !== 'string' || !p.file) continue;
    const k = normPath(root, p.file);
    if (k) byPath.set(k, p);
    const name = basename(p.file).toLowerCase();
    byName.set(name, byName.has(name) ? null : p);
  }
  return {
    plans,
    find(file) {
      if (typeof file !== 'string' || !file) return null;
      const k = normPath(root, file);
      if (k && byPath.has(k)) return byPath.get(k);
      return byName.get(basename(file.replace(/\\/g, '/')).toLowerCase()) ?? null;
    },
  };
}

/** Normalized events.jsonl lines: {session, file, ms}. */
export function cleanEvents(events) {
  const out = [];
  for (const e of arr(events)) {
    if (!isObj(e) || typeof e.session !== 'string' || !e.session || typeof e.file !== 'string') continue;
    const ms = toMs(e.at);
    if (ms !== null) out.push({ session: e.session, file: e.file, ms });
  }
  return out;
}

/** Live sessions with their transcript signals (flat, or under `signals`). */
export function cleanSessions(sessions) {
  const out = [];
  for (const s of arr(sessions)) {
    if (!isObj(s) || typeof s.sessionId !== 'string' || !s.sessionId) continue;
    const sig = isObj(s.signals) ? s.signals : s;
    out.push({
      id: s.sessionId,
      planRefs: arr(sig.planRefs).filter((r) => isObj(r) && typeof r.file === 'string' && Number.isFinite(r.ms)),
      taskRefs: arr(sig.taskRefs).filter((r) => isObj(r) && Number.isInteger(r.n) && Number.isFinite(r.ms)),
      minutes: arr(sig.minutes),
      lastWriteMs: Number.isFinite(sig.lastWriteMs) ? sig.lastWriteMs : null,
    });
  }
  return out;
}

/**
 * Per session: activity intervals [start, end] (events, transcript refs, active minutes, last write) and
 * plan touches {plan, ms} (events and transcript planRefs that resolve to a plan).
 */
export function activityBySession(events, live, index, now) {
  const map = new Map();
  const get = (id) => {
    if (!map.has(id)) map.set(id, { spans: [], touches: [], taskRefs: [] });
    return map.get(id);
  };
  for (const e of events) {
    const a = get(e.session);
    a.spans.push([e.ms, e.ms]);
    const plan = index.find(e.file);
    if (plan) a.touches.push({ plan, ms: e.ms });
  }
  const nowMin = Math.floor(now / MIN) * MIN;
  for (const s of live) {
    const a = get(s.id);
    for (const r of s.planRefs) {
      a.spans.push([r.ms, r.ms]);
      const plan = index.find(r.file);
      if (plan) a.touches.push({ plan, ms: r.ms });
    }
    for (const r of s.taskRefs) { a.spans.push([r.ms, r.ms]); a.taskRefs.push(r); }
    s.minutes.forEach((v, i) => {
      if (v) { const m = nowMin - (59 - i) * MIN; a.spans.push([m, m + MIN]); }
    });
    if (s.lastWriteMs !== null) a.spans.push([s.lastWriteMs, s.lastWriteMs]);
  }
  for (const a of map.values()) {
    a.spans.sort((x, y) => x[0] - y[0]);
    a.touches.sort((x, y) => x.ms - y.ms);
    a.taskRefs.sort((x, y) => x.ms - y.ms);
  }
  return map;
}

/** Total of the union of spans, bridging gaps up to idleMs and dropping longer (idle) gaps. */
export function spanMs(spans, idleMs) {
  const list = spans.filter((s) => Number.isFinite(s[0]) && Number.isFinite(s[1])).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cs = null;
  let ce = null;
  for (const [s, e] of list) {
    if (cs === null) { cs = s; ce = e; } else if (s - ce <= idleMs) { ce = Math.max(ce, e); } else { total += ce - cs; cs = s; ce = e; }
  }
  if (cs !== null) total += ce - cs;
  return total;
}

function stems(file) {
  const b = basename(String(file)).replace(/\.md$/i, '');
  return [...new Set([b, b.replace(DATE_PREFIX, '')].filter(Boolean))];
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function namesPlan(message, plan) {
  return stems(plan.file).some((s) => new RegExp(`(?<![A-Za-z0-9_-])${esc(s)}(?![A-Za-z0-9_-])`, 'i').test(message));
}

const taskN = (plan, n) => plan.tasks.find((t) => t.n === n) ?? null;
const unfinished = (plan) => plan.tasks.some((t) => t.status !== 'done');

/**
 * Which plan tasks commits mark done. Clauses, in order; the first that applies decides, and when it is
 * ambiguous nothing is marked:
 *  a. the message names plans (file stem, with or without its YYYY-MM-DD- prefix): exactly one of them has Task N;
 *  b. sessions active at the commit (inside their activity window, idle gap allowed after the last activity)
 *     had touched plans before it: exactly one of those plans has Task N;
 *  c. the repo has exactly one unfinished plan (by its own ticks) and it has Task N.
 * In b and c a plan first committed after the commit is not a candidate (its birth is the oldest commit seen
 * that lists its file; unknown birth counts as older).
 * @returns {Map<string, number>} plan task id -> commit ms (the oldest matching commit)
 */
export function matchCommits(root, plans, commits, activity, idleMs) {
  const done = new Map();
  if (!plans.length) return done;
  const rel = new Map(plans.map((p) => [p, normPath('/', relative(String(root || ''), String(p.file || '')))]));
  const birth = new Map();
  for (const c of commits) {
    for (const f of c.files) {
      const k = normPath('/', f);
      for (const p of plans) if (rel.get(p) === k && !(birth.get(p) <= c.ms)) birth.set(p, c.ms);
    }
  }
  const bornBy = (p, ms) => !birth.has(p) || birth.get(p) <= ms;
  const open = plans.filter(unfinished);

  for (const c of [...commits].sort((x, y) => x.ms - y.ms)) {
    const ns = [...new Set([...c.message.matchAll(TASK_RE)].map((m) => Number(m[1])))];
    if (!ns.length) continue;
    const named = plans.filter((p) => namesPlan(c.message, p));
    let linked = null;
    if (!named.length) {
      linked = new Set();
      for (const a of activity.values()) {
        if (!a.spans.length || c.ms < a.spans[0][0] || c.ms > a.spans[a.spans.length - 1][1] + idleMs) continue;
        for (const t of a.touches) if (t.ms <= c.ms && bornBy(t.plan, c.ms)) linked.add(t.plan);
      }
    }
    const openNow = open.filter((p) => bornBy(p, c.ms));
    for (const n of ns) {
      let pool;
      if (named.length) pool = named;
      else if (linked.size) pool = [...linked];
      else pool = openNow.length === 1 ? openNow : [];
      const hits = pool.filter((p) => taskN(p, n));
      if (hits.length !== 1) continue;
      const t = taskN(hits[0], n);
      if (!done.has(t.id)) done.set(t.id, c.ms);
    }
  }
  return done;
}

/** Commits with the fields matching needs; anything else is dropped. */
export function cleanCommits(commits) {
  const out = [];
  for (const c of arr(commits)) {
    if (!isObj(c) || typeof c.message !== 'string' || !Number.isFinite(c.ms)) continue;
    out.push({ ms: c.ms, message: c.message, files: arr(c.files).filter((f) => typeof f === 'string') });
  }
  return out;
}
