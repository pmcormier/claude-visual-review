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
 * Index of plan epics. `exact` matches the full normalized path only (case-insensitive on Windows); session
 * evidence (events, transcript planRefs) uses it, so another project's plan of the same name never matches.
 * `find` also falls back to a unique file name; only the work log's `--plan` value uses it.
 * @returns {{plans: object[], find: (file: string) => object|null, exact: (file: string) => object|null}}
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
    exact(file) {
      if (typeof file !== 'string' || !file) return null;
      const k = normPath(root, file);
      return (k && byPath.get(k)) ?? null;
    },
    find(file) {
      if (typeof file !== 'string' || !file) return null;
      const hit = this.exact(file);
      if (hit) return hit;
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
    const plan = index.exact(e.file);
    if (plan) a.touches.push({ plan, ms: e.ms });
  }
  const nowMin = Math.floor(now / MIN) * MIN;
  for (const s of live) {
    const a = get(s.id);
    for (const r of s.planRefs) {
      a.spans.push([r.ms, r.ms]);
      const plan = index.exact(r.file);
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

/** Bridged activity segments: spans joined across gaps up to idleMs, longer (idle) gaps left open. */
export function segments(spans, idleMs) {
  const out = [];
  for (const [s, e] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = out[out.length - 1];
    if (last && s - last[1] <= idleMs) last[1] = Math.max(last[1], e); else out.push([s, e]);
  }
  return out;
}

/**
 * Which plan tasks commits mark done. Only the subject line (first line) is read: `Task N` and plan names in
 * the body don't count. Clauses, in order; the first that applies decides, and when it is ambiguous nothing is
 * marked (a missed tick is better than a wrong one):
 *  a. the subject names plans (file stem, with or without its YYYY-MM-DD- prefix): exactly one of them has Task N;
 *  b. sessions active at the commit (inside one of their bridged activity segments, or up to idleGap after its
 *     end) had touched plans before it: exactly one of those plans has Task N;
 *  c. the repo has exactly one plan file in total (now): with no other plan, no other Task N can be meant.
 * In b and c a plan is ticked only when its add commit (the newest commit where git lists the file with status
 * `A`, so a deleted and re-added plan dates from the re-add) was seen and is at or before the commit. An add outside the window (or an uncommitted plan) means never.
 * (R16: reconstructing "unfinished at commit time" from history leaked through truncated windows, fix-up
 * commits after a plan finished, and partly committed ticks, so c no longer looks at multi-plan repos.)
 * @returns {Map<string, number>} plan task id -> commit ms (the oldest matching commit)
 */
export function matchCommits(root, plans, commits, activity, idleMs) {
  const done = new Map();
  if (!plans.length) return done;
  const rel = new Map(plans.map((p) => [p, normPath('/', relative(String(root || ''), String(p.file || '')))]));
  const added = new Map(); // plan -> ms of its add commit
  for (const c of commits) {
    for (const f of c.added) {
      const k = normPath('/', f);
      for (const p of plans) if (rel.get(p) === k && !(added.get(p) >= c.ms)) added.set(p, c.ms); // newest add
    }
  }
  const tickable = (p, ms) => added.has(p) && added.get(p) <= ms;
  const segs = [...activity.values()].map((a) => ({ segs: segments(a.spans, idleMs), touches: a.touches }));

  for (const c of [...commits].sort((x, y) => x.ms - y.ms)) {
    const subject = c.message.split(/\r?\n/, 1)[0];
    const ns = [...new Set([...subject.matchAll(TASK_RE)].map((m) => Number(m[1])))];
    if (!ns.length) continue;
    const named = plans.filter((p) => namesPlan(subject, p));
    let pool;
    if (named.length) {
      pool = named;
    } else {
      const linked = new Set();
      let touched = false;
      for (const a of segs) {
        if (!a.segs.some(([s, e]) => c.ms >= s && c.ms <= e + idleMs)) continue;
        for (const t of a.touches) if (t.ms <= c.ms) { touched = true; if (tickable(t.plan, c.ms)) linked.add(t.plan); }
      }
      if (touched) pool = [...linked];
      else pool = plans.length === 1 && tickable(plans[0], c.ms) ? plans : [];
    }
    for (const n of ns) {
      const hits = pool.filter((p) => taskN(p, n));
      if (hits.length !== 1) continue;
      const t = taskN(hits[0], n);
      if (!done.has(t.id)) done.set(t.id, c.ms);
    }
  }
  return done;
}

/**
 * Per plan: addedMs = its newest add commit, else the file's creation time (untracked or no history); changedMs =
 * the newer of the latest commit touching it and the file's mtime (an uncommitted edit is a change). Either may be
 * null. changedByMs = the latest commit touching it at or before `cutMs` (the install date), or null: a plan closed
 * by a catch-up commit dates from its last change before the dashboard, not from the catch-up.
 * Commits as cleanCommits returns them.
 * @returns {Map<object, {addedMs: number|null, changedMs: number|null, changedByMs: number|null}>}
 */
export function planDates(root, plans, commits, cutMs = null) {
  const out = new Map();
  const rel = new Map(arr(plans).map((p) => [p, normPath('/', relative(String(root || ''), String(p.file || '')))]));
  for (const p of arr(plans)) out.set(p, { addedMs: null, changedMs: Number.isFinite(p.mtimeMs) ? p.mtimeMs : null, changedByMs: null });
  for (const c of arr(commits)) {
    const added = new Set(c.added.map((f) => normPath('/', f)));
    const files = new Set(c.files.map((f) => normPath('/', f)));
    for (const p of arr(plans)) {
      const k = rel.get(p);
      const d = out.get(p);
      if (added.has(k) && !(d.addedMs >= c.ms)) d.addedMs = c.ms;
      if ((files.has(k) || added.has(k)) && !(d.changedMs >= c.ms)) d.changedMs = c.ms;
      if ((files.has(k) || added.has(k)) && Number.isFinite(cutMs) && c.ms <= cutMs && !(d.changedByMs >= c.ms)) d.changedByMs = c.ms;
    }
  }
  for (const p of arr(plans)) {
    const d = out.get(p);
    if (d.addedMs === null && Number.isFinite(p.birthtimeMs) && p.birthtimeMs > 0) d.addedMs = p.birthtimeMs;
  }
  return out;
}

/** Commits with the fields matching needs; anything else is dropped. */
export function cleanCommits(commits) {
  const out = [];
  for (const c of arr(commits)) {
    if (!isObj(c) || typeof c.message !== 'string' || !Number.isFinite(c.ms)) continue;
    const paths = (v) => arr(v).filter((f) => typeof f === 'string');
    out.push({ ms: c.ms, message: c.message, files: paths(c.files), added: paths(c.added) });
  }
  return out;
}
