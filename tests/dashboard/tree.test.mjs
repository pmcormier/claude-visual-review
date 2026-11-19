import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const LIB = resolve(here, '../../global/dashboard/lib');
const mod = (name) => import(pathToFileURL(join(LIB, name)).href);

const ORIG = process.env.CVR_DASH_CLAUDE_HOME;
after(() => {
  if (ORIG === undefined) delete process.env.CVR_DASH_CLAUDE_HOME; else process.env.CVR_DASH_CLAUDE_HOME = ORIG;
});

const MIN = 60000;
const T0 = Date.parse('2026-11-10T10:00:00Z');
const TH = { idleGap: 15 };

function setup() {
  const claude = mkdtempSync(join(tmpdir(), 'cvr-tree-claude-'));
  process.env.CVR_DASH_CLAUDE_HOME = claude;
  const root = mkdtempSync(join(tmpdir(), 'cvr-tree-web-shop-'));
  return { claude, root };
}

function writePlan(root, name, tasks) {
  const dir = join(root, 'docs', 'superpowers', 'plans');
  mkdirSync(dir, { recursive: true });
  const lines = [`# ${name} plan`, ''];
  for (const t of tasks) {
    lines.push(`### Task ${t.n}: ${t.title}`, '');
    for (const s of t.steps || []) lines.push(`- [${s ? 'x' : ' '}] step`);
    lines.push('');
  }
  writeFileSync(join(dir, name), lines.join('\n'));
  return join(dir, name);
}

function git(root, args, ms) {
  const iso = new Date(ms ?? T0).toISOString();
  return execFileSync('git', ['-C', root, '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
  });
}

function initRepo(root) {
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Test User']);
  git(root, ['config', 'user.email', 'tester']);
}

function commit(root, message, ms, file = 'notes.txt') {
  const p = join(root, file);
  writeFileSync(p, (existsSync(p) ? readFileSync(p, 'utf8') : '') + message + '\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '--no-verify', '-m', message], ms);
}

const empty = () => ({ worklog: [], plans: [], bmad: [], inbox: [], commits: [], sessions: [], events: [] });
const taskOf = (tree, epicId, n) => tree.epics.find((e) => e.id === epicId)?.tasks.find((t) => t.n === n);
const planId = (name) => `plan:docs/superpowers/plans/${name}`;

// ---- brief tests

test("'Task 1 done' with two plans each having Task 1 ticks neither", async () => {
  const { root } = setup();
  const { readPlans } = await mod('sources/plans.mjs');
  const { readCommits } = await mod('git.mjs');
  const { buildTree } = await mod('tree.mjs');
  initRepo(root);
  writePlan(root, 'checkout.md', [{ n: 1, title: 'Cart', steps: [0] }]);
  writePlan(root, 'billing-api.md', [{ n: 1, title: 'Invoices', steps: [0] }]);
  commit(root, 'Plans', T0);
  commit(root, 'Task 1 done', T0 + 10 * MIN);
  const commits = await readCommits(root, T0 - 60 * MIN);
  assert.equal(commits.length, 2);
  const tree = buildTree(root, { ...empty(), plans: readPlans(root), commits }, TH);
  assert.equal(taskOf(tree, planId('checkout.md'), 1).status, 'next');
  assert.equal(taskOf(tree, planId('billing-api.md'), 1).status, 'next');
});

test('commit naming plan stem ticks that task', async () => {
  const { root } = setup();
  const { readPlans } = await mod('sources/plans.mjs');
  const { readCommits } = await mod('git.mjs');
  const { buildTree } = await mod('tree.mjs');
  initRepo(root);
  writePlan(root, 'checkout.md', [{ n: 1, title: 'Cart', steps: [0] }, { n: 2, title: 'Pay', steps: [0] }]);
  writePlan(root, 'billing-api.md', [{ n: 1, title: 'Invoices', steps: [0] }, { n: 2, title: 'Refunds', steps: [0] }]);
  commit(root, 'Plans', T0);
  commit(root, 'checkout: Task 2 done\n\nMulti-line body\nwith Task 1 of nothing else', T0 + 10 * MIN);
  const commits = await readCommits(root, T0 - 60 * MIN);
  const tree = buildTree(root, { ...empty(), plans: readPlans(root), commits }, TH);
  assert.equal(taskOf(tree, planId('checkout.md'), 2).status, 'done');
  assert.equal(taskOf(tree, planId('checkout.md'), 1).status, 'done', 'body names Task 1 too, plan still named');
  assert.equal(taskOf(tree, planId('billing-api.md'), 2).status, 'next');
});

test('only one unfinished plan makes Task N unambiguous', async () => {
  const { root } = setup();
  const { readPlans } = await mod('sources/plans.mjs');
  const { buildTree } = await mod('tree.mjs');
  writePlan(root, 'checkout.md', [{ n: 1, title: 'Cart', steps: [1] }]); // finished
  writePlan(root, 'billing-api.md', [{ n: 1, title: 'Invoices', steps: [0] }, { n: 2, title: 'Refunds', steps: [0] }]);
  const commits = [{ sha: 'a1', ms: T0, message: 'Task 2: refunds', files: ['src/refunds.js'] }];
  const tree = buildTree(root, { ...empty(), plans: readPlans(root), commits }, TH);
  assert.equal(taskOf(tree, planId('billing-api.md'), 2).status, 'done');
  assert.equal(taskOf(tree, planId('billing-api.md'), 1).status, 'next');
  // "Task 22" is not "Task 2"
  const tree2 = buildTree(root, { ...empty(), plans: readPlans(root), commits: [{ ...commits[0], message: 'Task 22' }] }, TH);
  assert.equal(taskOf(tree2, planId('billing-api.md'), 2).status, 'next');
});

test('work log overrides plan status', async () => {
  const { root } = setup();
  const { readPlans } = await mod('sources/plans.mjs');
  const { buildTree } = await mod('tree.mjs');
  const file = writePlan(root, 'checkout.md', [{ n: 1, title: 'Cart', steps: [0] }, { n: 2, title: 'Pay', steps: [0] }]);
  const worklog = [
    { id: 'wl-1', source: 'worklog', title: 'Cart work', file, tasks: [
      { id: 'wl-1-1', n: 1, title: 'Cart work', status: 'done', size: null, sessionId: 's-old', startedMs: T0, doneMs: T0 + 20 * MIN, ticked: null }] },
    { id: 'wl-2', source: 'worklog', title: 'Pay work', file: 'docs/superpowers/plans/checkout.md', tasks: [
      { id: 'wl-2-1', n: 2, title: 'Pay work', status: 'doing', size: null, sessionId: 's-2', startedMs: T0 + 30 * MIN, doneMs: null, ticked: null }] },
    { id: 'wl-3', source: 'worklog', title: 'Billing API', file: null, tasks: [
      { id: 'wl-3-1', n: null, title: 'Billing API', status: 'doing', size: null, sessionId: 's-3', startedMs: T0, doneMs: null, ticked: null }] },
  ];
  const bmad = [{ id: 'bmad:billing-api', source: 'bmad', title: '  billing api ', file: null, tasks: [] }];
  const tree = buildTree(root, { ...empty(), plans: readPlans(root), worklog, bmad }, TH);
  assert.equal(taskOf(tree, planId('checkout.md'), 1).status, 'done');
  assert.equal(taskOf(tree, planId('checkout.md'), 2).status, 'doing');
  assert.equal(taskOf(tree, planId('checkout.md'), 2).sessionId, 's-2');
  const ids = tree.epics.map((e) => e.id);
  assert.ok(!ids.includes('wl-1') && !ids.includes('wl-2'), 'merged work-log epics are not listed');
  assert.ok(ids.includes('wl-3'));
  assert.ok(!ids.includes('bmad:billing-api'), 'work log wins on equal titles');
});

test('effort hours null under three finished tasks', async () => {
  const { root } = setup();
  const { buildTree } = await mod('tree.mjs');
  const mk = (i, status, spent) => ({
    id: `t${i}`, n: null, title: `Step ${i}`, status, size: null, sessionId: null,
    startedMs: spent ? T0 : null, doneMs: spent ? T0 + spent * MIN : null, ticked: null,
  });
  const epic = (tasks) => [{ id: 'inbox:x', source: 'inbox', title: 'Checklist', file: null, tasks }];
  let tree = buildTree(root, { ...empty(), inbox: epic([mk(1, 'done', 10), mk(2, 'done', 12), mk(3, 'next'), mk(4, 'doing')]) }, TH);
  assert.equal(tree.left.count, 2);
  assert.equal(tree.left.hours, null);
  tree = buildTree(root, { ...empty(), inbox: epic([mk(1, 'done', 6), mk(2, 'done', 12), mk(3, 'done', 15), mk(4, 'next'), mk(5, 'waiting')]) }, TH);
  assert.equal(tree.left.count, 2);
  assert.equal(tree.left.hours, 0.4); // median 12 min x 2
  assert.equal(tree.spentMin, 33);
});

test('idle gaps excluded from time', async () => {
  const { root } = setup();
  const { buildTree } = await mod('tree.mjs');
  const worklog = [{ id: 'wl-1', source: 'worklog', title: 'Checkout', file: null, tasks: [
    { id: 'wl-1-1', n: null, title: 'Checkout', status: 'done', size: null, sessionId: 's-1', startedMs: T0, doneMs: T0 + 60 * MIN, ticked: null }] }];
  const at = (m) => new Date(T0 + m * MIN).toISOString();
  const events = [5, 10, 50].map((m) => ({ session: 's-1', file: 'src/x.js', at: at(m) }));
  events.push({ session: 's-other', file: 'src/y.js', at: at(30) }); // another session: not this task's activity
  const tree = buildTree(root, { ...empty(), worklog, events }, TH);
  // [0,5,10] = 10 min, gap 10->50 is 40 min (idle), [50,60] = 10 min
  assert.equal(taskOf(tree, 'wl-1', null).spentMin, 20);
  assert.equal(tree.spentMin, 20);
});

// ---- extra tests

test('link order: work log beats Inbox beats events beats taskRefs', async () => {
  const { root } = setup();
  const { readPlans } = await mod('sources/plans.mjs');
  const { buildTree } = await mod('tree.mjs');
  const a = writePlan(root, 'checkout.md', [{ n: 1, title: 'Cart', steps: [0] }, { n: 2, title: 'Pay', steps: [0] }]);
  writePlan(root, 'billing-api.md', [{ n: 1, title: 'Invoices', steps: [0] }, { n: 2, title: 'Refunds', steps: [0] }]);
  const now = T0 + 120 * MIN;
  const sess = (id, extra = {}) => ({ sessionId: id, status: 'busy', planRefs: [], taskRefs: [], minutes: new Array(60).fill(0), lastWriteMs: now, ...extra });
  const wlTask = { id: 'wl-1-1', n: null, title: 'Docs pass', status: 'doing', size: null, sessionId: 's-1', startedMs: now - 10 * MIN, doneMs: null, ticked: null };
  const worklog = [{ id: 'wl-1', source: 'worklog', title: 'Docs pass', file: null, tasks: [wlTask] }];
  const inboxTask = (sid) => ({ id: `inbox:t:${sid}#1`, n: null, title: 'Step', status: 'doing', size: null, sessionId: sid, startedMs: now - 5 * MIN, doneMs: null, ticked: null });
  const inbox = [
    { id: 'inbox:t:s-1', source: 'inbox', title: 'Thread one', file: null, tasks: [inboxTask('s-1')] },
    { id: 'inbox:t:s-2', source: 'inbox', title: 'Thread two', file: null, tasks: [inboxTask('s-2')] },
  ];
  const events = [{ session: 's-1', file: a, at: now - 3 * MIN }, { session: 's-2', file: a, at: now - 3 * MIN }, { session: 's-3', file: a, at: now - 3 * MIN }];
  const refs = [{ n: 2, ms: now - 2 * MIN }];
  const sessions = [sess('s-1', { taskRefs: refs }), sess('s-2', { taskRefs: refs }), sess('s-3', { taskRefs: refs }), sess('s-4', { taskRefs: refs })];
  const tree = buildTree(root, { worklog, plans: readPlans(root), bmad: [], inbox, commits: [], sessions, events, now }, TH);
  const links = tree.links;
  assert.equal(links['s-1'], 'wl-1-1', 'work log first');
  assert.equal(links['s-2'], 'inbox:t:s-2#1', 'Inbox second');
  assert.equal(links['s-3'], `${planId('checkout.md')}#2`, 'events plan + latest taskRef third');
  assert.equal(links['s-4'] ?? null, null, 'taskRef alone with two unfinished plans stays unlinked');
  const pay = taskOf(tree, planId('checkout.md'), 2);
  assert.equal(pay.status, 'doing');
  assert.equal(pay.sessionId, 's-3');
  assert.equal(taskOf(tree, planId('billing-api.md'), 2).status, 'next');
});

test('commit naming a dated plan stem ticks that task', async () => {
  const { root } = setup();
  const { readPlans } = await mod('sources/plans.mjs');
  const { buildTree } = await mod('tree.mjs');
  writePlan(root, '2026-11-01-checkout-flow.md', [{ n: 3, title: 'Pay', steps: [0] }]);
  writePlan(root, '2026-11-02-billing-api.md', [{ n: 3, title: 'Refunds', steps: [0] }]);
  writePlan(root, '2026-11-03-checkout.md', [{ n: 3, title: 'Other', steps: [0] }]);
  const commits = [
    { sha: 'a', ms: T0, message: 'checkout-flow Task 3', files: [] },
    { sha: 'b', ms: T0, message: '2026-11-02-billing-api: Task 3', files: [] },
  ];
  const tree = buildTree(root, { ...empty(), plans: readPlans(root), commits }, TH);
  assert.equal(taskOf(tree, planId('2026-11-01-checkout-flow.md'), 3).status, 'done');
  assert.equal(taskOf(tree, planId('2026-11-02-billing-api.md'), 3).status, 'done');
  assert.equal(taskOf(tree, planId('2026-11-03-checkout.md'), 3).status, 'next', '"checkout" inside "checkout-flow" is not a mention');
});

test('commit by a session linked to the plan ticks that task', async () => {
  const { root } = setup();
  const { readPlans } = await mod('sources/plans.mjs');
  const { buildTree } = await mod('tree.mjs');
  const a = writePlan(root, 'checkout.md', [{ n: 1, title: 'Cart', steps: [0] }]);
  writePlan(root, 'billing-api.md', [{ n: 1, title: 'Invoices', steps: [0] }]);
  const events = [{ session: 's-1', file: a, at: T0 }, { session: 's-1', file: 'src/cart.js', at: T0 + 20 * MIN }];
  const commits = [{ sha: 'a', ms: T0 + 25 * MIN, message: 'Task 1 done', files: [] }];
  const tree = buildTree(root, { ...empty(), plans: readPlans(root), commits, events }, TH);
  assert.equal(taskOf(tree, planId('checkout.md'), 1).status, 'done');
  assert.equal(taskOf(tree, planId('billing-api.md'), 1).status, 'next');
  // a commit long after that session went quiet is not attributed to it
  const late = buildTree(root, { ...empty(), plans: readPlans(root), commits: [{ ...commits[0], ms: T0 + 300 * MIN }], events }, TH);
  assert.equal(taskOf(late, planId('checkout.md'), 1).status, 'next');
});

test('a non-repo root returns [] and logs once', async () => {
  const { claude, root } = setup();
  const { readCommits } = await mod('git.mjs');
  assert.deepEqual(await readCommits(root, 0), []);
  assert.deepEqual(await readCommits(root, 0), []);
  assert.deepEqual(await readCommits(join(root, 'missing'), 0), []);
  const log = readFileSync(join(claude, 'dashboard', 'dashboard.log'), 'utf8').trim().split('\n');
  assert.equal(log.filter((l) => l.includes('git:')).length, 2, 'one line per root');
});

test('buildTree tolerates missing inputs', async () => {
  const { root } = setup();
  const { buildTree } = await mod('tree.mjs');
  const tree = buildTree(root, {}, TH);
  assert.deepEqual(tree.epics, []);
  assert.deepEqual(tree.left, { count: 0, hours: null });
  assert.equal(tree.spentMin, 0);
  assert.doesNotThrow(() => buildTree(root, { plans: [null, { tasks: null }], events: [null, 5], sessions: [null], commits: [{}] }, TH));
});

test('a commit older than the plan does not tick it, and inputs are not mutated', async () => {
  const { root } = setup();
  const { readPlans } = await mod('sources/plans.mjs');
  const { buildTree } = await mod('tree.mjs');
  writePlan(root, 'billing-api.md', [{ n: 1, title: 'Invoices', steps: [0] }]);
  const plans = readPlans(root);
  const before = JSON.stringify(plans);
  const commits = [
    { sha: 'old', ms: T0, message: 'Task 1 of an earlier plan', files: ['src/a.js'] },
    { sha: 'add', ms: T0 + 60 * MIN, message: 'Add plan', files: ['docs/superpowers/plans/billing-api.md'] },
  ];
  const tree = buildTree(root, { ...empty(), plans, commits }, TH);
  assert.equal(taskOf(tree, planId('billing-api.md'), 1).status, 'next');
  assert.equal(JSON.stringify(plans), before);
  const later = buildTree(root, { ...empty(), plans, commits: [...commits, { sha: 'new', ms: T0 + 90 * MIN, message: 'Task 1', files: [] }] }, TH);
  assert.equal(taskOf(later, planId('billing-api.md'), 1).status, 'done');
});

test('two unfinished plans keep Task N ambiguous even when only one has it', async () => {
  const { root } = setup();
  const { readPlans } = await mod('sources/plans.mjs');
  const { buildTree } = await mod('tree.mjs');
  writePlan(root, 'checkout.md', [{ n: 1, title: 'Cart', steps: [0] }]);
  writePlan(root, 'billing-api.md', [{ n: 1, title: 'Invoices', steps: [0] }, { n: 2, title: 'Refunds', steps: [0] }]);
  const commits = [{ sha: 'a', ms: T0, message: 'Task 2', files: [] }];
  const tree = buildTree(root, { ...empty(), plans: readPlans(root), commits }, TH);
  assert.equal(taskOf(tree, planId('billing-api.md'), 2).status, 'next');
});
