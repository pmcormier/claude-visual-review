// Pure render helpers of the dashboard page (global/dashboard/page/render.mjs). No DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDuration, lifePath, detailText, foldEpics, effortLeft, usageView, triage, agoWords, shortId, STATE_LABEL,
  sizeSummary, filterToken, GROUPS, groupEpics, foldOpen, projectFoldKeys, tipText, currentTask, panelOrder, formatSpend, spendLine, projectSpend, formatTokens,
  taskLiveness, leftOpenText, sessionLabel, projectOpen, STALE_AFTER_MS, sessionWhat, nowLines, themeLabel,
  compactSplit, busiestSession, squareSteps, viewFromLocation,
} from '../../global/dashboard/page/render.mjs';

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);

test('formatDuration', () => {
  assert.equal(formatDuration(0), '<1m');
  assert.equal(formatDuration(59 * 1000), '<1m');
  assert.equal(formatDuration(6 * MIN), '6m');
  assert.equal(formatDuration(59 * MIN + 59000), '59m');
  assert.equal(formatDuration(HOUR), '1h 00m');
  assert.equal(formatDuration(2 * HOUR + 5 * MIN), '2h 05m');
  assert.equal(formatDuration(23 * HOUR + 59 * MIN), '23h 59m');
  assert.equal(formatDuration(4 * DAY + 6 * HOUR + 30 * MIN), '4d 6h');
  for (const bad of [-1, NaN, null, undefined, Infinity, '5']) assert.equal(formatDuration(bad), '', String(bad));
});

test('agoWords and shortId', () => {
  assert.equal(agoWords(30 * MIN), '30 min');
  assert.equal(agoWords(3 * HOUR), '3 hours');
  assert.equal(agoWords(HOUR), '1 hour');
  assert.equal(agoWords(2 * DAY + HOUR), '2 days');
  assert.equal(agoWords(DAY), '1 day');
  assert.equal(agoWords(null), '');
  assert.equal(shortId('4f982892-d5cd'), '4f98');
  assert.equal(shortId(null), '?');
});

const ys = (d) => [...d.matchAll(/L(\d+) ([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);

test('lifePath flat when all zero', () => {
  const d = lifePath(new Array(60).fill(0));
  assert.match(d, /^M0 16 /);
  assert.match(d, / L120 16$/);
  const pts = ys(d);
  assert.equal(pts.length, 61); // 60 slots plus the closing point
  assert.ok(pts.every(([, y]) => y === 16));
  assert.equal(lifePath(null), d); // missing data draws the same flat line
  assert.equal(ys(lifePath([1, 'x', -3])).length, 61); // short or odd input still draws 60 slots
});

test('lifePath rises only where there was activity, newest minute on the right', () => {
  const m = new Array(60).fill(0);
  m[59] = 1;
  const pts = ys(lifePath(m)).slice(0, 60);
  assert.equal(pts[59][0], 119);
  assert.ok(pts[59][1] < 16, 'the active minute rises');
  assert.ok(pts.slice(0, 59).every(([, y]) => y === 16), 'silent minutes stay on the baseline');
  const busy = ys(lifePath(new Array(60).fill(1))).slice(0, 60);
  assert.ok(busy.every(([, y]) => y >= 3 && y < 16), 'inside the 18-high box');
});

const stuckSession = {
  sessionId: '34d4aa00-0000', state: 'stuck', alive: true, evidence: 'pytest running 52 min · 0% CPU · no output for 31 min',
  hint: null, since: NOW - 31 * MIN, lastWriteMs: NOW - 31 * MIN, pendingTool: { name: 'Bash', command: 'pytest -q', startedMs: NOW - 52 * MIN },
  tokens: { input: 1200, output: 3400, cacheRead: 50000, cacheCreate: 0 }, subagents: [], subagentsHidden: 0,
  linkedTask: { id: 't3', title: 'Fixture migration', epic: 'Invoice export', status: 'doing' },
};

test('detailText for a stuck task includes its evidence', () => {
  const task = { id: 't3', title: 'Fixture migration', status: 'doing', sessionId: stuckSession.sessionId, spentMin: 112, size: 'L' };
  const text = detailText({ kind: 'task', task, epic: { title: 'Invoice export', tasks: [task] }, session: stuckSession });
  assert.match(text, /^No description yet\.\n\n/);
  assert.match(text, /Session 34d4 is on it, 1h 52m so far\./);
  assert.match(text, /Looks stuck: pytest running 52 min · 0% CPU · no output for 31 min\./);
});

test('detailText templates for the other kinds', () => {
  const next = { id: 'a', title: 'PDF layout', status: 'next', spentMin: 0 };
  assert.equal(detailText({ kind: 'task', task: next }), 'No description yet.\n\nNot started.');
  const done = { id: 'b', title: 'CSV writer', status: 'done', spentMin: 50 };
  assert.equal(detailText({ kind: 'task', task: { ...done, about: 'Writes the invoices out as CSV.' } }), 'Writes the invoices out as CSV.\n\nDone in 50m.');
  assert.equal(detailText({ kind: 'task', task: { ...done, spentMin: 0 } }), 'No description yet.\n\nDone.');
  assert.equal(detailText({ kind: 'epic', epic: { title: 'X', spentMin: 210, tasks: [done, next, { ...done, id: 'c' }] } }),
    '2 of 3 tasks done, 3h 30m spent.');

  const s = {
    ...stuckSession, state: 'working', evidence: null,
    subagents: [{ agentId: 'x', state: 'working', finished: false }, { agentId: 'y', state: 'idle', finished: true }],
    subagentsHidden: 4,
  };
  const st = detailText({ kind: 'session', session: s, project: { name: 'billing-api' }, now: NOW });
  assert.match(st, /^A Claude Code window in billing-api, working\./);
  assert.match(st, /1 helper running, 5 finished\./);
  assert.match(st, /51\.2k tokens in and 3\.4k out so far in this session\./);
  assert.match(st, /Linked to Fixture migration\./);
  const sst = detailText({ kind: 'session', session: stuckSession, project: { name: 'billing-api' }, now: NOW });
  assert.match(sst, /looks stuck\. pytest running 52 min/);

  const a = { agentId: 'q', description: 'Migrate fixtures', model: 'sonnet', state: 'stuck', finished: false,
    evidence: 'Not marked finished · transcript unchanged for 48 min', lastWriteMs: NOW - 48 * MIN };
  const at = detailText({ kind: 'subagent', subagent: a, session: stuckSession, project: { name: 'billing-api' }, now: NOW });
  assert.match(at, /^A helper started by session 34d4 in billing-api: Migrate fixtures\./);
  assert.match(at, /Looks stuck: Not marked finished/);
  assert.match(at, /Last wrote 48m ago\./);

  const p = { name: 'docs-site', state: 'waiting', sessions: [s], tree: { epics: [], left: { count: 0, hours: null }, spentMin: 0 } };
  assert.match(detailText({ kind: 'project', project: p, now: NOW }), /A session is waiting on you\..*No plan found\./);
  assert.equal(detailText({ kind: 'nope' }), '');
  assert.equal(detailText(null), '');
});

test('an epic tip leaves out the time when nothing was measured', () => {
  const tasks = [{ status: 'done' }, { status: 'next' }];
  assert.equal(detailText({ kind: 'epic', epic: { tasks, spentMin: 0 } }), '1 of 2 tasks done.');
  assert.equal(detailText({ kind: 'epic', epic: { tasks } }), '1 of 2 tasks done.');
  assert.equal(detailText({ kind: 'epic', epic: { tasks, spentMin: 65 } }), '1 of 2 tasks done, 1h 05m spent.');
});

test('sizeSummary counts unfinished sizes in a fixed L, M, S order', () => {
  const shown = [
    { tasks: [{ status: 'next', size: 'S' }, { status: 'doing', size: 'M' }, { status: 'done', size: 'L' }] },
    { tasks: [{ status: 'next', size: 'L' }, { status: 'next', size: 'S' }, { status: 'next', size: null }] },
  ];
  assert.equal(sizeSummary(shown), '1L 1M 2S');
  assert.equal(sizeSummary([{ tasks: [{ status: 'next', size: 'XL' }, { status: 'next', size: 'S' }] }]), '1S 1XL');
  assert.equal(sizeSummary([]), '');
});

test('filterToken: gone counts as stuck for the pills', () => {
  assert.equal(filterToken('gone'), 'stuck');
  assert.equal(filterToken('stuck'), 'stuck');
  assert.equal(filterToken('waiting'), 'wait');
  assert.equal(filterToken('working'), 'work');
  assert.equal(filterToken('idle'), 'idle');
  assert.equal(filterToken('quiet'), 'idle');
  assert.equal(filterToken('weird'), 'idle');
});

test('STATE_LABEL is the copy the page shows', () => {
  assert.deepEqual(STATE_LABEL, {
    working: 'Working', waiting: 'Waiting on you', idle: 'Idle', stuck: 'Looks stuck', gone: 'Gone',
  });
});

// R14: an epic untouched for 7 days with no live session linked folds into "Done earlier".
test('foldEpics folds epics untouched for a week, keeps live and unknown ones', () => {
  const ep = (id, tasks) => ({ id, title: id, tasks });
  const old = NOW - 8 * DAY;
  const epics = [
    ep('oldDone', [{ id: '1', status: 'done', doneMs: old, startedMs: old - HOUR }]),
    ep('oldOpen', [{ id: '2', status: 'next', startedMs: old }, { id: '3', status: 'done', doneMs: old }]),
    ep('recent', [{ id: '4', status: 'done', doneMs: NOW - 2 * DAY }]),
    ep('unknown', [{ id: '5', status: 'next' }]),
    ep('oldButDoing', [{ id: '6', status: 'doing', startedMs: old }]),
    ep('oldButLinked', [{ id: '7', status: 'next', startedMs: old, sessionId: 'live1' }]),
    ep('oldButWaiting', [{ id: '8', status: 'waiting', startedMs: old }]),
    ep('empty', []),
  ];
  const { shown, earlier } = foldEpics(epics, NOW, new Set(['live1']));
  assert.deepEqual(earlier.map((e) => e.id), ['oldDone', 'oldOpen']);
  assert.deepEqual(shown.map((e) => e.id), ['recent', 'unknown', 'oldButDoing', 'oldButLinked', 'oldButWaiting', 'empty']);
  // exactly 7 days is not older than 7 days
  assert.equal(foldEpics([ep('edge', [{ id: '9', status: 'done', doneMs: NOW - 7 * DAY }])], NOW, new Set()).earlier.length, 0);
  assert.deepEqual(foldEpics(null, NOW, null), { shown: [], earlier: [], before: [], dropped: [] });
});

// R25: a plan whose tasks carry no times is dated by its file's last change, so a long-finished plan with no
// ticks folds away and leaves Up next and the effort count.
test('an untimed plan epic folds by its file mtime and leaves Up next and the count', () => {
  const oldPlan = { id: 'P1', title: 'Old plan', mtimeMs: NOW - 10 * DAY, tasks: [{ id: 'a', status: 'next' }, { id: 'b', status: 'next' }] };
  const newPlan = { id: 'P2', title: 'New plan', mtimeMs: NOW - DAY, tasks: [{ id: 'c', status: 'next' }] };
  const { shown, earlier } = foldEpics([oldPlan, newPlan], NOW, new Set());
  assert.deepEqual(earlier.map((e) => e.id), ['P1']);
  assert.deepEqual(effortLeft({ left: { count: 3, hours: null } }, shown), { count: 1, hours: null });
  const model = { projects: [{ root: 'r', name: 'r', sessions: [], tree: { epics: [oldPlan, newPlan], left: { count: 3, hours: null } } }] };
  assert.deepEqual(triage(model, NOW).next[0].tasks.map((t) => t.id), ['c']);
  // a task time wins over the file time
  const timed = { ...oldPlan, tasks: [{ id: 'a', status: 'next', startedMs: NOW - DAY }] };
  assert.equal(foldEpics([timed], NOW, new Set()).earlier.length, 0);
});

test('effortLeft counts only the shown epics and scales the estimate', () => {
  const tree = { left: { count: 4, hours: 8 } };
  const shown = [{ tasks: [{ status: 'next' }, { status: 'done' }, { status: 'doing' }] }];
  assert.deepEqual(effortLeft(tree, shown), { count: 2, hours: 4 });
  assert.deepEqual(effortLeft({ left: { count: 4, hours: null } }, shown), { count: 2, hours: null });
  assert.deepEqual(effortLeft(null, []), { count: 0, hours: null });
});

test('usageView: meters with reset times, or not available', () => {
  const u = usageView({ fiveHour: { pct: 42.4, resetsAt: NOW + 72 * MIN }, week: { pct: 80, resetsAt: NOW + 4 * DAY + 6 * HOUR }, stale: false }, NOW);
  assert.equal(u.available, true);
  assert.deepEqual(u.meters, [
    { label: '5-hour', pct: 42, resetsIn: '1h 12m', hot: false },
    { label: 'Week', pct: 80, resetsIn: '4d 6h', hot: true },
  ]);
  assert.equal(usageView({ fiveHour: { pct: 1, resetsAt: NOW + MIN }, week: null, stale: true }, NOW).available, false);
  assert.equal(usageView({ fiveHour: null, week: null, stale: false }, NOW).available, false);
  assert.equal(usageView(null, NOW).available, false);
  const half = usageView({ fiveHour: null, week: { pct: 5, resetsAt: NOW + DAY }, stale: false }, NOW);
  assert.equal(half.meters[0].pct, null);
  assert.equal(half.meters[1].pct, 5);
});

test('triage sorts sessions into needs a look, moving and up next', () => {
  const sess = (id, state, extra = {}) => ({ sessionId: id, state, alive: true, since: null, subagents: [], ...extra });
  const model = {
    projects: [
      {
        root: 'r1', name: 'one', sessions: [
          sess('a', 'stuck', { evidence: 'x' }), sess('b', 'waiting', { since: NOW - 20 * MIN }),
          sess('c', 'waiting', { since: NOW - 2 * MIN }), sess('d', 'working', {
            subagents: [{ agentId: 'g', state: 'stuck', evidence: 'y' }, { agentId: 'h', state: 'working' }],
          }), sess('e', 'gone'), sess('f', 'idle'),
        ],
        tree: { epics: [{ id: 'E', title: 'E', tasks: [{ id: 't1', status: 'next' }, { id: 't2', status: 'done' }] }] },
      },
    ],
  };
  const t = triage(model, NOW);
  assert.deepEqual(t.needs.map((x) => x.session.sessionId + (x.subagent ? '/' + x.subagent.agentId : '')), ['a', 'd/g', 'e', 'b']);
  // The escalation threshold comes from the model when it carries one.
  const late = triage({ ...model, thresholds: { waitingEscalate: 30 } }, NOW);
  assert.ok(!late.needs.some((x) => x.session.sessionId === 'b'), 'a 20-minute wait is not escalated at 30');
  assert.deepEqual(late.moving.map((x) => x.session.sessionId).slice(0, 2), ['b', 'c']);
  const early = triage({ ...model, thresholds: { waitingEscalate: 1 } }, NOW);
  assert.deepEqual(early.needs.slice(-2).map((x) => x.session.sessionId), ['b', 'c']);
  assert.deepEqual(t.moving.map((x) => x.session.sessionId + (x.subagent ? '/' + x.subagent.agentId : '')), ['c', 'd', 'd/h']);
  assert.equal(t.next.length, 1);
  assert.equal(t.next[0].tasks.length, 1);
  assert.equal(t.next[0].tasks[0].id, 't1');
});

// Decision 32: plans from before the dashboard and dropped plans get their own groups, outside shown and earlier.
test('foldEpics puts before-dashboard and dropped epics in their own groups', () => {
  const before = { id: 'B', title: 'Before', before: true, mtimeMs: NOW - 30 * DAY, tasks: [{ id: 'b', status: 'next' }] };
  const dropped = { id: 'D', title: 'Dropped', dropped: true, mtimeMs: NOW - DAY, tasks: [{ id: 'd', status: 'next' }] };
  const current = { id: 'C', title: 'Current', mtimeMs: NOW - DAY, tasks: [{ id: 'c', status: 'next' }] };
  const r = foldEpics([before, dropped, current], NOW, new Set());
  assert.deepEqual(r.shown.map((e) => e.id), ['C']);
  assert.deepEqual(r.earlier.map((e) => e.id), []);
  assert.deepEqual(r.before.map((e) => e.id), ['B']);
  assert.deepEqual(r.dropped.map((e) => e.id), ['D']);
});

test('effortLeft ignores before-dashboard and dropped epics', () => {
  const epics = [
    { id: 'B', before: true, tasks: [{ id: 'b', status: 'next' }] },
    { id: 'D', dropped: true, tasks: [{ id: 'd', status: 'next' }] },
    { id: 'C', mtimeMs: NOW - DAY, tasks: [{ id: 'c', status: 'next' }] },
  ];
  assert.deepEqual(effortLeft({ left: { count: 1, hours: null } }, foldEpics(epics, NOW, new Set()).shown), { count: 1, hours: null });
});

test('Up next and triage leave out before-dashboard and dropped epics', () => {
  const epics = [
    { id: 'B', title: 'B', before: true, tasks: [{ id: 'b', status: 'next' }] },
    { id: 'D', title: 'D', dropped: true, tasks: [{ id: 'd', status: 'next' }] },
    { id: 'C', title: 'C', mtimeMs: NOW - DAY, tasks: [{ id: 'c', status: 'next' }] },
  ];
  const model = { projects: [{ root: 'r', name: 'r', sessions: [], tree: { epics, left: { count: 1, hours: null } } }] };
  assert.deepEqual(triage(model, NOW).next[0].tasks.map((t) => t.id), ['c']);
});

// Wayfinding (spec 2026-11-19-dashboard-wayfinding-design.md): state groups, newest first, fold defaults.
test('groupEpics: exclusive groups by liveness, first that applies', () => {
  const lv = { c: 'current', w: 'waiting', s: 'started', x: 'stale', o: 'other', d: 'other' };
  const livenessOf = (t) => lv[t.id];
  const ep = (id, ids) => ({ id, title: id, tasks: ids.map((i) => ({ id: i, status: i === 'd' ? 'done' : 'doing', startedMs: NOW - HOUR })) });
  const r = groupEpics([ep('run', ['c', 'w', 's']), ep('wait', ['w', 's']), ep('st', ['s', 'o']), ep('stale', ['x']),
    { id: 'n', title: 'n', tasks: [{ id: 'o', status: 'next', startedMs: NOW - HOUR }] }, ep('fin', ['d'])], NOW, new Set(), livenessOf);
  assert.deepEqual(r.running.map((e) => e.id), ['run']);
  assert.deepEqual(r.waiting.map((e) => e.id), ['wait']);
  assert.deepEqual(r.started.map((e) => e.id).sort(), ['st', 'stale']);
  assert.deepEqual(r.next.map((e) => e.id), ['n']);
  assert.deepEqual(r.done.map((e) => e.id), ['fin']);
  assert.equal(r.shown.length, 6);
  assert.deepEqual(GROUPS.map((g) => g.id), ['running', 'waiting', 'started', 'next', 'done', 'quiet', 'doneEarlier', 'before', 'dropped']);
  assert.deepEqual(GROUPS[2], { id: 'started', label: 'Started, not active', history: false, open: false });
});

// Clarity (spec 2026-11-19-dashboard-clarity-design.md): what is really running, and what each task is.
test('taskLiveness: current, started, stale, waiting, other', () => {
  const live = { sessionId: 'L', alive: true, linkedTask: { id: 'cur' } };
  const dead = { sessionId: 'D', alive: false, linkedTask: { id: 'x' } };
  const byId = new Map([['L', live], ['D', dead]]);
  const lv = (t) => taskLiveness({ id: 'x', changedMs: null, ...t }, byId, NOW);
  assert.equal(STALE_AFTER_MS, DAY);
  assert.equal(lv({ id: 'cur', status: 'doing', sessionId: 'L' }), 'current');
  assert.equal(lv({ status: 'doing', sessionId: 'L', changedMs: NOW - 3 * DAY }), 'started'); // live session moved on: not stale
  assert.equal(lv({ status: 'doing', sessionId: 'D', changedMs: NOW - 25 * HOUR }), 'stale');
  assert.equal(lv({ status: 'doing', sessionId: 'D', changedMs: NOW - 23 * HOUR }), 'started');
  assert.equal(lv({ status: 'waiting', sessionId: 'D', changedMs: NOW - 2 * DAY }), 'stale');
  assert.equal(lv({ status: 'waiting', sessionId: 'L', changedMs: NOW - 2 * DAY }), 'waiting');
  assert.equal(lv({ status: 'waiting', sessionId: null, changedMs: NOW - HOUR }), 'waiting');
  assert.equal(lv({ status: 'doing', sessionId: null, changedMs: null }), 'started'); // unknown time is never stale
  assert.equal(lv({ status: 'next', leftOpen: true, sessionId: 'D', changedMs: NOW - 2 * DAY }), 'stale');
  assert.equal(lv({ status: 'next', leftOpen: true, sessionId: 'D', changedMs: NOW - HOUR }), 'started');
  assert.equal(lv({ status: 'next', sessionId: null }), 'other');
  assert.equal(lv({ id: 'cur', status: 'done', sessionId: 'L' }), 'other');
  assert.equal(taskLiveness(null, null, NOW), 'other');
});

test('detailText for a task by liveness: about first, then what is happening', () => {
  const live = { ...stuckSession, state: 'working', evidence: null, alive: true };
  const t = { id: 't', title: 'Cart sync', status: 'doing', sessionId: live.sessionId, about: 'Keeps the cloud copy in step.', changedMs: NOW - 2 * DAY, spentMin: 0 };
  assert.equal(detailText({ kind: 'task', task: t, session: live, liveness: 'current', now: NOW }), 'Keeps the cloud copy in step.\n\nSession 34d4 is on it now.');
  assert.equal(detailText({ kind: 'task', task: t, session: live, liveness: 'started', now: NOW }), 'Keeps the cloud copy in step.\n\nStarted by session 34d4, which has moved on.');
  assert.equal(detailText({ kind: 'task', task: t, liveness: 'started', now: NOW }), 'Keeps the cloud copy in step.\n\nStarted by session 34d4, which has closed.');
  assert.equal(detailText({ kind: 'task', task: t, liveness: 'stale', now: NOW }), 'Keeps the cloud copy in step.\n\nLeft open 2 days ago by session 34d4.');
  assert.equal(detailText({ kind: 'task', task: { ...t, sessionId: null, about: null }, liveness: 'stale', now: NOW }), 'No description yet.\n\nLeft open 2 days ago.');
  assert.equal(detailText({ kind: 'task', task: { ...t, status: 'waiting' }, liveness: 'waiting', now: NOW }), 'Keeps the cloud copy in step.\n\nWaiting on you.');
});

test('leftOpenText counts hours under a day, else days', () => {
  assert.equal(leftOpenText(NOW - 3 * HOUR, NOW), 'left open 3 hours ago');
  assert.equal(leftOpenText(NOW - 50 * HOUR, NOW), 'left open 2 days ago');
  assert.equal(leftOpenText(NOW - 25 * HOUR, NOW), 'left open 1 day ago');
  assert.equal(leftOpenText(null, NOW), 'left open');
});

test('sessionLabel: the title, else the short id', () => {
  assert.equal(sessionLabel({ sessionId: 'ab12cd34-x', title: 'Login bug' }), 'Login bug');
  assert.equal(sessionLabel({ sessionId: 'ab12cd34-x', title: null }), 'Session ab12');
});

test('projectOpen: a fold holds, unless the project became active after it', () => {
  const busy = { state: 'working', open: true, activeSinceMs: 500 };
  const quiet = { state: 'quiet', open: false, activeSinceMs: null };
  assert.equal(projectOpen(busy, true), true);
  assert.equal(projectOpen(quiet, { open: true, at: 1 }), true);
  assert.equal(projectOpen(busy, false), true); // an old boolean fold reads as set long ago
  assert.equal(projectOpen(busy, { open: false, at: 400 }), true);
  assert.equal(projectOpen(busy, { open: false, at: 600 }), false); // folded while active: the fold wins
  assert.equal(projectOpen({ ...busy, state: 'idle' }, { open: false, at: 400 }), false); // quiet again: folds back
  assert.equal(projectOpen({ ...busy, activeSinceMs: null }, { open: false, at: 400 }), false);
  assert.equal(projectOpen(busy, undefined), true);
  assert.equal(projectOpen(quiet, undefined), false);
});

test('groupEpics splits the week-old fold into quiet and done earlier', () => {
  const old = NOW - 8 * DAY;
  const r = groupEpics([
    { id: 'q', tasks: [{ id: '1', status: 'next', startedMs: old }] },
    { id: 'de', tasks: [{ id: '2', status: 'done', doneMs: old }] },
  ], NOW, new Set(), (t) => (t.status === 'done' ? 'done' : 'idle'));
  assert.deepEqual(r.quiet.map((e) => e.id), ['q']);
  assert.deepEqual(r.doneEarlier.map((e) => e.id), ['de']);
  assert.equal(r.shown.length, 0);
});

test('groupEpics sorts newest first, unknown activity last in source order', () => {
  const t = (ms) => [{ id: 'x', status: 'next', ...(ms ? { startedMs: ms } : {}) }];
  const r = groupEpics([{ id: 'u1', tasks: t() }, { id: 'old', tasks: t(NOW - 2 * DAY) }, { id: 'u2', tasks: t() }, { id: 'new', tasks: t(NOW - HOUR) }],
    NOW, new Set(), () => 'idle');
  assert.deepEqual(r.next.map((e) => e.id), ['new', 'old', 'u1', 'u2']);
});

test('groupEpics keeps before and dropped, and handles null', () => {
  const r = groupEpics([{ id: 'b', before: true, tasks: [] }, { id: 'x', dropped: true, tasks: [] }], NOW, new Set(), () => 'idle');
  assert.deepEqual([r.before.length, r.dropped.length], [1, 1]);
  assert.equal(groupEpics(null, NOW, null, () => 'idle').shown.length, 0);
});

test('foldOpen and projectFoldKeys', () => {
  assert.equal(foldOpen({ k: false }, 'k', true), false);
  assert.equal(foldOpen({}, 'k', true), true);
  assert.deepEqual(projectFoldKeys({ 'e|r1|a': true, 'g|r1|next': false, 'e|r2|a': true, 'p|r1': true }, 'r1').sort(), ['e|r1|a', 'g|r1|next']);
  assert.deepEqual(GROUPS.filter((g) => g.open).map((g) => g.id), ['running', 'waiting']);
});

test('tipText puts a cut-off label in full above the explanation', () => {
  assert.equal(tipText('Long title', true, 'Explains'), 'Long title\n\nExplains');
  assert.equal(tipText('Long title', false, 'Explains'), 'Explains');
  assert.equal(tipText('', true, 'Explains'), 'Explains');
  assert.equal(tipText('Long title', true, 'Long title. Not started.'), 'Long title. Not started.');
});

// Owner's report 2026-11-19: a finished task showed as the session's current work.
test('currentTask drops a linked task that is already done', () => {
  assert.deepEqual(currentTask({ linkedTask: { id: 't', title: 'T', status: 'doing' } }), { id: 't', title: 'T', status: 'doing' });
  assert.equal(currentTask({ linkedTask: { id: 't', title: 'T', status: 'done' } }), null);
  assert.equal(currentTask({ linkedTask: null }), null);
  assert.equal(currentTask(null), null);
});

// Owner's pick 2026-11-19: projects in the same state keep a fixed order by name, so busy projects don't swap.
test('panelOrder keeps cards A-Z by name, whatever their state or activity', () => {
  const p = (name, state, lastActivityMs) => ({ name, state, lastActivityMs });
  const out = panelOrder([p('zeta', 'working', 9), p('Alpha', 'working', 1), p('beta', 'stuck', 0), p('gamma', 'idle', 5), p('delta', 'waiting', 2)]);
  assert.deepEqual(out.map((x) => x.name), ['Alpha', 'beta', 'delta', 'gamma', 'zeta']);
  assert.deepEqual(panelOrder(null), []);
});

// Session spend (decision 34): always on the card; the "API-price equivalent" note only in the tooltip.
test('formatSpend', () => {
  assert.equal(formatSpend(0.04), '$0.04');
  assert.equal(formatSpend(1.236), '$1.24');
  assert.equal(formatSpend(312.4), '$312');
  assert.equal(formatSpend(1240), '$1,240');
  assert.equal(formatSpend(0.001), '<$0.01');
  assert.equal(formatSpend(0), '$0.00');
  assert.equal(formatSpend(null), '');
});

test('spendLine: cost and tokens, tokens only without a status line', () => {
  const a = spendLine({ costUsd: 1.24, tokensIn: 3_000_000, tokensOut: 100_000, source: 'statusline' });
  assert.equal(a.text, '$1.24 · 3.1M tokens');
  assert.match(a.tip, /API prices/);
  assert.match(a.tip, /3M in, 100k out/);
  const b = spendLine({ costUsd: null, tokensIn: 500, tokensOut: 20, source: 'transcript' });
  assert.equal(b.text, '520 tokens');
  assert.match(b.tip, /no cost/i);
  assert.equal(spendLine(null), null);
});

test('projectSpend: week total on the header, all-time in the tooltip', () => {
  const p = projectSpend({ weekUsd: 12.5, totalUsd: 80, sessions: 9 });
  assert.equal(p.text, '$12.50 this week');
  assert.match(p.tip, /\$80\.00 in all, across 9 sessions/);
  assert.match(p.tip, /API prices/);
  assert.equal(projectSpend({ weekUsd: 0, totalUsd: 0, sessions: 0 }), null);
  assert.doesNotMatch(p.tip, /tokens/);
  assert.equal(projectSpend(undefined), null);
});

test('detailText shows a spend tooltip', () => {
  assert.equal(detailText({ kind: 'spend', text: 'Estimated at API prices.' }), 'Estimated at API prices.');
  assert.equal(detailText({ kind: 'spend' }), '');
});

test('formatTokens shows three significant figures, moving up a unit at 1000', () => {
  const cases = [[820, '820'], [999, '999'], [999.6, '1k'], [1000, '1k'], [3400, '3.4k'], [51_234, '51.2k'], [523_000, '523k'],
    [999_499, '999k'], [999_999, '1M'], [1_200_000, '1.2M'], [12_340_000, '12.3M'], [523_000_000, '523M'],
    [1_010_200_000, '1.01B'], [1_040_000_000, '1.04B'], [2_340_000_000, '2.34B'], [12_300_000_000, '12.3B']];
  for (const [n, s] of cases) assert.equal(formatTokens(n), s, String(n));
  assert.equal(formatTokens(1_005_000_000), `${Number((1.005).toPrecision(3))}B`);
});

test('sessionWhat does not repeat the title as the session name', () => {
  const s = { sessionId: 'x', state: 'idle', name: 'Shop app', title: 'Shop app', lastWriteMs: NOW - MIN };
  assert.equal(sessionWhat(s).what, 'Your turn');
  assert.equal(sessionWhat({ ...s, title: 'Login bug' }).what, 'Shop app');
});

// Follow-ups (owner, 2026-11-19): work a live session has moved on from reads as left open.
test('taskLiveness: a live session that moved on to another epic leaves its old waits and work open', () => {
  const live = { sessionId: 'L', alive: true, linkedTask: { id: 'new#1', epicId: 'new' } };
  const byId = new Map([['L', live]]);
  const lv = (t, epicId) => taskLiveness({ id: 'x', sessionId: 'L', ...t }, byId, NOW, epicId);
  assert.equal(lv({ status: 'waiting', changedMs: NOW - 3 * DAY }, 'old'), 'stale');
  assert.equal(lv({ status: 'waiting', changedMs: NOW - HOUR }, 'old'), 'waiting');
  assert.equal(lv({ status: 'doing', changedMs: NOW - 3 * DAY }, 'old'), 'stale');
  // Same epic as its current task: still a real wait, however old.
  assert.equal(lv({ status: 'waiting', changedMs: NOW - 3 * DAY }, 'new'), 'waiting');
  // No epic given, or the session has no current task: as before.
  assert.equal(lv({ status: 'waiting', changedMs: NOW - 3 * DAY }), 'waiting');
  const idle = new Map([['L', { ...live, linkedTask: null }]]);
  assert.equal(taskLiveness({ id: 'x', sessionId: 'L', status: 'waiting', changedMs: NOW - 3 * DAY }, idle, NOW, 'old'), 'waiting');
});

test('groupEpics passes each task its epic id', () => {
  const seen = [];
  groupEpics([{ id: 'E', tasks: [{ id: 'a', status: 'next' }] }], NOW, new Set(), (t, epicId) => { seen.push(epicId); return 'other'; });
  assert.deepEqual(seen, ['E']);
});

test('a shortened about line does not end in a stray full stop', () => {
  const t = { id: 'a', status: 'next', about: 'x'.repeat(10) + '\u2026' };
  assert.equal(detailText({ kind: 'task', task: t }).split('\n')[0], 'xxxxxxxxxx\u2026');
});

// Review fixes (2026-11-19): plain words.
test('sessionWhat says what a tool is doing in Claude\'s own words', () => {
  const s = (tool) => ({ sessionId: 'x', state: 'working', pendingTool: { startedMs: NOW - MIN, ...tool } });
  assert.equal(sessionWhat(s({ name: 'Bash', command: 'sleep 20; gh run watch 1', description: "Watch the fix PR's CI run to the end" })).what,
    "Watch the fix PR's CI run to the end");
  assert.equal(sessionWhat(s({ name: 'Bash', command: 'sleep 20; gh run watch 1', description: null })).what, 'Running a command');
  assert.equal(sessionWhat(s({ name: 'Read', command: 'docs/x.md', description: null })).what, 'Running Read');
});

test('nowLines: one line per running tool, its description first', () => {
  const bash = { name: 'Bash', command: 'npm test\nmore', description: 'Run the tests' };
  const s = { state: 'working', pendingTools: [bash, { name: 'Read', command: 'docs/x.md', description: null }] };
  assert.deepEqual(nowLines(s), ['Run the tests', 'docs/x.md']);
  assert.deepEqual(nowLines({ state: 'working', pendingTools: [{ ...bash, description: null }] }), ['npm test']);
  assert.deepEqual(nowLines({ state: 'working', pendingTools: [{ name: 'Agent', description: null }] }), ['waiting on a helper']);
});

test('nowLines: nothing running means no line, never a "working" placeholder', () => {
  assert.deepEqual(nowLines({ state: 'working', pendingTools: [] }), []);
  assert.deepEqual(nowLines({ state: 'working' }), []);
  assert.deepEqual(nowLines({ state: 'idle', pendingTools: [] }), []);
  assert.deepEqual(nowLines(null), []);
});

test('nowLines: stuck and waiting say why, in one line', () => {
  assert.deepEqual(nowLines({ state: 'stuck', evidence: 'No output for 25 min' }), ['No output for 25 min']);
  assert.deepEqual(nowLines({ state: 'waiting', evidence: null }), ['waiting on you']);
});

test('the session hover carries the full command', () => {
  const s = { sessionId: 'abcd1234', state: 'working', subagents: [], tokens: {}, pendingTool: { name: 'Bash', command: 'gh run watch 1', description: 'Watch CI' } };
  assert.match(detailText({ kind: 'session', session: s, project: { name: 'p' }, now: NOW }), /Command: gh run watch 1/);
});

test('themeLabel names what Auto follows', () => {
  assert.equal(themeLabel('System', true), 'Auto (dark)');
  assert.equal(themeLabel('System', false), 'Auto (light)');
  assert.equal(themeLabel('Light', true), 'Light');
  assert.equal(themeLabel('Dark', false), 'Dark');
});

test('the epic hover leaves out the thread subject, and the group is Started, not active', () => {
  const e = { title: 'T', subject: 'Settings: plan ready (#79), 2 questions + approval', spentMin: 0, tasks: [{ status: 'done' }, { status: 'next' }] };
  assert.equal(detailText({ kind: 'epic', epic: e }), '1 of 2 tasks done.');
  assert.equal(GROUPS.find((g) => g.id === 'started').label, 'Started, not active');
});

test('watchedNote: a watched job says when it last printed', async () => {
  const { watchedNote, watchedHover } = await import('../../global/dashboard/page/render.mjs');
  const now = Date.parse('2026-11-20T10:00:00Z');
  assert.equal(watchedNote({ watch: { lastGrowthAt: now - 2 * 60000, quietMin: 15 } }, now), 'Watched · last output 2 min ago');
  assert.equal(watchedNote({ watch: { lastGrowthAt: now - 20000, quietMin: 15 } }, now), 'Watched · last output just now');
  assert.equal(watchedNote({ watch: null }, now), '');
  assert.equal(watchedNote(null, now), '');
  assert.equal(watchedHover({ watch: { lastGrowthAt: now, quietMin: 15 } }), 'The session is watching this job and will check on it after 15 minutes of silence.');
});

test('watchedAgo: the live "last output" text from its time alone', async () => {
  const { watchedAgo } = await import('../../global/dashboard/page/render.mjs');
  const now = Date.parse('2026-11-20T10:00:00Z');
  assert.equal(watchedAgo(now - 3 * 60000, now), 'Watched · last output 3 min ago');
  assert.equal(watchedAgo(now - 1000, now), 'Watched · last output just now');
});

test('compactSplit: active, gone and unreadable projects get squares, A-Z; the rest are quiet', () => {
  const p = (name, state, error = null) => ({ name, state, error });
  const { squares, quiet } = compactSplit([p('zeta', 'working'), p('Alpha', 'quiet'), p('beta', 'gone'),
    p('gamma', 'idle'), p('delta', 'waiting'), p('eps', 'quiet', 'Could not read this project'), p('Kappa', 'stuck')]);
  assert.deepEqual(squares.map((x) => x.name), ['beta', 'delta', 'eps', 'Kappa', 'zeta']);
  assert.deepEqual(quiet.map((x) => x.name), ['Alpha', 'gamma']);
  assert.deepEqual(compactSplit(null), { squares: [], quiet: [] });
});

test('busiestSession: the live session heard from last', () => {
  const s = (id, alive, lastWriteMs) => ({ sessionId: id, alive, lastWriteMs });
  assert.equal(busiestSession({ sessions: [s('a', true, 5), s('b', true, 9), s('c', false, 20)] }).sessionId, 'b');
  assert.equal(busiestSession({ sessions: [s('c', false, 20)] }), null);
  assert.equal(busiestSession({}), null);
});

test('squareSteps: a checklist shows every step; a plan folds done work and shows three ahead', () => {
  const t = (id, status) => ({ id, status });
  const wl = { source: 'worklog', tasks: [t('1', 'done'), t('2', 'doing'), t('3', 'next')] };
  assert.deepEqual(squareSteps(wl, '2'), { done: 0, items: wl.tasks, more: 0 });
  const plan = { source: 'plan', tasks: [t('1', 'done'), t('2', 'done'), t('3', 'doing'), t('4', 'next'),
    t('5', 'next'), t('6', 'next'), t('7', 'next'), t('8', 'next')] };
  const r = squareSteps(plan, '3');
  assert.equal(r.done, 2);
  assert.deepEqual(r.items.map((x) => x.id), ['3', '4', '5', '6']);
  assert.equal(r.more, 2);
  // No current task found: start at the first unfinished one.
  assert.deepEqual(squareSteps(plan, 'nope').items.map((x) => x.id), ['3', '4', '5', '6']);
  assert.deepEqual(squareSteps(null, '1'), { done: 0, items: [], more: 0 });
});

test('viewFromLocation: /compact picks the compact view; an unknown project in the hash opens nothing', () => {
  const ps = [{ name: 'anatomy to scale' }, { name: 'nimbus' }];
  assert.deepEqual(viewFromLocation('/compact', '#nimbus', ps), { view: 'compact', project: ps[1] });
  assert.deepEqual(viewFromLocation('/compact', '#anatomy%20to%20scale', ps), { view: 'compact', project: ps[0] });
  assert.deepEqual(viewFromLocation('/compact', '#gone-project', ps), { view: 'compact', project: null });
  assert.deepEqual(viewFromLocation('/compact', '#%E0%A4%A', ps), { view: 'compact', project: null });
  assert.deepEqual(viewFromLocation('/', '', ps), { view: 'full', project: null });
});
