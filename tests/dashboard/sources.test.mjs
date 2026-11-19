import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const SRC = resolve(here, '../../global/dashboard/lib/sources');
const FIXTURE = resolve(here, 'fixtures/bmad-status.json');

const ORIG = { c: process.env.CVR_DASH_CLAUDE_HOME, p: process.env.CVR_DASH_PLANNOTATOR_HOME };
after(() => {
  for (const [k, v] of [['CVR_DASH_CLAUDE_HOME', ORIG.c], ['CVR_DASH_PLANNOTATOR_HOME', ORIG.p]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

function setup() {
  const claude = mkdtempSync(join(tmpdir(), 'cvr-src-claude-'));
  const plan = mkdtempSync(join(tmpdir(), 'cvr-src-plannotator-'));
  const root = mkdtempSync(join(tmpdir(), 'cvr-src-proj-'));
  process.env.CVR_DASH_CLAUDE_HOME = claude;
  process.env.CVR_DASH_PLANNOTATOR_HOME = plan;
  return { claude, plan, root };
}
const mod = (name) => import(pathToFileURL(join(SRC, name)).href);

function writePlan(root, name, text) {
  const dir = join(root, 'docs', 'superpowers', 'plans');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text);
}

// ---- plans

test('plan headings become tasks with size', async () => {
  const { root } = setup();
  writePlan(root, 'checkout.md', [
    '# Checkout flow plan', '', 'Intro.', '',
    '### Task 1: Cart model [S]', '- [ ] a', '',
    '### Task 2: Totals [L]', '- [ ] b', '',
    '### Task 3: Receipts', 'no steps here', '',
  ].join('\n'));
  const { readPlans } = await mod('plans.mjs');
  const epics = readPlans(root);
  assert.equal(epics.length, 1);
  const e = epics[0];
  assert.equal(e.source, 'plan');
  assert.equal(e.title, 'Checkout flow plan');
  assert.equal(e.id, 'plan:docs/superpowers/plans/checkout.md');
  assert.ok(e.file.endsWith('checkout.md'));
  assert.deepEqual(e.tasks.map((t) => [t.n, t.title, t.size]), [
    [1, 'Cart model', 'S'], [2, 'Totals', 'L'], [3, 'Receipts', null],
  ]);
  assert.deepEqual(e.tasks.map((t) => t.status), ['next', 'next', 'next']);
  assert.equal(e.tasks[2].ticked, null);
});

test('ticked steps counted', async () => {
  const { root } = setup();
  writePlan(root, 'p.md', [
    '# P', '### Task 1: One [M]', '- [x] a', '- [X] b', '- [ ] c', '',
    '### Task 2: Two', '- [x] a', '- [x] b', '## Notes', '- [ ] not mine', '',
    '### Task 3: Three', '- [ ] a',
  ].join('\n'));
  const { readPlans } = await mod('plans.mjs');
  const t = readPlans(root)[0].tasks;
  assert.deepEqual(t[0].ticked, { done: 2, total: 3 });
  assert.deepEqual(t[1].ticked, { done: 2, total: 2 });
  assert.deepEqual(t[2].ticked, { done: 0, total: 1 });
  assert.deepEqual(t.map((x) => x.status), ['doing', 'done', 'next']);
});

test('plans tolerate a missing folder and a malformed plan', async () => {
  const { root } = setup();
  const { readPlans } = await mod('plans.mjs');
  assert.deepEqual(readPlans(root), []);
  writePlan(root, 'junk.md', '\u0000\u0001 no headings at all');
  const e = readPlans(root);
  assert.equal(e.length, 1);
  assert.deepEqual(e[0].tasks, []);
  assert.equal(e[0].title, 'junk');
});

// ---- bmad

test('bmad fixture maps states', async () => {
  setup();
  const { mapBmadStatus } = await mod('bmad.mjs');
  const epics = mapBmadStatus(JSON.parse(readFileSync(FIXTURE, 'utf8')));
  const cart = epics.find((e) => e.id === 'bmad:epic-cart');
  assert.equal(cart.source, 'bmad');
  assert.deepEqual(cart.tasks.map((t) => [t.n, t.status]), [[1, 'done'], [2, 'doing'], [3, 'doing'], [4, 'next']]);
  assert.equal(epics.find((e) => e.id === 'bmad:epic-pricing').tasks[0].status, 'next');
  assert.equal(epics.length, 3);
  assert.ok(!JSON.stringify(epics).includes('Gift wrap')); // dropped is hidden
});

test('bmad runs the script through an injected command and caches by mtime', async () => {
  const { root } = setup();
  mkdirSync(join(root, '_bmad'));
  const fake = join(root, 'fake.cjs'); // stands in for python: prints the fixture
  writeFileSync(fake, `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(FIXTURE)}, 'utf8'));`);
  const { readBmad } = await mod('bmad.mjs');
  const epics = await readBmad(root, { commands: [{ cmd: process.execPath, args: [fake] }] });
  assert.equal(epics.length, 3);
  // Second read comes from the cache: a broken command list changes nothing.
  const again = await readBmad(root, { commands: [{ cmd: 'no-such-program-xyz', args: [] }] });
  assert.deepEqual(again, epics);
});

test('bmad missing python returns []', async () => {
  const { claude, root } = setup();
  mkdirSync(join(root, '_bmad'));
  const { readBmad } = await mod('bmad.mjs');
  const r = await readBmad(root, { commands: [{ cmd: 'no-such-python-xyz', args: [] }, { cmd: 'no-such-uv-xyz', args: ['run'] }] });
  assert.deepEqual(r, []);
  const log = readFileSync(join(claude, 'dashboard', 'dashboard.log'), 'utf8');
  assert.match(log, /bmad/);
});

test('bmad without _bmad folder returns [] and runs nothing', async () => {
  const { root } = setup();
  const { readBmad } = await mod('bmad.mjs');
  assert.deepEqual(await readBmad(root, { commands: [{ cmd: 'no-such-python-xyz', args: [] }] }), []);
});

// ---- inbox

function env(v, seq, at, kind, id, record) { return JSON.stringify({ v, seq, at, kind, id, record }); }

function inboxProject(plan, root, key = 'web-shop-1') {
  const dir = join(plan, 'inbox', 'projects', key);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project.json'), env(1, 1, '2026-11-01T00:00:00Z', 'project', key, { id: key, root }));
  return dir;
}
const rec = (id, thread, session, steps) => ({
  id, project_id: 'p', thread_id: thread, agent: { kind: 'claude', host: 'h', session, name: 'a' }, steps,
});
const st = (step, status) => ({ step, status, note: null, at: '2026-11-01T00:00:00Z' });

test('inbox latest checklist per thread wins', async () => {
  const { plan, root } = setup();
  const dir = inboxProject(plan, root);
  writeFileSync(join(dir, 'messages.jsonl'), [
    env(1, 1, 'a', 'message', 'm1', { id: 'm1', thread_id: 't1', subject: 'Ship checkout', thread_name: null, created_at: 'a' }),
    env(1, 2, 'a', 'message', 'm2', { id: 'm2', thread_id: 't1', subject: 'Re: later', thread_name: null, created_at: 'a' }),
    env(1, 3, 'a', 'message', 'm3', { id: 'm3', thread_id: 't2', subject: 'x', thread_name: 'Named thread', created_at: 'a' }),
  ].join('\n') + '\n');
  writeFileSync(join(dir, 'steps.jsonl'), [
    env(1, 1, 'a', 'steps', 's1', rec('s1', 't1', 'sess-a', [st('Write', 'doing'), st('Test', 'todo')])),
    env(1, 2, 'a', 'steps', 's2', rec('s2', 't1', 'sess-a', [st('Write', 'done'), st('Test', 'waiting')])),
    env(1, 3, 'a', 'steps', 's3', rec('s3', 't2', 'sess-b', [st('Only', 'todo')])),
  ].join('\n') + '\n');
  const { readInbox } = await mod('inbox.mjs');
  const epics = readInbox(root);
  assert.equal(epics.length, 2);
  const t1 = epics.find((e) => e.id === 'inbox:t1:sess-a');
  assert.equal(t1.source, 'inbox');
  assert.equal(t1.title, 'Ship checkout');
  assert.deepEqual(t1.tasks.map((t) => [t.title, t.status, t.sessionId]), [['Write', 'done', 'sess-a'], ['Test', 'waiting', 'sess-a']]);
  assert.equal(epics.find((e) => e.id === 'inbox:t2:sess-b').title, 'Named thread');
});

test('inbox dropped steps hidden', async () => {
  const { plan, root } = setup();
  const dir = inboxProject(plan, root);
  writeFileSync(join(dir, 'steps.jsonl'), env(1, 1, 'a', 'steps', 's1', rec('s1', 't1', 'sess-a', [
    st('A', 'dropped'), st('B', 'todo'), st('C', 'doing'),
  ])) + '\n');
  const { readInbox } = await mod('inbox.mjs');
  const e = readInbox(root)[0];
  assert.equal(e.title, 'Checklist');
  assert.deepEqual(e.tasks.map((t) => [t.title, t.status]), [['B', 'next'], ['C', 'doing']]);
});

test('inbox ignores other projects and tolerates Plannotator absent', async () => {
  const { plan, root } = setup();
  const { readInbox } = await mod('inbox.mjs');
  assert.deepEqual(readInbox(root), []);
  const dir = inboxProject(plan, join(root, 'other'));
  writeFileSync(join(dir, 'steps.jsonl'), env(1, 1, 'a', 'steps', 's1', rec('s1', 't1', 'x', [st('A', 'todo')])) + '\n');
  assert.deepEqual(readInbox(root), []);
});
