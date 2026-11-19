// Pure render helpers of the dashboard page (global/dashboard/page/render.mjs). No DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDuration, lifePath, detailText, foldEpics, effortLeft, usageView, triage, agoWords, shortId, STATE_LABEL,
  sizeSummary, filterToken,
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
  assert.match(text, /^Fixture migration\. /);
  assert.match(text, /Session 34d4 is on it, 1h 52m so far\./);
  assert.match(text, /Looks stuck: pytest running 52 min · 0% CPU · no output for 31 min\./);
});

test('detailText templates for the other kinds', () => {
  const next = { id: 'a', title: 'PDF layout', status: 'next', spentMin: 0 };
  assert.equal(detailText({ kind: 'task', task: next }), 'PDF layout. Not started.');
  const done = { id: 'b', title: 'CSV writer', status: 'done', spentMin: 50 };
  assert.equal(detailText({ kind: 'task', task: done }), 'CSV writer. Done in 50m.');
  assert.equal(detailText({ kind: 'task', task: { ...done, spentMin: 0 } }), 'CSV writer. Done.');
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
  assert.match(st, /51k tokens in and 3\.4k out so far in this session\./);
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
  assert.deepEqual(foldEpics(null, NOW, null), { shown: [], earlier: [] });
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
