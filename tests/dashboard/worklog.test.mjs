import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, appendFileSync, copyFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const NOTE = resolve(here, '../../global/dashboard/note.mjs');

const ORIG_HOME = process.env.CVR_DASH_CLAUDE_HOME;
after(() => {
  if (ORIG_HOME === undefined) delete process.env.CVR_DASH_CLAUDE_HOME; else process.env.CVR_DASH_CLAUDE_HOME = ORIG_HOME;
});

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'cvr-wl-home-'));
  const proj = mkdtempSync(join(tmpdir(), 'cvr-wl-proj-'));
  mkdirSync(join(proj, '.git'));
  return { home, proj };
}

function note(env, args, session = 's1') {
  const e = { ...process.env, CVR_DASH_CLAUDE_HOME: env.home };
  if (session === null) delete e.CLAUDE_CODE_SESSION_ID; else e.CLAUDE_CODE_SESSION_ID = session;
  return spawnSync(process.execPath, [NOTE, ...args], { cwd: env.proj, env: e, encoding: 'utf8' });
}

async function lib(env) {
  process.env.CVR_DASH_CLAUDE_HOME = env.home;
  return import('../../global/dashboard/lib/worklog.mjs');
}
async function read(env) {
  return (await lib(env)).readWorklog(env.proj);
}

test('start then steps then done yields a done epic with three done tasks', async () => {
  const env = setup();
  note(env, ['start', 'Build web-shop cart', '--plan', 'plan.md', '--task', '4', '--steps', 'model|api|ui']);
  note(env, ['step', '1', 'doing']);
  note(env, ['step', '1', 'done']);
  note(env, ['done']);
  const epics = await read(env);
  assert.equal(epics.length, 1);
  const e = epics[0];
  assert.equal(e.source, 'worklog');
  assert.equal(e.title, 'Build web-shop cart');
  assert.equal(e.file, 'plan.md');
  assert.deepEqual(e.tasks.map((t) => t.title), ['model', 'api', 'ui']);
  assert.ok(e.tasks.every((t) => t.status === 'done' && t.doneMs > 0 && t.sessionId === 's1'));
  assert.equal(e.tasks[0].n, 4);
  assert.equal(e.tasks[1].n, null);
});

test('step status changes keep latest', async () => {
  const env = setup();
  note(env, ['start', 'Fix billing-api', '--steps', 'a|b']);
  note(env, ['step', '2', 'doing']);
  note(env, ['step', '2', 'waiting']);
  note(env, ['step', '1', 'done']);
  note(env, ['step', '1', 'todo']);
  const [e] = await read(env);
  assert.equal(e.tasks[0].status, 'next');
  assert.equal(e.tasks[1].status, 'waiting');
  assert.ok(e.tasks[1].startedMs > 0);
});

test('missing session id still writes with session null', async () => {
  const env = setup();
  const r = note(env, ['start', 'Solo job'], null);
  assert.equal(r.status, 0);
  const [e] = await read(env);
  assert.equal(e.tasks[0].sessionId, null);
  note(env, ['done'], null);
  assert.equal((await read(env))[0].tasks[0].status, 'done');
});

test('cli never exits non-zero', () => {
  const env = setup();
  for (const args of [[], ['bogus'], ['start'], ['step'], ['step', 'x', 'y'], ['done'], ['drop']]) {
    const r = note(env, args);
    assert.equal(r.status, 0, args.join(' '));
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
  }
  // A dash home that cannot be created: its parent is a file.
  const blocker = join(env.home, 'blocker');
  appendFileSync(blocker, 'x');
  const r = spawnSync(process.execPath, [NOTE, 'start', 'x'], {
    cwd: env.proj, env: { ...process.env, CVR_DASH_CLAUDE_HOME: blocker }, encoding: 'utf8',
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, '');
});

test('errors go to note.log and never into the project', () => {
  const env = setup();
  note(env, ['frobnicate']);
  assert.ok(existsSync(join(env.home, 'dashboard', 'note.log')));
  assert.deepEqual(readdirSync(env.proj), ['.git']);
});

test('steps out of range are ignored', async () => {
  const env = setup();
  note(env, ['start', 'T', '--steps', 'a|b']);
  note(env, ['step', '3', 'done']);
  note(env, ['step', '0', 'done']);
  const [e] = await read(env);
  assert.deepEqual(e.tasks.map((t) => t.status), ['next', 'next']);
});

test('drop hides the epic; dropped step hides the task', async () => {
  const env = setup();
  note(env, ['start', 'Keep', '--steps', 'a|b|c']);
  note(env, ['step', '2', 'dropped']);
  note(env, ['start', 'Gone'], 's2'); // another session, so "Keep" stays open
  note(env, ['drop', 'not needed'], 's2');
  const epics = await read(env);
  assert.equal(epics.length, 1);
  assert.deepEqual(epics[0].tasks.map((t) => t.title), ['a', 'c']);
});

test('two sessions epics do not interfere', async () => {
  const env = setup();
  note(env, ['start', 'One', '--steps', 'a'], 'sA');
  note(env, ['start', 'Two', '--steps', 'b'], 'sB');
  note(env, ['step', '1', 'done'], 'sA');
  note(env, ['done'], 'sB');
  const epics = await read(env);
  const one = epics.find((e) => e.title === 'One');
  const two = epics.find((e) => e.title === 'Two');
  assert.equal(one.tasks[0].status, 'done');
  assert.equal(one.tasks[0].sessionId, 'sA');
  assert.equal(two.tasks[0].status, 'done');
  assert.equal(two.tasks[0].sessionId, 'sB');
});

test('start without steps is a single doing task that done closes', async () => {
  const env = setup();
  note(env, ['start', 'Refactor']);
  let [e] = await read(env);
  assert.equal(e.tasks.length, 1);
  assert.equal(e.tasks[0].title, 'Refactor');
  assert.equal(e.tasks[0].status, 'doing');
  assert.ok(e.tasks[0].startedMs > 0);
  note(env, ['done']);
  [e] = await read(env);
  assert.equal(e.tasks[0].status, 'done');
});

test('reader ignores unknown verbs, other versions and broken lines', async () => {
  const env = setup();
  const { worklogPath, readWorklog } = await lib(env);
  assert.deepEqual(readWorklog(env.proj), []);
  note(env, ['start', 'X']);
  appendFileSync(worklogPath(env.proj),
    '{"v":2,"verb":"done","session":"s1"}\n{"v":1,"verb":"zap"}\nnot json\n{"v":1,"verb":"done"');
  const [e] = await read(env);
  assert.equal(e.tasks[0].status, 'doing');
});

test('a second start closes the first as superseded: doing and waiting are left open, later records reach only the new one', async () => {
  const env = setup();
  note(env, ['start', 'A', '--steps', 'a|b']);
  note(env, ['step', '1', 'doing']);
  note(env, ['step', '2', 'waiting']);
  note(env, ['start', 'B', '--steps', 'c']);
  note(env, ['done']);
  const epics = await read(env);
  assert.equal(epics.length, 2);
  // A closed entry waits on no one: its waiting step is left open, like its begun one.
  assert.deepEqual(epics[0].tasks.map((t) => t.status), ['next', 'next']);
  assert.deepEqual(epics[0].tasks.map((t) => t.leftOpen), [true, true]);
  assert.equal(epics[0].tasks[0].startedMs, null);
  assert.equal(epics[1].tasks[0].status, 'done');
});

test('a null-session epic does not collide with a session-bearing one', async () => {
  const env = setup();
  note(env, ['start', 'Anon', '--steps', 'a'], null);
  note(env, ['start', 'Named', '--steps', 'b'], 'sA');
  note(env, ['done'], null);
  const epics = await read(env);
  assert.equal(epics.find((e) => e.title === 'Anon').tasks[0].status, 'done');
  assert.equal(epics.find((e) => e.title === 'Named').tasks[0].status, 'next');
});

test('step after done is ignored', async () => {
  const env = setup();
  note(env, ['start', 'A', '--steps', 'a']);
  note(env, ['done']);
  note(env, ['step', '1', 'todo']);
  assert.equal((await read(env))[0].tasks[0].status, 'done');
});

test('a dropped step is restored by todo', async () => {
  const env = setup();
  note(env, ['start', 'A', '--steps', 'a|b']);
  note(env, ['step', '2', 'dropped']);
  assert.equal((await read(env))[0].tasks.length, 1);
  note(env, ['step', '2', 'todo']);
  assert.deepEqual((await read(env))[0].tasks.map((t) => t.status), ['next', 'next']);
});

test('--steps skips empty segments', async () => {
  const env = setup();
  note(env, ['start', 'A', '--steps', 'a||  |b|']);
  assert.deepEqual((await read(env))[0].tasks.map((t) => t.title), ['a', 'b']);
});

test('--task must be an integer of at least 1, otherwise ignored and logged', async () => {
  const env = setup();
  for (const bad of ['0', '-2', 'x', '1.5', '']) note(env, ['start', 'T' + bad, '--task', bad]);
  const epics = await read(env);
  assert.ok(epics.every((e) => e.tasks[0].n === null));
  assert.ok(readFileSync(join(env.home, 'dashboard', 'note.log'), 'utf8').includes('ignored --task'));
});

test('a partial install (note.mjs without lib/) still exits 0 and prints nothing', () => {
  const env = setup();
  const lone = mkdtempSync(join(tmpdir(), 'cvr-wl-lone-'));
  copyFileSync(NOTE, join(lone, 'note.mjs'));
  const r = spawnSync(process.execPath, [join(lone, 'note.mjs'), 'start', 'x'], {
    cwd: env.proj, env: { ...process.env, CVR_DASH_CLAUDE_HOME: env.home }, encoding: 'utf8',
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
  assert.ok(existsSync(join(env.home, 'dashboard', 'note.log')));
});

// ---- about lines and change times (dashboard-clarity Task 1) ----

async function writeLog(env, records) {
  const { worklogPath } = await lib(env);
  const file = worklogPath(env.proj);
  mkdirSync(join(file, '..'), { recursive: true });
  for (const r of records) appendFileSync(file, JSON.stringify({ v: 1, session: 's1', ...r }) + '\n');
}

test('note start --about writes about', async () => {
  const env = setup();
  note(env, ['start', 'Fix login', '--about', '  Users get logged out after 5 min ']);
  const { worklogPath } = await lib(env);
  const rec = JSON.parse(readFileSync(worklogPath(env.proj), 'utf8').trim());
  assert.equal(rec.about, 'Users get logged out after 5 min');
  const [e] = await read(env);
  assert.equal(e.tasks[0].about, 'Users get logged out after 5 min');
});

test('--steps-about pairs lines with steps', async () => {
  const env = setup();
  note(env, ['start', 'Three things', '--steps', 'a|b|c', '--steps-about', 'why a|why b']);
  assert.deepEqual((await read(env))[0].tasks.map((t) => t.about), ['why a', 'why b', null]);
  const env2 = setup();
  note(env2, ['start', 'Three things', '--steps', 'x|y|z', '--steps-about', '1|2|3|4']);
  assert.deepEqual((await read(env2))[0].tasks.map((t) => t.about), ['1', '2', '3']);
  const env3 = setup();
  note(env3, ['start', 'Gap', '--steps', 'x|y', '--steps-about', '|why y']);
  assert.deepEqual((await read(env3))[0].tasks.map((t) => t.about), [null, 'why y']);
});

test('changedMs follows the last record touching a task', async () => {
  const env = setup();
  const T0 = Date.parse('2026-11-01T10:00:00Z');
  const T1 = T0 + 60000;
  const T2 = T0 + 120000;
  await writeLog(env, [
    { at: new Date(T0).toISOString(), verb: 'start', title: 'Two', steps: ['a', 'b'] },
    { at: new Date(T1).toISOString(), verb: 'step', n: 2, status: 'doing' },
  ]);
  assert.deepEqual((await read(env))[0].tasks.map((t) => t.changedMs), [T0, T1]);
  await writeLog(env, [{ at: new Date(T2).toISOString(), verb: 'done' }]);
  assert.deepEqual((await read(env))[0].tasks.map((t) => t.changedMs), [T2, T2]);
});

test('old lines without about still read', async () => {
  const env = setup();
  await writeLog(env, [{ at: '2026-11-01T10:00:00Z', verb: 'start', title: 'Old one' }]);
  const [e] = await read(env);
  assert.equal(e.tasks[0].about, null);
  assert.equal(e.tasks[0].status, 'doing');
});

test('a superseded epic marks its unfinished doing steps leftOpen and hides the untouched ones', async () => {
  const env = setup();
  await writeLog(env, [
    { at: '2026-11-01T10:00:00Z', verb: 'start', title: 'First', steps: ['a', 'b'] },
    { at: '2026-11-01T10:01:00Z', verb: 'step', n: 1, status: 'doing' },
    { at: '2026-11-01T10:02:00Z', verb: 'start', title: 'Second' },
  ]);
  const [first, second] = await read(env);
  assert.deepEqual(first.tasks.map((t) => [t.title, t.status, t.leftOpen === true]), [['a', 'next', true]]);
  assert.equal(second.tasks[0].leftOpen, undefined);
});

test('--steps-about stays paired when --steps has an empty entry', async () => {
  const env = setup();
  note(env, ['start', 'Gaps', '--steps', 'a||b', '--steps-about', 'x|y|z']);
  assert.deepEqual((await read(env))[0].tasks.map((t) => [t.title, t.about]), [['a', 'x'], ['b', 'z']]);
});

test('steps changes the open entry in place: statuses follow the step names, new steps start as next', async () => {
  const env = setup();
  note(env, ['start', 'Review rounds', '--steps', 'Design|Build|Test']);
  note(env, ['step', '1', 'done']);
  note(env, ['step', '2', 'doing']);
  note(env, ['steps', 'Design|Build|Ship|Test', '--steps-about', 'd|b|s|t']);
  note(env, ['step', '3', 'waiting']);
  const epics = await read(env);
  assert.equal(epics.length, 1);
  assert.deepEqual(epics[0].tasks.map((t) => [t.title, t.status]), [['Design', 'done'], ['Build', 'doing'], ['Ship', 'waiting'], ['Test', 'next']]);
  assert.equal(epics[0].tasks[2].about, 's');
  const { openEntryFor } = await lib(env);
  assert.deepEqual(openEntryFor(env.proj, 's1').doing.map((s) => s.name), ['Build']);
});

test('an entry replaced by a new start with the same title from the same session is not listed', async () => {
  const env = setup();
  note(env, ['start', 'Review rounds', '--steps', 'a|b']);
  note(env, ['step', '1', 'doing']);
  note(env, ['start', 'Review rounds', '--steps', 'a|b|c']);
  note(env, ['step', '1', 'done']); // begun, so the entry stays listed after "Other work" closes it
  note(env, ['start', 'Other work', '--steps', 'x']);
  note(env, ['start', 'Something else', '--steps', 'y'], 's2');
  note(env, ['start', 'Other work', '--steps', 'z'], 's2'); // another session: its own entry, not a replacement
  const epics = await read(env);
  assert.deepEqual(epics.map((e) => e.title), ['Review rounds', 'Other work', 'Other work']); // 'Something else' closed with nothing begun
  assert.deepEqual(epics[0].tasks.map((t) => t.title), ['a']); // the newer copy; its untouched steps closed with it
});

test('a replaced entry offers no next steps: its untouched steps are hidden, begun ones stay left open', async () => {
  const env = setup();
  note(env, ['start', 'Old work', '--steps', 'begun|untouched|finished']);
  note(env, ['step', '1', 'doing']);
  note(env, ['step', '3', 'done']);
  note(env, ['start', 'New work', '--steps', 'x']);
  const [old] = await read(env);
  assert.deepEqual(old.tasks.map((t) => [t.title, t.status, t.leftOpen === true]), [['begun', 'next', true], ['finished', 'done', false]]);
});

test('steps on an entry without steps: the first new step takes over its status and plan task (review fix)', async () => {
  const env = setup();
  note(env, ['start', 'X', '--plan', 'p.md', '--task', '3']);
  note(env, ['steps', 'a|b']);
  const [e] = await read(env);
  assert.deepEqual(e.tasks.map((t) => [t.title, t.status, t.n]), [['a', 'doing', 3], ['b', 'next', null]]);
});

test('steps with the same count renames by position: a renamed step keeps its status (review fix)', async () => {
  const env = setup();
  note(env, ['start', 'Y', '--plan', 'p.md', '--task', '5', '--steps', 'a|b|c']);
  note(env, ['step', '1', 'done']);
  note(env, ['steps', 'a2|b|c']);
  const [e] = await read(env);
  assert.deepEqual(e.tasks.map((t) => [t.title, t.status, t.n]), [['a2', 'done', 5], ['b', 'next', null], ['c', 'next', null]]);
  // A different count is not a rename: names still match by name and a new one is next.
  note(env, ['steps', 'b|x|a2|c']);
  const [f] = await read(env);
  assert.deepEqual(f.tasks.map((t) => [t.title, t.status]), [['b', 'next'], ['x', 'next'], ['a2', 'done'], ['c', 'next']]);
  assert.equal(f.tasks.find((t) => t.title === 'a2').n, 5);
});
