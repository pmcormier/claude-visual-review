import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, utimesSync } from 'node:fs';
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
  assert.ok(Number.isFinite(e.mtimeMs)); // R25: the plan file's last change dates an untimed epic
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
  assert.equal(cart.title, 'Cart');
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

test('bmad cache lives 5 min while the signature is unchanged, then runs again', async () => {
  const { root } = setup();
  mkdirSync(join(root, '_bmad'));
  const fake = join(root, 'fake.cjs');
  writeFileSync(fake, `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(FIXTURE)}, 'utf8'));`);
  const { readBmad } = await mod('bmad.mjs');
  const t0 = Date.now();
  const ok = { cmd: process.execPath, args: [fake] };
  const broken = { cmd: 'no-such-program-xyz', args: [] };
  const first = await readBmad(root, { commands: [ok], now: () => t0 });
  assert.equal(first.length, 3);
  assert.deepEqual(await readBmad(root, { commands: [broken], now: () => t0 + 4 * 60000 }), first); // cached
  assert.deepEqual(await readBmad(root, { commands: [broken], now: () => t0 + 6 * 60000 }), []); // expired: ran
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
    env(1, 4, 'a', 'message', 'm4', { id: 'm4', thread_id: 't3', subject: 'Reply first', thread_name: null, created_at: 'a' }),
    env(1, 5, 'a', 'message', 'm5', { id: 't3', thread_id: 't3', subject: 'The root subject', thread_name: null, created_at: 'a' }),
  ].join('\n') + '\n');
  writeFileSync(join(dir, 'steps.jsonl'), [
    env(1, 1, 'a', 'steps', 's1', rec('s1', 't1', 'sess-a', [st('Write', 'doing'), st('Test', 'todo')])),
    env(1, 2, 'a', 'steps', 's2', rec('s2', 't1', 'sess-a', [st('Write', 'done'), st('Test', 'waiting')])),
    env(1, 3, 'a', 'steps', 's3', rec('s3', 't2', 'sess-b', [st('Only', 'todo')])),
    env(1, 4, 'a', 'steps', 's4', rec('s4', 't3', 'sess-c', [st('Z', 'todo')])),
    env(1, 5, 'a', 'steps', 's5', rec('s5', 't4', 'sess-d', [st('All gone', 'dropped')])),
  ].join('\n') + '\n');
  const { readInbox } = await mod('inbox.mjs');
  const epics = readInbox(root);
  assert.equal(epics.length, 3); // t4 has only hidden steps and is skipped
  assert.equal(epics.find((e) => e.id === 'inbox:t3:sess-c').title, 'The root subject');
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

// ---- fixes

test('plans ignore headings and checkboxes inside fenced code', async () => {
  const { root } = setup();
  writePlan(root, 'f.md', [
    '# F', '### Task 1: Real', '- [x] a', '```md', '### Task 2: Fake', '- [ ] fake box', '```', '- [ ] b', '',
    '~~~', '### Task 3: Also fake', '~~~',
  ].join('\n'));
  const { readPlans } = await mod('plans.mjs');
  const t = readPlans(root)[0].tasks;
  assert.equal(t.length, 1);
  assert.deepEqual(t[0].ticked, { done: 1, total: 2 });
});

test('bmad epic titles are humanized from the slug', async () => {
  const { mapBmadStatus } = await mod('bmad.mjs');
  const e = mapBmadStatus({ tickets: [{ epic: 'epic-platform-baseline', id: 1, state: 'done', ref: 'a', title: 'x' }] });
  assert.equal(e[0].title, 'Platform baseline');
  assert.equal(e[0].id, 'bmad:epic-platform-baseline');
});

function countingCommand(root, body) {
  const counter = join(root, 'count.txt');
  const script = join(root, 'count.cjs');
  writeFileSync(script, `require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'x'); ${body}`);
  const runs = () => { try { return readFileSync(counter, 'utf8').length; } catch { return 0; } };
  return { commands: [{ cmd: process.execPath, args: [script] }], runs };
}

test('bmad concurrent calls share one run', async () => {
  const { root } = setup();
  mkdirSync(join(root, '_bmad'));
  const { commands, runs } = countingCommand(root, `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(FIXTURE)}, 'utf8'));`);
  const { readBmad } = await mod('bmad.mjs');
  const [a, b] = await Promise.all([readBmad(root, { commands }), readBmad(root, { commands })]);
  assert.equal(runs(), 1);
  assert.equal(a.length, 3);
  assert.deepEqual(a, b);
});

test('bmad failure is cached and logged once; copies are safe to mutate', async () => {
  const { claude, root } = setup();
  mkdirSync(join(root, '_bmad'));
  const { commands, runs } = countingCommand(root, 'process.exit(1);');
  const { readBmad } = await mod('bmad.mjs');
  assert.deepEqual(await readBmad(root, { commands }), []);
  assert.deepEqual(await readBmad(root, { commands }), []);
  assert.equal(runs(), 1);
  const lines = readFileSync(join(claude, 'dashboard', 'dashboard.log'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  // a result mutated by a caller does not leak into later reads
  const ok = countingCommand(root, `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(FIXTURE)}, 'utf8'));`);
  const root2 = mkdtempSync(join(tmpdir(), 'cvr-src-proj-'));
  mkdirSync(join(root2, '_bmad'));
  const first = await readBmad(root2, { commands: ok.commands });
  first[0].title = 'MUTATED';
  first.length = 0;
  const again = await readBmad(root2, { commands: [{ cmd: 'no-such-program-xyz', args: [] }] });
  assert.equal(again.length, 3);
  assert.notEqual(again[0].title, 'MUTATED');
});

test('bmad cache is invalidated by a changed _bmad-output mtime', async () => {
  const { root } = setup();
  mkdirSync(join(root, '_bmad'));
  mkdirSync(join(root, '_bmad-output'));
  const { commands, runs } = countingCommand(root, `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(FIXTURE)}, 'utf8'));`);
  const { readBmad } = await mod('bmad.mjs');
  await readBmad(root, { commands });
  await readBmad(root, { commands });
  assert.equal(runs(), 1);
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(root, '_bmad-output'), later, later);
  await readBmad(root, { commands });
  assert.equal(runs(), 2);
});

test('inbox reads project.json as JSONL (latest envelope) and as a single object', async () => {
  const { plan, root } = setup();
  const dir = inboxProject(plan, join(root, 'old-place'));
  const base = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')).record;
  writeFileSync(join(dir, 'project.json'), [
    env(1, 1, 'a', 'project', 'p', { ...base, root: join(root, 'old-place') }),
    env(1, 9, 'b', 'project', 'p', { ...base, root, display_name: 'Web shop' }),
  ].join('\n') + '\n');
  writeFileSync(join(dir, 'steps.jsonl'), env(1, 1, 'a', 'steps', 's1', rec('s1', 't1', 'sess-a', [st('A', 'todo')])) + '\n');
  const { readInbox } = await mod('inbox.mjs');
  assert.equal(readInbox(root).length, 1);
  assert.equal(readInbox(join(root, 'old-place')).length, 0); // the superseded record no longer matches
  // single object, no trailing newline
  writeFileSync(join(dir, 'project.json'), env(1, 1, 'a', 'project', 'p', { ...base, root }));
  assert.equal(readInbox(root).length, 1);
});

// ---- plan Status line (dashboard catch-up)

const statusOf = async (root, name, lines) => {
  writePlan(root, name, lines.join('\n'));
  const { readPlans } = await mod('plans.mjs');
  return readPlans(root).find((e) => e.file.endsWith(name)).planStatus;
};

test('plan Status line: done and dropped are read, case-insensitive, with an optional note', async () => {
  const { root } = setup();
  assert.equal(await statusOf(root, 'a.md', ['# A', '', 'Status: done', '', '## Tasks', '### Task 1: x', '- [ ] a']), 'done');
  assert.equal(await statusOf(root, 'b.md', ['# B', '**Status:** Dropped — 2026-11-19', '### Task 1: x']), 'dropped');
  assert.equal(await statusOf(root, 'c.md', ['# C', '> Status: done - shipped', '### Task 1: x']), 'done');
});

test('plan Status look-alikes are ignored', async () => {
  const { root } = setup();
  assert.equal(await statusOf(root, 'd.md', ['# D', 'Status: approved', '### Task 1: x']), null);
  assert.equal(await statusOf(root, 'e.md', ['# E', '```', 'Status: done', '```', '### Task 1: x']), null);
  assert.equal(await statusOf(root, 'f.md', ['# F', '## Global Constraints', 'Status: done', '### Task 1: x']), null);
});

test('plan epics carry birthtimeMs', async () => {
  const { root } = setup();
  writePlan(root, 'g.md', '# G\n### Task 1: x\n');
  const { readPlans } = await mod('plans.mjs');
  const b = readPlans(root)[0].birthtimeMs;
  assert.equal(typeof b, 'number');
  assert.ok(b > 0);
});

test('plan Status open is read, and loose look-alikes are not', async () => {
  const { root } = setup();
  assert.equal(await statusOf(root, 'h.md', ['# H', 'Status: open — catch-up 2026-11-19', '### Task 1: x']), 'open');
  assert.equal(await statusOf(root, 'i.md', ['# I', 'Status: done (Tasks 1-3), Task 4 open', '### Task 1: x']), null);
  assert.equal(await statusOf(root, 'j.md', ['# J', 'Statusdone', '### Task 1: x']), null);
  assert.equal(await statusOf(root, 'k.md', ['# K', 'Status: done.', '### Task 1: x']), 'done');
});
