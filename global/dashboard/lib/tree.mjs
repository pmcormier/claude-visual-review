// The merge layer: one project's work tree from its sources (work log, plans, BMAD, Inbox), git commits, live
// sessions and plan-touch events. Pure: every input is passed in already loaded, and nothing is mutated.
// Spec "Task status (the tree)" and "Calls made". Never throws; missing or odd inputs are treated as empty.
//
// Merge: a work-log epic whose `file` resolves to a listed plan sets the status of the plan tasks it names (by
// `n`) and is not listed itself; otherwise a work-log epic hides any other epic with the same title
// (case-insensitive, trimmed). Everything else is listed side by side: plans, BMAD, Inbox, then the work log.
// Plan task status: commit-done, ticks-done or work-log done -> done; work-log doing/waiting -> that;
// linked live session -> doing; else the plan's own (some ticks -> doing, none -> next).
import { loadConfig } from './config.mjs';
import {
  MIN, arr, toMs, planIndex, cleanEvents, cleanSessions, cleanCommits, activityBySession, spanMs, matchCommits,
} from './tree-match.mjs';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const titleKey = (s) => String(s ?? '').trim().toLowerCase();
const STATUSES = new Set(['done', 'doing', 'next', 'waiting']);

function cleanEpics(list, source) {
  const out = [];
  for (const e of arr(list)) {
    if (!isObj(e)) continue;
    out.push({
      id: String(e.id ?? `${source}:${out.length + 1}`), source: e.source ?? source, title: String(e.title ?? ''),
      file: typeof e.file === 'string' && e.file ? e.file : null,
      ...(Number.isFinite(e.mtimeMs) ? { mtimeMs: e.mtimeMs } : {}),
      tasks: arr(e.tasks).filter(isObj).map((t, i) => ({
        id: String(t.id ?? `${e.id}#${i + 1}`), n: Number.isInteger(t.n) ? t.n : null, title: String(t.title ?? ''),
        status: STATUSES.has(t.status) ? t.status : 'next', size: t.size ?? null,
        sessionId: typeof t.sessionId === 'string' && t.sessionId ? t.sessionId : null,
        startedMs: toMs(t.startedMs), doneMs: toMs(t.doneMs), ticked: isObj(t.ticked) ? { ...t.ticked } : null,
      })),
    });
  }
  return out;
}

// Work-log epics naming a plan: per plan task, the latest work-log task naming it (log order).
function mergeWorklog(worklog, index) {
  const listed = [];
  const override = new Map(); // plan task -> work-log task
  const target = new Map(); // work-log task id -> plan task (for link tier 0)
  for (const e of worklog) {
    const plan = e.file ? index.find(e.file) : null;
    if (!plan) { listed.push(e); continue; }
    for (const w of e.tasks) {
      const t = w.n === null ? null : plan.tasks.find((p) => p.n === w.n);
      if (!t) continue;
      override.set(t, w);
      target.set(w.id, t);
    }
  }
  return { listed, override, target };
}

function applyPlanStatus(plans, override, commitDone) {
  for (const p of plans) {
    for (const t of p.tasks) {
      const w = override.get(t);
      const cms = commitDone.get(t.id);
      if (w) {
        if (w.sessionId) t.sessionId = w.sessionId;
        if (w.startedMs !== null) t.startedMs = w.startedMs;
      }
      if (cms !== undefined || t.status === 'done' || w?.status === 'done') {
        t.status = 'done';
        t.doneMs = w?.status === 'done' && w.doneMs !== null ? w.doneMs : cms ?? t.doneMs;
        if (cms !== undefined) t._commitMs = cms;
      } else if (w && (w.status === 'doing' || w.status === 'waiting')) {
        t.status = w.status;
      }
    }
  }
}

const latest = (list) => (list.length ? list[list.length - 1] : null);

// Link order (spec): 0 work log (task doing or waiting), 1 Inbox checklist, 2 plan touch (events or transcript planRefs) + latest
// `Task N` in that plan, 3 latest `Task N` alone when exactly one plan has that task unfinished.
function linkSession(sid, ctx) {
  for (let i = ctx.worklog.length - 1; i >= 0; i--) {
    const w = ctx.worklog[i].tasks.find((t) => t.sessionId === sid && (t.status === 'doing' || t.status === 'waiting'));
    const t = w ? ctx.target.get(w.id) ?? (ctx.listedTasks.has(w) ? w : null) : null;
    if (t && ctx.shown.has(t)) return t;
  }
  const inboxTask = latest(ctx.inbox.flatMap((e) => e.tasks.filter((t) => t.sessionId === sid && t.status === 'doing')));
  if (inboxTask) return inboxTask;
  const a = ctx.activity.get(sid);
  if (!a) return null;
  const touch = latest(a.touches);
  if (touch && ctx.plans.includes(touch.plan)) {
    const ref = [...a.taskRefs].reverse().find((r) => touch.plan.tasks.some((t) => t.n === r.n));
    if (ref) return touch.plan.tasks.find((t) => t.n === ref.n);
  }
  const ref = latest(a.taskRefs);
  if (!ref) return null;
  const hits = ctx.plans.flatMap((p) => p.tasks.filter((t) => t.n === ref.n && t.status !== 'done'));
  return hits.length === 1 ? hits[0] : null;
}

// Time spent: the task's own timestamps, its done commit, and the activity of its session inside the task's
// window. The window starts at startedMs, else at the session's first signal naming this task (a touch of its
// plan or a `Task N` ref); with neither, the session's activity is not counted. It ends at doneMs if known.
function spentMin(t, plan, activity, idleMs) {
  const spans = [];
  for (const v of [t.startedMs, t.doneMs, t._commitMs]) if (Number.isFinite(v)) spans.push([v, v]);
  const a = t.sessionId ? activity.get(t.sessionId) : null;
  if (a) {
    let lo = t.startedMs;
    if (lo === null && plan && t.n !== null) {
      const first = [
        ...a.touches.filter((x) => x.plan === plan).map((x) => x.ms),
        ...a.taskRefs.filter((r) => r.n === t.n).map((r) => r.ms),
      ];
      if (first.length) lo = Math.min(...first);
    }
    const hi = t.doneMs ?? t._commitMs ?? Infinity;
    if (lo !== null) {
      for (const [s, e] of a.spans) if (e >= lo && s <= hi) spans.push([Math.max(s, lo), Math.min(e, hi)]);
    }
  }
  return Math.round(spanMs(spans, idleMs) / MIN);
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * @param {string} root project root
 * @param {{worklog?, plans?, bmad?, inbox?, commits?, sessions?, events?, now?: number}} inputs
 *   sessions: live sessions `{sessionId, planRefs, taskRefs, minutes, lastWriteMs}` (or those under `signals`);
 *   events: events.jsonl lines `{session, file, at}`; now: the moment `minutes` ends (default Date.now()).
 *   liveSessionIds: (optional, Set or array) ids of every live session; when given, a work-log task `doing`
 *   under a session not in it reads `next`.
 * @param {{idleGap: number}} [thresholds] only idleGap is read. When omitted (not an object), buildTree calls
 *   loadConfig() and so reads <dashHome>/config.json; that is its only I/O. Pass thresholds to keep it pure.
 * @returns {{epics: import('./types.mjs').Epic[], left: {count: number, hours: number|null}, spentMin: number,
 *   links: Record<string, string>}} links: live session id -> linked task id
 */
export function buildTree(root, inputs, thresholds) {
  try {
    const th = isObj(thresholds) ? thresholds : loadConfig().thresholds;
    const idleMs = (Number.isFinite(th.idleGap) && th.idleGap > 0 ? th.idleGap : 15) * MIN;
    const inp = isObj(inputs) ? inputs : {};
    const now = Number.isFinite(inp.now) ? inp.now : Date.now();

    const plans = cleanEpics(inp.plans, 'plan').filter((p) => p.file);
    const worklog = cleanEpics(inp.worklog, 'worklog');
    // A work-log task left `doing` by a session that is no longer live is not being worked on: it reads `next`.
    // Only when the caller knows which sessions are live (liveSessionIds); a task with no session is left alone.
    if (inp.liveSessionIds instanceof Set || Array.isArray(inp.liveSessionIds)) {
      const liveIds = new Set(inp.liveSessionIds);
      for (const e of worklog) {
        for (const t of e.tasks) if (t.status === 'doing' && t.sessionId && !liveIds.has(t.sessionId)) t.status = 'next';
      }
    }
    const bmad = cleanEpics(inp.bmad, 'bmad');
    let inbox = cleanEpics(inp.inbox, 'inbox');
    const index = planIndex(root, plans);
    const live = cleanSessions(inp.sessions);
    const activity = activityBySession(cleanEvents(inp.events), live, index, now);

    const commitDone = matchCommits(root, plans, cleanCommits(inp.commits), activity, idleMs);
    const { listed, override, target } = mergeWorklog(worklog, index);
    applyPlanStatus(plans, override, commitDone);

    const wlTitles = new Set(listed.map((e) => titleKey(e.title)));
    const keep = (e) => !wlTitles.has(titleKey(e.title));
    const shownPlans = plans.filter(keep);
    inbox = inbox.filter(keep);
    const epics = [...shownPlans, ...bmad.filter(keep), ...inbox, ...listed];

    const listedTasks = new Set(listed.flatMap((e) => e.tasks));
    const shown = new Set(epics.flatMap((e) => e.tasks));
    const ctx = { worklog, target, listedTasks, shown, inbox, activity, plans: shownPlans };
    const links = {};
    for (const s of live) {
      const t = linkSession(s.id, ctx);
      if (!t) continue;
      links[s.id] = t.id;
      t.sessionId = s.id;
      if (t.status === 'next') t.status = 'doing';
    }

    let total = 0;
    let count = 0;
    const measured = [];
    const planOf = new Map(plans.flatMap((p) => p.tasks.map((t) => [t, p])));
    for (const e of epics) {
      e.spentMin = 0;
      for (const t of e.tasks) {
        t.spentMin = spentMin(t, planOf.get(t) ?? null, activity, idleMs);
        delete t._commitMs;
        e.spentMin += t.spentMin;
        if (t.status !== 'done') count += 1;
        else if (t.spentMin > 0) measured.push(t.spentMin);
      }
      total += e.spentMin;
    }
    const hours = measured.length >= 3 ? Math.round((median(measured) / 60) * count * 10) / 10 : null;
    return { epics, left: { count, hours }, spentMin: total, links };
  } catch {
    return { epics: [], left: { count: 0, hours: null }, spentMin: 0, links: {} };
  }
}
