// Pure helpers for the dashboard page: words, numbers, the life line and the decisions the page makes about the
// model (what folds into "Done earlier", what Triage lists). No DOM and no I/O, so the Node tests import this
// file directly; app.js imports it in the browser. Every string here ends up in the page through textContent.

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** An epic untouched this long, with no live session on it, folds into "Done earlier" (R14, provisional). */
export const EARLIER_AFTER_MS = 7 * DAY;
/** "Waiting on you" moves up to Needs a look in Triage after this many minutes, unless the model carries
 *  thresholds.waitingEscalate (the config value). */
export const WAIT_ESCALATE_MIN = 15;

export const STATE_LABEL = Object.freeze({
  working: 'Working', waiting: 'Waiting on you', idle: 'Idle', stuck: 'Looks stuck', gone: 'Gone',
});

// The class suffix and filter token each state uses (the mockup's s-work, s-wait, s-stuck, s-idle, s-done).
export const STATE_CLASS = Object.freeze({
  working: 'work', waiting: 'wait', stuck: 'stuck', gone: 'gone', idle: 'idle', quiet: 'idle',
});

/** The count pill a state answers to. Gone is a stall too, so the "Looks stuck" pill and Triage agree. */
export function filterToken(state) {
  if (state === 'gone') return 'stuck';
  return { working: 'work', waiting: 'wait', stuck: 'stuck' }[state] ?? 'idle';
}

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const arr = (v) => (Array.isArray(v) ? v : []);

/** A duration as the page shows it: "<1m", "6m", "2h 05m", "4d 6h". Empty for anything that is not a duration. */
export function formatDuration(ms) {
  if (!num(ms) || ms < 0) return '';
  if (ms < MIN) return '<1m';
  const m = Math.floor(ms / MIN);
  if (m < 60) return `${m}m`;
  if (m < 24 * 60) return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(m / (24 * 60))}d ${Math.floor((m % (24 * 60)) / 60)}h`;
}

/** A coarse age in words: "30 min", "3 hours", "2 days". */
export function agoWords(ms) {
  if (!num(ms) || ms < 0) return '';
  if (ms < HOUR) return `${Math.max(1, Math.floor(ms / MIN))} min`;
  if (ms < DAY) return plural(Math.floor(ms / HOUR), 'hour');
  return plural(Math.floor(ms / DAY), 'day');
}

/** "updated 4s ago" text: seconds under a minute, then minutes. */
export function updatedText(ms) {
  if (!num(ms) || ms < 0) return '';
  if (ms < MIN) return `${Math.floor(ms / 1000)}s ago`;
  return `${Math.floor(ms / MIN)}m ago`;
}

export function shortId(id) {
  return typeof id === 'string' && id ? id.slice(0, 4) : '?';
}

/** Token counts: 820, 3.4k, 51k, 1.2M. */
export function formatTokens(n) {
  if (!num(n) || n < 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 10000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 1e6) return `${Math.round(n / 1000)}k`;
  return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
}

export function shortDate(ms) {
  if (!num(ms)) return '';
  const d = new Date(ms);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getDate()} ${months[d.getMonth()]}`;
}

// ---- the life line --------------------------------------------------------------------------------------------

/**
 * The ridge path for a session's last hour: viewBox 0 0 120 18, one slot per minute (index 59 = this minute),
 * x = 2i + 1. A silent minute sits on the baseline (y 16); an active one rises, higher where the minutes around
 * it were active too, so a busy stretch reads as a ridge and a lone sign of life as a spike.
 */
export function lifePath(minutes) {
  const m = new Array(60).fill(0);
  const src = arr(minutes);
  for (let i = 0; i < 60; i++) { const v = Number(src[i]); m[i] = Number.isFinite(v) && v > 0 ? 1 : 0; }
  const pts = ['M0 16'];
  for (let i = 0; i < 60; i++) {
    let y = 16;
    if (m[i]) {
      let n = 0;
      let c = 0;
      for (let j = i - 2; j <= i + 2; j++) if (j >= 0 && j < 60) { n += m[j]; c += 1; }
      y = Math.round((16 - 13 * (0.4 + 0.6 * (n / c))) * 10) / 10;
    }
    pts.push(`L${i * 2 + 1} ${y}`);
  }
  pts.push('L120 16');
  return pts.join(' ');
}

// ---- folding (R14) --------------------------------------------------------------------------------------------

/** Latest known activity of an epic (task doneMs or startedMs); when no task carries a time, the plan file's
 *  last change (epic.mtimeMs, R25); else null. */
export function epicLastActivity(epic) {
  let best = null;
  for (const t of arr(epic?.tasks)) {
    for (const v of [t?.doneMs, t?.startedMs]) if (num(v) && (best === null || v > best)) best = v;
  }
  return best ?? (num(epic?.mtimeMs) ? epic.mtimeMs : null);
}

export const epicDone = (epic) => arr(epic?.tasks).length > 0 && arr(epic.tasks).every((t) => t?.status === 'done');

/**
 * R14 (provisional): an epic folds into "Done earlier" when no task is doing or waiting, no task is linked to a
 * live session, and its latest activity is known and more than 7 days old. Unknown activity never folds.
 * Decision 32: plans from before the dashboard (`before`) and dropped plans (`dropped`) go to their own groups
 * first, outside both.
 * @returns {{shown: object[], earlier: object[], before: object[], dropped: object[]}} each in the input order
 */
export function foldEpics(epics, now, liveSessionIds) {
  const live = liveSessionIds instanceof Set ? liveSessionIds : new Set();
  const shown = [];
  const earlier = [];
  const before = [];
  const dropped = [];
  for (const e of arr(epics)) {
    if (e?.dropped === true) { dropped.push(e); continue; }
    if (e?.before === true) { before.push(e); continue; }
    const tasks = arr(e?.tasks);
    const touched = tasks.some((t) => t?.status === 'doing' || t?.status === 'waiting' || (t?.sessionId && live.has(t.sessionId)));
    const last = epicLastActivity(e);
    if (!touched && last !== null && now - last > EARLIER_AFTER_MS) earlier.push(e);
    else shown.push(e);
  }
  return { shown, earlier, before, dropped };
}

/**
 * Tree groups, in display order. `history` groups show only with "Show all history"; `open` is the default fold
 * (Focus). Spec 2026-11-19-dashboard-wayfinding-design.md.
 */
export const GROUPS = Object.freeze([
  { id: 'running', label: 'Running', history: false, open: true },
  { id: 'waiting', label: 'Waiting on you', history: false, open: true },
  { id: 'next', label: 'Next', history: false, open: false },
  { id: 'done', label: 'Done', history: false, open: false },
  { id: 'quiet', label: 'Quiet for a week', history: true, open: false },
  { id: 'doneEarlier', label: 'Done earlier', history: true, open: false },
  { id: 'before', label: 'Before the dashboard', history: true, open: false },
  { id: 'dropped', label: 'dropped', history: true, open: false },
].map((g) => Object.freeze(g)));

/** Newest activity first; epics with no known activity last, in source order (Array#sort is stable). */
function byActivity(epics) {
  const k = (e) => epicLastActivity(e);
  return [...epics].sort((a, b) => {
    const x = k(a);
    const y = k(b);
    if (x === null || y === null) return x === null ? (y === null ? 0 : 1) : -1;
    return y - x;
  });
}

/**
 * foldEpics split by state. An epic goes to the first that applies: any task work/stuck/gone -> running; any
 * wait -> waiting; unfinished -> next; else done. Week-old epics split into quiet (unfinished) and doneEarlier.
 * `stateOf(task)` is the page's task state. `shown` (running, waiting, next, done) is what work left counts.
 */
export function groupEpics(epics, now, liveSessionIds, stateOf) {
  const { shown, earlier, before, dropped } = foldEpics(epics, now, liveSessionIds);
  const g = { running: [], waiting: [], next: [], done: [] };
  for (const e of shown) {
    const st = arr(e?.tasks).map((t) => { try { return stateOf(t); } catch { return 'idle'; } });
    if (st.some((s) => s === 'work' || s === 'stuck' || s === 'gone')) g.running.push(e);
    else if (st.includes('wait')) g.waiting.push(e);
    else if (!epicDone(e)) g.next.push(e);
    else g.done.push(e);
  }
  const out = {
    running: byActivity(g.running), waiting: byActivity(g.waiting), next: byActivity(g.next), done: byActivity(g.done),
    quiet: byActivity(earlier.filter((e) => !epicDone(e))), doneEarlier: byActivity(earlier.filter((e) => epicDone(e))),
    before: byActivity(before), dropped: byActivity(dropped),
  };
  out.shown = [...out.running, ...out.waiting, ...out.next, ...out.done];
  return out;
}

/** A fold the person set (a stored boolean) wins; otherwise the default. */
export const foldOpen = (openState, key, dflt) => (typeof openState?.[key] === 'boolean' ? openState[key] : !!dflt);

/** The epic (`e|root|id`) and group (`g|root|id`) fold keys of one project; Focus deletes them. */
export function projectFoldKeys(openState, root) {
  return Object.keys(openState ?? {}).filter((k) => {
    const [kind, r] = k.split('|');
    return (kind === 'e' || kind === 'g') && r === root;
  });
}

/** Unfinished tasks in the shown epics, with the model's hours estimate scaled to that count. */
export function effortLeft(tree, shownEpics) {
  const count = arr(shownEpics).reduce((n, e) => n + arr(e?.tasks).filter((t) => t?.status !== 'done').length, 0);
  const all = tree?.left?.count;
  const hours = tree?.left?.hours;
  const scaled = num(hours) && num(all) && all > 0 ? Math.round((hours / all) * count * 10) / 10 : null;
  return { count, hours: count > 0 ? scaled : null };
}

const SIZE_ORDER = ['L', 'M', 'S'];

/** Unfinished tasks by size, "2L 1M 3S": L, M, S first, any other size after them alphabetically. */
export function sizeSummary(shownEpics) {
  const n = new Map();
  for (const e of arr(shownEpics)) {
    for (const t of arr(e?.tasks)) if (t?.status !== 'done' && t?.size) n.set(t.size, (n.get(t.size) ?? 0) + 1);
  }
  const rank = (s) => { const i = SIZE_ORDER.indexOf(s); return i < 0 ? SIZE_ORDER.length : i; };
  return [...n].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b)).map(([s, c]) => `${c}${s}`).join(' ');
}

export function liveIds(project) {
  return new Set(arr(project?.sessions).filter((s) => s?.alive).map((s) => s.sessionId));
}

// ---- usage ----------------------------------------------------------------------------------------------------

/** Both plan windows, or available: false ("Usage not available") when the numbers are missing or stale. */
export function usageView(usage, now) {
  const w = (x, label) => (x && num(x.pct) && num(x.resetsAt)
    ? { label, pct: Math.round(x.pct), resetsIn: formatDuration(Math.max(0, x.resetsAt - now)), hot: x.pct >= 75 }
    : { label, pct: null, resetsIn: '', hot: false });
  if (!usage || usage.stale || (!usage.fiveHour && !usage.week)) return { available: false, meters: [] };
  return { available: true, meters: [w(usage.fiveHour, '5-hour'), w(usage.week, 'Week')] };
}

// ---- hover details --------------------------------------------------------------------------------------------

const SESSION_PHRASE = {
  working: 'working', waiting: 'waiting on you', idle: 'idle (your turn)', stuck: 'looks stuck',
  gone: 'gone (its process ended with a tool still running)',
};

const sentence = (s) => {
  const t = String(s ?? '').trim();
  if (!t) return '';
  return /[.!?]$/.test(t) ? t : `${t}.`;
};
const join = (...parts) => parts.map(sentence).filter(Boolean).join(' ');

function helperCounts(session) {
  const subs = arr(session?.subagents);
  const running = subs.filter((a) => a?.finished !== true && ['working', 'stuck', 'waiting'].includes(a?.state)).length;
  const finished = subs.length - running + (num(session?.subagentsHidden) ? session.subagentsHidden : 0);
  return { running, finished };
}

function reason(state, evidence) {
  if (state !== 'stuck' && state !== 'waiting' && state !== 'gone') return '';
  return evidence ? `${STATE_LABEL[state]}: ${evidence}` : STATE_LABEL[state];
}

function taskText({ task, session }) {
  const t = task ?? {};
  const spent = num(t.spentMin) && t.spentMin > 0 ? formatDuration(t.spentMin * MIN) : '';
  let who;
  if (t.status === 'done') who = spent ? `Done in ${spent}` : 'Done';
  else if (t.status === 'next') who = 'Not started';
  else {
    const base = session ? `Session ${shortId(session.sessionId)} is on it`
      : t.status === 'waiting' ? 'Waiting on you' : 'In progress';
    who = spent ? `${base}, ${spent} so far` : base;
  }
  return join(t.title || 'Untitled task', who, session ? reason(session.state, session.evidence) : '');
}

function sessionText({ session, project }) {
  const s = session ?? {};
  const { running, finished } = helperCounts(s);
  const tk = s.tokens ?? {};
  const tin = (tk.input ?? 0) + (tk.cacheRead ?? 0) + (tk.cacheCreate ?? 0);
  return join(
    `A Claude Code window in ${project?.name ?? 'this project'}, ${SESSION_PHRASE[s.state] ?? 'state unknown'}`,
    s.evidence, s.hint,
    `${plural(running, 'helper')} running, ${finished} finished`,
    s.linkedTask?.title ? `Linked to ${s.linkedTask.title}` : '',
    tin || tk.output ? `${formatTokens(tin)} tokens in and ${formatTokens(tk.output ?? 0)} out so far in this session` : '',
  );
}

function subagentText({ subagent, session, project, now }) {
  const a = subagent ?? {};
  const where = project?.name ? ` in ${project.name}` : '';
  const state = a.finished === true ? 'Finished' : a.state === 'working' ? 'Still active' : reason(a.state, a.evidence) || 'Idle';
  return join(
    `A helper started by session ${shortId(session?.sessionId)}${where}: ${a.description || 'Subagent'}`,
    a.model ? `Runs on ${a.model}` : '',
    state,
    num(a.lastWriteMs) && num(now) ? `Last wrote ${formatDuration(Math.max(0, now - a.lastWriteMs))} ago` : '',
  );
}

function epicText({ epic }) {
  const tasks = arr(epic?.tasks);
  const done = tasks.filter((t) => t?.status === 'done').length;
  const spent = num(epic?.spentMin) && epic.spentMin > 0 ? `, ${formatDuration(epic.spentMin * MIN)} spent` : '';
  return `${done} of ${tasks.length} tasks done${spent}.`;
}

const PROJECT_PHRASE = {
  stuck: 'Something here looks stuck', waiting: 'A session is waiting on you', working: 'Work is moving',
  gone: 'A session ended with a tool still running', idle: 'Sessions are open, none of them working',
  quiet: 'Nothing running',
};

function projectText({ project, now }) {
  const p = project ?? {};
  const sessions = arr(p.sessions).filter((s) => s?.alive);
  const epics = arr(p.tree?.epics);
  const { shown } = foldEpics(epics, num(now) ? now : Date.now(), liveIds(p));
  const left = effortLeft(p.tree, shown);
  const spent = p.tree?.spentMin > 0 ? `${formatDuration(p.tree.spentMin * MIN)} spent so far` : '';
  const quiet = p.state === 'quiet' && num(p.quietSince) && num(now) ? `Quiet for ${agoWords(now - p.quietSince)}` : '';
  return join(
    PROJECT_PHRASE[p.state] ?? '',
    quiet,
    sessions.length ? `${plural(sessions.length, 'session')} open` : '',
    p.error,
    epics.length ? `${plural(left.count, 'task')} left${left.hours ? `, about ${left.hours}h` : ''}` : 'No plan found',
    spent,
  );
}

/**
 * One plain paragraph about a task, session, subagent, epic or project.
 * item: {kind: 'task', task, epic?, session?} | {kind: 'session', session, project, now}
 *     | {kind: 'subagent', subagent, session, project, now} | {kind: 'epic', epic} | {kind: 'project', project, now}
 */
export function detailText(item) {
  try {
    switch (item?.kind) {
      case 'task': return taskText(item);
      case 'session': return sessionText(item);
      case 'subagent': return subagentText(item);
      case 'epic': return epicText(item);
      case 'project': return projectText(item);
      default: return '';
    }
  } catch {
    return '';
  }
}

// ---- what a session is doing ----------------------------------------------------------------------------------

/** The short "what" for a session row and the second, muted line with its live timer (ms to count from). */
export function sessionWhat(s) {
  const tool = s?.pendingTool;
  const toolLabel = tool ? (tool.command ? tool.command.split('\n')[0] : tool.name) : '';
  let what;
  if (s?.name) what = s.name;
  else if (s?.state === 'waiting') what = 'Waiting for your answer';
  else if (tool && tool.name !== 'Agent' && tool.name !== 'Task') what = `Running ${toolLabel}`;
  else if (tool) what = 'Waiting on a helper';
  else what = { working: 'Working', idle: 'Your turn', stuck: 'Gone quiet', gone: 'Process ended' }[s?.state] ?? 'Unknown';
  let line = null;
  if (s?.state === 'waiting' && num(s.since)) line = { prefix: 'prompt open', from: s.since };
  else if (tool && num(tool.startedMs)) line = { prefix: `${tool.name} running`, from: tool.startedMs };
  else if (num(s?.lastWriteMs)) line = { prefix: 'last activity', from: s.lastWriteMs, suffix: ' ago' };
  return { what, line };
}

/** The "now" line under a task a session is on: what that session is doing this minute. */
export function nowLine(s) {
  if (!s) return '';
  if (s.state === 'stuck' || s.state === 'gone') return s.evidence || STATE_LABEL[s.state];
  if (s.state === 'waiting') return s.evidence || 'waiting on you';
  if (s.state !== 'working') return '';
  const tool = s.pendingTool;
  if (tool?.command) return tool.command.split('\n')[0];
  if (tool) return tool.name === 'Agent' || tool.name === 'Task' ? 'waiting on a helper' : tool.name;
  return 'working';
}

// ---- triage ---------------------------------------------------------------------------------------------------

/**
 * Needs a look: stuck sessions and subagents, gone sessions, and waits of model.thresholds.waitingEscalate minutes
 * or more (15 when absent; longest first).
 * Moving: shorter waits, working sessions and working subagents. Up next: each project's next tasks in its shown
 * epics. Items: {project, session, subagent?}; next: [{project, tasks: [{...task, epicTitle}]}].
 */
export function triage(model, now) {
  const stuck = [];
  const gone = [];
  const longWait = [];
  const shortWait = [];
  const working = [];
  const next = [];
  const esc = model?.thresholds?.waitingEscalate;
  const escalateMs = (num(esc) && esc >= 0 ? esc : WAIT_ESCALATE_MIN) * MIN;
  for (const p of arr(model?.projects)) {
    for (const s of arr(p?.sessions)) {
      if (s.state === 'stuck') stuck.push({ project: p, session: s });
      else if (s.state === 'gone') gone.push({ project: p, session: s });
      else if (s.state === 'waiting') {
        const waited = num(s.since) ? now - s.since : 0;
        (waited >= escalateMs ? longWait : shortWait).push({ project: p, session: s, waited });
      } else if (s.state === 'working') working.push({ project: p, session: s });
      for (const a of arr(s.subagents)) {
        if (a?.state === 'stuck') stuck.push({ project: p, session: s, subagent: a });
        else if (a?.state === 'working' && a.finished !== true) working.push({ project: p, session: s, subagent: a });
      }
    }
    const { shown } = foldEpics(p?.tree?.epics, now, liveIds(p));
    const tasks = shown.flatMap((e) => arr(e.tasks).filter((t) => t?.status === 'next').map((t) => ({ ...t, epicTitle: e.title })));
    if (tasks.length) next.push({ project: p, tasks });
  }
  longWait.sort((a, b) => b.waited - a.waited);
  return { needs: [...stuck, ...gone, ...longWait], moving: [...shortWait, ...working], next };
}
