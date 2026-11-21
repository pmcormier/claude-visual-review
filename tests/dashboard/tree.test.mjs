import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs';
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
  commit(root, 'checkout: Task 2 done\n\nMulti-line body\nTask 1 is next', T0 + 10 * MIN);
  const commits = await readCommits(root, T0 - 60 * MIN);
  const tree = buildTree(root, { ...empty(), plans: readPlans(root), commits }, TH);
  assert.equal(taskOf(tree, planId('checkout.md'), 2).status, 'done');
  assert.equal(taskOf(tree, planId('checkout.md'), 1).status, 'next', 'Task N in the body does not count');
  assert.equal(taskOf(tree, planId('billing-api.md'), 2).status, 'next');
});

test('only one unfinished plan makes Task N unambiguous', async () => {
  const { root } = setup();
  const { readPlans } = await mod('sources/plans.mjs');
  const { buildTree } = await mod('tree.mjs');
  // R16: "only one unfinished plan" now means the repo has a single plan file, added at or before the commit.
  writePlan(root, 'billing-api.md', [{ n: 1, title: 'Invoices', steps: [0] }, { n: 2, title: 'Refunds', steps: [0] }]);
  const commits = [
    { sha: 'p', ms: T0 - 60 * MIN, message: 'Plan', added: ['docs/superpowers/plans/billing-api.md'] },
    { sha: 'f', ms: T0 - 30 * MIN, message: 'Tweak plan', files: ['docs/superpowers/plans/billing-api.md'] },
    { sha: 'a1', ms: T0, message: 'Task 2: refunds', files: ['src/refunds.js'] },
  ];
  const tree = buildTree(root, { ...empty(), plans: readPlans(root), commits }, TH);
  assert.equal(taskOf(tree, planId('billing-api.md'), 2).status, 'done');
  assert.equal(taskOf(tree, planId('billing-api.md'), 1).status, 'next');
  // "Task 22" is not "Task 2"
  const tree2 = buildTree(root, { ...empty(), plans: readPlans(root), commits: [...commits.slice(0, 2), { ...commits[2], message: 'Task 22' }] }, TH);
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
  const added = { sha: 'p', ms: T0 - 60 * MIN, message: 'Plans', added: ['docs/superpowers/plans/checkout.md', 'docs/superpowers/plans/billing-api.md'] };
  const commits = [added, { sha: 'a', ms: T0 + 25 * MIN, message: 'Task 1 done', files: [] }];
  const tree = buildTree(root, { ...empty(), plans: readPlans(root), commits, events }, TH);
  assert.equal(taskOf(tree, planId('checkout.md'), 1).status, 'done');
  assert.equal(taskOf(tree, planId('billing-api.md'), 1).status, 'next');
  // a commit long after that session went quiet is not attributed to it
  const late = buildTree(root, { ...empty(), plans: readPlans(root), commits: [added, { ...commits[1], ms: T0 + 300 * MIN }], events }, TH);
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
    { sha: 'add', ms: T0 + 60 * MIN, message: 'Add plan', added: ['docs/superpowers/plans/billing-api.md'] },
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

// ---- fix round 1 (R15)

const PLANS = 'docs/superpowers/plans/';

// R16: with two or more plan files, an unnamed `Task N` never ticks through clause c.
async function twoPlans() {
  const { root } = setup();
  const { readPlans } = await mod('sources/plans.mjs');
  const { buildTree } = await mod('tree.mjs');
  writePlan(root, 'checkout.md', [{ n: 1, title: 'Cart', steps: [1] }, { n: 2, title: 'Pay', steps: [1] }]); // finished
  writePlan(root, 'billing-api.md', [{ n: 1, title: 'Invoices', steps: [0] }, { n: 2, title: 'Refunds', steps: [0] }]);
  const run = (commits) => buildTree(root, { ...empty(), plans: readPlans(root), commits }, TH);
  return { run, st: (tree) => [1, 2].map((n) => taskOf(tree, planId('billing-api.md'), n).status).join(' ') };
}

test('two plans (one finished) with an unnamed Task N tick nothing (R16a)', async () => {
  const { run, st } = await twoPlans();
  assert.equal(st(run([
    { sha: 'p', ms: T0, message: 'Plans', added: [PLANS + 'billing-api.md', PLANS + 'checkout.md'] },
    { sha: 't', ms: T0 + 30 * MIN, message: 'Tick checkout', files: [PLANS + 'checkout.md'] },
    { sha: 'c', ms: T0 + 40 * MIN, message: 'Task 2', files: [] }])), 'next next');
});

test('Q1: a truncated window does not make an older plan look newborn (R16b)', async () => {
  const { run, st } = await twoPlans();
  // checkout's add is outside the window; only a later tick of it is seen
  assert.equal(st(run([
    { sha: 'b', ms: T0 + 1 * MIN, message: 'Add billing-api plan', added: [PLANS + 'billing-api.md'] },
    { sha: 'w', ms: T0 + 3 * MIN, message: 'Task 2: work', files: ['src/a.js'] },
    { sha: 't', ms: T0 + 5 * MIN, message: 'Tick checkout', files: [PLANS + 'checkout.md'] }])), 'next next');
});

test('Q3: a fix-up commit after a plan finished does not tick another plan (R16a)', async () => {
  const { run, st } = await twoPlans();
  assert.equal(st(run([
    { sha: 'p', ms: T0, message: 'Plans', added: [PLANS + 'billing-api.md', PLANS + 'checkout.md'] },
    { sha: 'a', ms: T0 + 5 * MIN, message: 'Task 1', files: [PLANS + 'checkout.md'] },
    { sha: 'b', ms: T0 + 9 * MIN, message: 'Task 2', files: [PLANS + 'checkout.md'] },
    { sha: 'f', ms: T0 + 20 * MIN, message: 'Task 2: review fix', files: ['src/a.js'] }])), 'next next');
});

test('partly committed ticks do not make a plan look finished early (R16a)', async () => {
  const { run, st } = await twoPlans();
  // checkout's Task 1 ticks were committed, its Task 2 ticks are only in the working copy
  assert.equal(st(run([
    { sha: 'p', ms: T0, message: 'Plans', added: [PLANS + 'billing-api.md', PLANS + 'checkout.md'] },
    { sha: 'a', ms: T0 + 5 * MIN, message: 'Task 1', files: [PLANS + 'checkout.md'] },
    { sha: 'b', ms: T0 + 9 * MIN, message: 'Task 2', files: ['src/pay.js'] }])), 'next next');
});

test('clause a still ticks in a multi-plan repo, and a modify is not an add (R16)', async () => {
  const { run, st } = await twoPlans();
  assert.equal(st(run([{ sha: 'n', ms: T0, message: 'billing-api: Task 2 done', files: [] }])), 'next done');
  // single plan, but only modified (never added) in the window: unknown add, no tick
  const { root } = setup();
  const { readPlans } = await mod('sources/plans.mjs');
  const { buildTree } = await mod('tree.mjs');
  writePlan(root, 'billing-api.md', [{ n: 1, title: 'Invoices', steps: [0] }]);
  const tree = buildTree(root, { ...empty(), plans: readPlans(root), commits: [
    { sha: 'm', ms: T0, message: 'Tweak plan', files: [PLANS + 'billing-api.md'] },
    { sha: 'c', ms: T0 + MIN, message: 'Task 1', files: [] }] }, TH);
  assert.equal(taskOf(tree, planId('billing-api.md'), 1).status, 'next');
});

test('readCommits reports real adds separately from other changes', async () => {
  const { root } = setup();
  const { readCommits } = await mod('git.mjs');
  initRepo(root);
  writePlan(root, 'billing-api.md', [{ n: 1, title: 'Invoices', steps: [0] }]);
  commit(root, 'Add plan', T0);
  writePlan(root, 'billing-api.md', [{ n: 1, title: 'Invoices', steps: [1] }]);
  commit(root, 'Tick plan', T0 + MIN);
  const got = await readCommits(root, T0 - MIN);
  const byMsg = Object.fromEntries(got.map((c) => [c.message, c]));
  assert.deepEqual(byMsg['Add plan'].added.sort(), [PLANS + 'billing-api.md', 'notes.txt']);
  assert.deepEqual(byMsg['Tick plan'].added, []);
  assert.deepEqual(byMsg['Tick plan'].files.sort(), [PLANS + 'billing-api.md', 'notes.txt']);
});

test('an uncommitted plan is never ticked through b or c and blocks c (R15b)', async () => {
  const { root } = setup();
  const { readPlans } = await mod('sources/plans.mjs');
  const { buildTree } = await mod('tree.mjs');
  const fresh = writePlan(root, 'billing-api.md', [{ n: 1, title: 'Invoices', steps: [0] }]);
  const task1 = { sha: 'a', ms: T0, message: 'Task 1', files: [] };
  let tree = buildTree(root, { ...empty(), plans: readPlans(root), commits: [task1] }, TH);
  assert.equal(taskOf(tree, planId('billing-api.md'), 1).status, 'next', 'c: only plan, but uncommitted');
  const events = [{ session: 's-1', file: fresh, at: T0 - 5 * MIN }];
  tree = buildTree(root, { ...empty(), plans: readPlans(root), events, commits: [task1] }, TH);
  assert.equal(taskOf(tree, planId('billing-api.md'), 1).status, 'next', 'b: linked, but uncommitted');
  tree = buildTree(root, { ...empty(), plans: readPlans(root), commits: [{ ...task1, message: 'billing-api Task 1' }] }, TH);
  assert.equal(taskOf(tree, planId('billing-api.md'), 1).status, 'done', 'a: naming the plan still ticks');
  writePlan(root, 'checkout.md', [{ n: 1, title: 'Cart', steps: [0] }]);
  tree = buildTree(root, { ...empty(), plans: readPlans(root), commits: [
    { sha: 'p', ms: T0 - 60 * MIN, message: 'Plan', added: [PLANS + 'checkout.md'] }, task1] }, TH);
  assert.equal(taskOf(tree, planId('checkout.md'), 1).status, 'next', 'the uncommitted plan makes c ambiguous');
});

test("another project's plan of the same name is not a touch of ours (R15c)", async () => {
  const { root } = setup();
  const { readPlans } = await mod('sources/plans.mjs');
  const { buildTree } = await mod('tree.mjs');
  writePlan(root, 'checkout.md', [{ n: 1, title: 'Cart', steps: [0] }]);
  writePlan(root, 'billing-api.md', [{ n: 1, title: 'Invoices', steps: [0] }]);
  const other = join(root, '..', 'other-shop', 'docs', 'superpowers', 'plans', 'checkout.md');
  const now = T0 + 60 * MIN;
  const events = [{ session: 's-1', file: other, at: now - 5 * MIN }];
  const commits = [
    { sha: 'p', ms: T0, message: 'Plans', added: [PLANS + 'checkout.md', PLANS + 'billing-api.md'] },
    { sha: 'a', ms: now - 2 * MIN, message: 'Task 1', files: [] },
  ];
  const sessions = [{ sessionId: 's-2', planRefs: [{ file: other, ms: now - 4 * MIN }], taskRefs: [{ n: 1, ms: now - 3 * MIN }], minutes: [], lastWriteMs: now }];
  const tree = buildTree(root, { ...empty(), plans: readPlans(root), events, commits, sessions, now }, TH);
  assert.equal(taskOf(tree, planId('checkout.md'), 1).status, 'next');
  assert.equal(tree.links['s-2'] ?? null, null);
  // the same plan in our project (different case on Windows) does match
  const ours = join(root, 'docs', 'superpowers', 'plans', 'checkout.md');
  const mine = buildTree(root, { ...empty(), plans: readPlans(root), commits,
    events: [{ session: 's-1', file: process.platform === 'win32' ? ours.toUpperCase() : ours, at: now - 5 * MIN }] }, TH);
  assert.equal(taskOf(mine, planId('checkout.md'), 1).status, 'done');
});

test('Task N and the plan name count only on the subject line (R15d)', async () => {
  const { root } = setup();
  const { readPlans } = await mod('sources/plans.mjs');
  const { buildTree } = await mod('tree.mjs');
  writePlan(root, 'checkout.md', [{ n: 1, title: 'Cart', steps: [0] }, { n: 2, title: 'Pay', steps: [0] }]);
  writePlan(root, 'billing-api.md', [{ n: 2, title: 'Refunds', steps: [0] }]);
  const commits = [
    { sha: 'a', ms: T0, message: 'checkout: Task 1 done\n\nTask 2 is next', files: [] },
    { sha: 'b', ms: T0, message: 'Task 2 done\r\n\r\nPart of billing-api', files: [] },
  ];
  const tree = buildTree(root, { ...empty(), plans: readPlans(root), commits }, TH);
  assert.equal(taskOf(tree, planId('checkout.md'), 1).status, 'done');
  assert.equal(taskOf(tree, planId('checkout.md'), 2).status, 'next');
  assert.equal(taskOf(tree, planId('billing-api.md'), 2).status, 'next');
});

test('a session idle at the commit does not attribute it, and waiting work-log tasks link', async () => {
  const { root } = setup();
  const { readPlans } = await mod('sources/plans.mjs');
  const { buildTree } = await mod('tree.mjs');
  const a = writePlan(root, 'checkout.md', [{ n: 1, title: 'Cart', steps: [0] }]);
  writePlan(root, 'billing-api.md', [{ n: 1, title: 'Invoices', steps: [0] }]);
  // active T0..T0+5, idle, active again at T0+100: a commit at T0+60 falls in the idle gap
  const events = [{ session: 's-1', file: a, at: T0 }, { session: 's-1', file: 'x', at: T0 + 5 * MIN }, { session: 's-1', file: 'x', at: T0 + 100 * MIN }];
  const commits = [
    { sha: 'p', ms: T0 - 60 * MIN, message: 'Plans', added: [PLANS + 'checkout.md', PLANS + 'billing-api.md'] },
    { sha: 'c', ms: T0 + 60 * MIN, message: 'Task 1', files: [] },
  ];
  const tree = buildTree(root, { ...empty(), plans: readPlans(root), events, commits }, TH);
  assert.equal(taskOf(tree, planId('checkout.md'), 1).status, 'next');
  const worklog = [{ id: 'wl-1', source: 'worklog', title: 'Ask owner', file: null, tasks: [
    { id: 'wl-1-1', n: null, title: 'Ask owner', status: 'waiting', size: null, sessionId: 's-9', startedMs: T0, doneMs: null, ticked: null }] }];
  const linked = buildTree(root, { ...empty(), worklog, sessions: [{ sessionId: 's-9' }], now: T0 + 10 * MIN }, TH);
  assert.equal(linked.links['s-9'], 'wl-1-1');
  assert.equal(taskOf(linked, 'wl-1', null).status, 'waiting');
});

test('git child env drops repo-location variables', async () => {
  const { root } = setup();
  const { readCommits } = await mod('git.mjs');
  initRepo(root);
  commit(root, 'Task 1 one', T0);
  const elsewhere = mkdtempSync(join(tmpdir(), 'cvr-tree-billing-api-'));
  initRepo(elsewhere);
  commit(elsewhere, 'other repo', T0);
  commit(elsewhere, 'other repo again', T0 + MIN);
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = join(elsewhere, '.git');
  try {
    const got = await readCommits(root, T0 - MIN);
    assert.deepEqual(got.map((c) => c.message), ['Task 1 one']);
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved;
  }
});

test('git child env drops object-store and config-injection variables (R16d)', async () => {
  const { root } = setup();
  const { readCommits } = await mod('git.mjs');
  initRepo(root);
  commit(root, 'Task 1 one', T0);
  const empty = mkdtempSync(join(tmpdir(), 'cvr-tree-objects-'));
  const vars = {
    GIT_OBJECT_DIRECTORY: empty, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'nonexistent-helper',
  };
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    const got = await readCommits(root, T0 - MIN);
    assert.deepEqual(got.map((c) => c.message), ['Task 1 one']);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

// A plan deleted and added again dates from its newest add: a Task 2 commit made for the old file must not
// tick the new plan.
test('a re-added plan is not ticked by a commit made before the re-add', async () => {
  const { matchCommits } = await mod('tree-match.mjs');
  const root = resolve('/proj');
  const P = 'docs/superpowers/plans/checkout.md';
  const plan = { id: 'p', file: join(root, P), tasks: [{ id: 'p#2', n: 2, status: 'next' }] };
  const commits = [
    { ms: T0, message: 'Add checkout plan', files: [P], added: [P] },
    { ms: T0 + 5 * MIN, message: 'Task 2: old work', files: ['src/x'], added: [] },
    { ms: T0 + 10 * MIN, message: 'Remove old plan', files: [P], added: [] },
    { ms: T0 + 20 * MIN, message: 'New checkout plan', files: [P], added: [P] },
  ];
  assert.deepEqual([...matchCommits(root, [plan], commits, new Map(), 15 * MIN)], []);
  const later = [...commits, { ms: T0 + 30 * MIN, message: 'Task 2: new work', files: ['src/y'], added: [] }];
  assert.deepEqual([...matchCommits(root, [plan], later, new Map(), 15 * MIN)], [['p#2', T0 + 30 * MIN]]);
});

test('plan epics keep the plan file mtime through the merge', async () => {
  const { buildTree } = await mod('tree.mjs');
  const root = resolve('/proj');
  const plans = [{ id: 'plan:a', source: 'plan', title: 'A', file: join(root, 'docs/superpowers/plans/a.md'), mtimeMs: T0, tasks: [{ id: 'plan:a#1', n: 1, title: 'x', status: 'next' }] }];
  const t = buildTree(root, { ...empty(), plans }, TH);
  assert.equal(t.epics[0].mtimeMs, T0);
});

test('a work-log task left doing by a session that is no longer live reads next', async () => {
  const { buildTree } = await mod('tree.mjs');
  const worklog = [{
    id: 'wl:1', source: 'worklog', title: 'Fix login', file: null, tasks: [
      { id: 'wl:1#1', n: 1, title: 'gone one', status: 'doing', sessionId: 'dead', startedMs: T0 },
      { id: 'wl:1#2', n: 2, title: 'live one', status: 'doing', sessionId: 'alive', startedMs: T0 },
      { id: 'wl:1#3', n: 3, title: 'no session', status: 'doing', sessionId: null, startedMs: T0 },
    ],
  }];
  const t = buildTree('/proj', { ...empty(), worklog, liveSessionIds: new Set(['alive']) }, TH);
  assert.deepEqual(t.epics[0].tasks.map((x) => x.status), ['next', 'doing', 'doing']);
  assert.equal(t.epics[0].title, 'Fix login'); // the work log's own epic stays listed
  // Without liveness the work log is taken as written.
  const raw = buildTree('/proj', { ...empty(), worklog }, TH);
  assert.deepEqual(raw.epics[0].tasks.map((x) => x.status), ['doing', 'doing', 'doing']);
});

test('readCommits keeps an unchanged-signature entry for 5 minutes (R27)', async () => {
  const { root } = setup();
  const { readCommits } = await mod('git.mjs');
  initRepo(root);
  commit(root, 'Task 1 one', T0);
  const dir = join(root, '.git');
  const ref = join(dir, ...readFileSync(join(dir, 'HEAD'), 'utf8').match(/^ref:\s*(\S+)/)[1].split('/'));
  const files = [join(dir, 'HEAD'), ref, join(dir, 'refs', 'heads')];
  const pin = () => files.forEach((f) => utimesSync(f, 1_700_000_000, 1_700_000_000)); // whole seconds: exact in the signature
  pin();
  let t = 1_000_000;
  const now = () => t;
  assert.equal((await readCommits(root, 0, { now })).length, 1);
  commit(root, 'Task 2 two', T0 + MIN);
  pin(); // signature looks unchanged
  t += 4 * 60_000;
  assert.equal((await readCommits(root, 0, { now })).length, 1, 'cached at 4 min');
  t += 61_000;
  assert.equal((await readCommits(root, 0, { now })).length, 2, 'refreshed after 5 min');
});

// ---- dashboard catch-up: Status line and "before the dashboard"

const DAY = 1440 * MIN;
const INSTALL = T0 + 5 * DAY;
const NOW = INSTALL + 2 * DAY;
const REL = 'docs/superpowers/plans/old.md';

function oldPlan(root, over = {}) {
  const file = join(root, ...REL.split('/'));
  const id = `plan:${REL}`;
  return {
    id, source: 'plan', title: 'Old plan', file, mtimeMs: T0, birthtimeMs: T0, planStatus: null,
    tasks: [1, 2].map((n) => ({ id: `${id}#${n}`, n, title: `t${n}`, status: 'next', ticked: { done: 0, total: 2 } })),
    ...over,
  };
}
const addCommit = (ms = T0) => ({ ms, message: 'add plan', files: [REL], added: [REL] });
const empty2 = () => ({ worklog: [], bmad: [], inbox: [], events: [], sessions: [], now: NOW });
const epicOf = (tree) => tree.epics.find((e) => e.id === `plan:${REL}`);

test('Status done makes every task done', async () => {
  const { root } = setup();
  const { buildTree } = await mod('tree.mjs');
  const tree = buildTree(root, { ...empty2(), plans: [oldPlan(root, { planStatus: 'done' })], commits: [addCommit()], installedAtMs: null }, TH);
  assert.ok(epicOf(tree).tasks.every((t) => t.status === 'done'));
  assert.equal(tree.left.count, 0);
});

test('Status dropped leaves work left', async () => {
  const { root } = setup();
  const { buildTree } = await mod('tree.mjs');
  const tree = buildTree(root, { ...empty2(), plans: [oldPlan(root, { planStatus: 'dropped' })], commits: [addCommit()], installedAtMs: null }, TH);
  assert.equal(epicOf(tree).dropped, true);
  assert.equal(tree.left.count, 0);
});

test('a plan added before the install with no ticks and no later change is before the dashboard', async () => {
  const { root } = setup();
  const { buildTree } = await mod('tree.mjs');
  const tree = buildTree(root, { ...empty2(), plans: [oldPlan(root)], commits: [addCommit()], installedAtMs: INSTALL }, TH);
  assert.equal(epicOf(tree).before, true);
  assert.equal(tree.left.count, 0);
});

test('before the dashboard is undone by progress', async () => {
  const { root } = setup();
  const { buildTree } = await mod('tree.mjs');
  const run = (inputs) => epicOf(buildTree(root, { ...empty2(), commits: [addCommit()], installedAtMs: INSTALL, ...inputs }, TH)).before;
  // (a) some boxes ticked, not all
  const part = oldPlan(root);
  part.tasks[0] = { ...part.tasks[0], status: 'doing', ticked: { done: 1, total: 2 } };
  assert.equal(run({ plans: [part] }), false, 'part-ticked');
  // (b) a work-log task from it started after the install
  const wl = [{ id: 'wl-1', title: 'old work', file: join(root, ...REL.split('/')), tasks: [{ id: 'wl-1-1', n: 1, title: 't1', status: 'doing', startedMs: INSTALL + DAY }] }];
  assert.equal(run({ plans: [oldPlan(root)], worklog: wl }), false, 'work log');
  // (c) a live session linked to one of its tasks
  const s = [{ sessionId: 's-1', planRefs: [{ file: join(root, ...REL.split('/')), ms: NOW - MIN }], taskRefs: [{ n: 2, ms: NOW - MIN }], minutes: [], lastWriteMs: NOW - MIN }];
  assert.equal(run({ plans: [oldPlan(root)], sessions: s }), false, 'linked session');
  // (d) a commit touching it after the install
  assert.equal(run({ plans: [oldPlan(root)], commits: [addCommit(), { ms: INSTALL + DAY, message: 'edit plan', files: [REL], added: [] }] }), false, 'later commit');
});

test('a plan added after the install is never before', async () => {
  const { root } = setup();
  const { buildTree } = await mod('tree.mjs');
  const p = oldPlan(root, { mtimeMs: INSTALL + DAY, birthtimeMs: INSTALL + DAY });
  const tree = buildTree(root, { ...empty2(), plans: [p], commits: [addCommit(INSTALL + DAY)], installedAtMs: INSTALL }, TH);
  assert.equal(epicOf(tree).before, false);
  assert.equal(tree.left.count, 2);
});

test('no install date folds nothing', async () => {
  const { root } = setup();
  const { buildTree } = await mod('tree.mjs');
  const tree = buildTree(root, { ...empty2(), plans: [oldPlan(root)], commits: [addCommit()], installedAtMs: null }, TH);
  assert.equal(epicOf(tree).before, false);
  assert.equal(tree.left.count, 2);
});

test('an untracked plan dates from its creation time', async () => {
  const { root } = setup();
  const { buildTree } = await mod('tree.mjs');
  const a = buildTree(root, { ...empty2(), plans: [oldPlan(root)], commits: [], installedAtMs: INSTALL }, TH);
  assert.equal(epicOf(a).before, true);
  const b = buildTree(root, { ...empty2(), plans: [oldPlan(root, { birthtimeMs: null })], commits: [], installedAtMs: INSTALL }, TH);
  assert.equal(epicOf(b).before, false);
});

// Final review: after a catch-up, done plans read as finished long ago and open plans as current work.
test('a caught-up done plan dates from before the install, not from the catch-up commit', async () => {
  const { root } = setup();
  const { buildTree } = await mod('tree.mjs');
  const catchup = { ms: INSTALL + DAY, message: 'catch-up', files: [REL], added: [] };
  const tree = buildTree(root, { ...empty2(), plans: [oldPlan(root, { planStatus: 'done', mtimeMs: INSTALL + DAY })], commits: [addCommit(), catchup], installedAtMs: INSTALL }, TH);
  assert.ok(epicOf(tree).tasks.every((t) => t.status === 'done' && t.doneMs === T0));
});

test('a plan marked Status open is current work, never before', async () => {
  const { root } = setup();
  const { buildTree } = await mod('tree.mjs');
  const tree = buildTree(root, { ...empty2(), plans: [oldPlan(root, { planStatus: 'open' })], commits: [addCommit()], installedAtMs: INSTALL }, TH);
  assert.equal(epicOf(tree).before, false);
  assert.equal(tree.left.count, 2);
});

// ---- about lines, change times, left-open tasks (dashboard-clarity Task 3)

test('a work-log task left doing by a closed session is flagged leftOpen', async () => {
  const { buildTree } = await mod('tree.mjs');
  const worklog = [{
    id: 'wl:1', source: 'worklog', title: 'Fix login', file: null, tasks: [
      { id: 'wl:1#1', n: 1, title: 'gone one', status: 'doing', sessionId: 'dead', startedMs: T0 },
      { id: 'wl:1#2', n: 2, title: 'live one', status: 'doing', sessionId: 'alive', startedMs: T0 },
      { id: 'wl:1#3', n: 3, title: 'no session', status: 'doing', sessionId: null, startedMs: T0 },
    ],
  }];
  const t = buildTree('/proj', { ...empty(), worklog, liveSessionIds: new Set(['alive']) }, TH);
  assert.deepEqual(t.epics[0].tasks.map((x) => x.leftOpen), [true, false, false]);
});

function aboutPlan(root) {
  const file = writePlan(root, 'p.md', [{ n: 1, title: 'One' }, { n: 2, title: 'Two' }]);
  return {
    id: 'plan:p', source: 'plan', title: 'P plan', file, mtimeMs: T0 - 1000, tasks: [
      { id: 'plan:p#1', n: 1, title: 'One', status: 'next', about: 'plan line' },
      { id: 'plan:p#2', n: 2, title: 'Two', status: 'next', about: 'plan two' },
    ],
  };
}

test('a plan task takes the work log about over the plan own, with its change time and left-open flag', async () => {
  const { root } = setup();
  const { buildTree } = await mod('tree.mjs');
  const worklog = [{
    id: 'wl:1', source: 'worklog', title: 'One', file: 'docs/superpowers/plans/p.md', tasks: [
      { id: 'wl:1#1', n: 1, title: 'One', status: 'doing', sessionId: 'dead', startedMs: T0, about: 'log line', changedMs: T0 + 5 },
    ],
  }];
  const t = buildTree(root, { ...empty(), plans: [aboutPlan(root)], worklog, liveSessionIds: new Set() }, TH);
  const [one, two] = t.epics[0].tasks;
  assert.equal(one.about, 'log line');
  assert.equal(one.changedMs, T0 + 5);
  assert.equal(one.leftOpen, true);
  assert.equal(two.about, 'plan two');
  assert.equal(two.changedMs, T0 - 1000); // a plan task without its own time takes the plan's mtime
  assert.equal(two.leftOpen, false);
});

test('an Inbox step takes its about from the same session work-log mirror', async () => {
  const { buildTree } = await mod('tree.mjs');
  const inbox = [
    { id: 'inbox:t1:s1', source: 'inbox', title: 'Thread', subject: 'Ship the cart', tasks: [
      { id: 'i#1', title: ' Build It ', status: 'doing', sessionId: 's1' },
      { id: 'i#2', title: 'Other', status: 'next', sessionId: 's1' },
    ] },
    { id: 'inbox:t2:s3', source: 'inbox', title: 'Bare', tasks: [{ id: 'j#1', title: 'Build it', status: 'next', sessionId: 's3' }] },
  ];
  const worklog = [
    { id: 'wl:0', source: 'worklog', title: 'Elsewhere', tasks: [{ id: 'w0', title: 'build it', status: 'next', sessionId: 's2', about: 'wrong session' }] },
    { id: 'wl:1', source: 'worklog', title: 'Cart', tasks: [{ id: 'w1', title: 'build it', status: 'next', sessionId: 's1', about: 'why' }] },
    { id: 'wl:2', source: 'worklog', title: 'Cart again', tasks: [{ id: 'w2', title: 'BUILD IT', status: 'next', sessionId: 's1', about: 'later' }] },
  ];
  const t = buildTree('/proj', { ...empty(), inbox, worklog }, TH);
  const a = t.epics.find((e) => e.id === 'inbox:t1:s1').tasks;
  assert.equal(a[0].about, 'why');
  assert.equal(a[1].about, null); // no mirror line: no description (the subject is on the epic's hover)
  assert.equal(t.epics.find((e) => e.id === 'inbox:t2:s3').tasks[0].about, null);
});

test('a leftOpen flag from the work log reaches the tree, and the model epic id reaches linked tasks', async () => {
  const { buildTree } = await mod('tree.mjs');
  const worklog = [{ id: 'wl:1', source: 'worklog', title: 'Old', file: null, tasks: [
    { id: 'wl:1#1', n: 1, title: 'left', status: 'next', sessionId: 's', leftOpen: true },
  ] }];
  const t = buildTree('/proj', { ...empty(), worklog }, TH);
  assert.equal(t.epics[0].tasks[0].leftOpen, true);
});

test('plainTitle: no code marks, snake_case, "Implementation Plan" tails or ISO dates in titles', async () => {
  const { plainTitle } = await import('../../global/dashboard/lib/tree.mjs');
  assert.equal(plainTitle('`groupEpics` and `foldOpen` in render.mjs'), 'groupEpics and foldOpen in render.mjs');
  assert.equal(plainTitle('Rename and reorder: update_hierarchy'), 'Rename and reorder: update hierarchy');
  assert.equal(plainTitle('Dashboard compact view Implementation Plan'), 'Dashboard compact view');
  assert.equal(plainTitle('Live dashboard — Implementation Plan'), 'Live dashboard');
  assert.equal(plainTitle('Overnight 2026-11-16'), 'Overnight 16 Nov');
  assert.equal(plainTitle('Fix the sign-in timeout (#56)'), 'Fix the sign-in timeout (#56)');
  assert.equal(plainTitle('Logging Implementation Plan (refreshed 2 Nov)'), 'Logging (refreshed 2 Nov)');
  assert.equal(plainTitle('Implementation Plan'), 'Implementation Plan'); // never empty
});
