import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MIN = 60000;

// Each test gets its own fake homes; paths.mjs reads the env on every call.
function makeWorld() {
  const base = mkdtempSync(join(tmpdir(), 'cvr-model-'));
  const claude = join(base, 'claude');
  mkdirSync(join(claude, 'sessions'), { recursive: true });
  mkdirSync(join(claude, 'projects'), { recursive: true });
  process.env.CVR_DASH_CLAUDE_HOME = claude;
  process.env.CVR_DASH_PLANNOTATOR_HOME = join(base, 'plannotator');
  return { base, claude };
}

function project(world, name) {
  const root = join(world.base, 'work', name);
  mkdirSync(join(root, '.git'), { recursive: true });
  return root;
}

const enc = (cwd) => String(cwd).replace(/[^A-Za-z0-9]/g, '-');
const iso = (ms) => new Date(ms).toISOString();

function transcript(world, cwd, sid, entries, mtimeMs) {
  const dir = join(world.claude, 'projects', enc(cwd));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sid}.jsonl`);
  writeFileSync(file, entries.map((e) => JSON.stringify({ cwd, sessionId: sid, ...e })).join('\n') + '\n');
  if (mtimeMs) utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

function session(world, n, cwd, sid, status, extra = {}) {
  writeFileSync(join(world.claude, 'sessions', `${n}.json`), JSON.stringify({
    pid: n, procStart: null, sessionId: sid, cwd, name: sid, status, statusUpdatedAt: Date.now(), ...extra,
  }));
}

const userAt = (ms, text = 'hello') => ({ type: 'user', timestamp: iso(ms), message: { role: 'user', content: text } });
const toolAt = (ms, id, name, input) => ({
  type: 'assistant', timestamp: iso(ms), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});

const sampler = (alive = () => true) => ({ alive, descendants: (pid) => [{ pid, cpuPct: 0 }] });

test('buildModel with no sessions and no projects returns an empty valid model', async () => {
  const w = makeWorld();
  try {
    const { buildModel } = await import('../../global/dashboard/lib/model.mjs');
    const now = Date.now();
    const m = await buildModel(now, { sampler: sampler() });
    assert.equal(m.generatedAt, now);
    assert.deepEqual(m.counts, { stuck: 0, waiting: 0, working: 0, next: 0 });
    assert.deepEqual(m.projects, []);
    assert.equal(m.live, 0);
    assert.ok(m.usage && 'fiveHour' in m.usage);
    JSON.stringify(m); // serialisable
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('model orders projects stuck, waiting, working, then others', async () => {
  const w = makeWorld();
  try {
    const now = Date.now();
    const alpha = project(w, 'alpha');
    const beta = project(w, 'beta');
    const gamma = project(w, 'gamma');
    const delta = project(w, 'delta');
    // gamma: working, has a plan, and its transcript reads the plan and names Task 2.
    mkdirSync(join(gamma, 'docs', 'superpowers', 'plans'), { recursive: true });
    const plan = join(gamma, 'docs', 'superpowers', 'plans', 'p.md');
    writeFileSync(plan, '# Plan\n\n### Task 1: First\n\n### Task 2: Second\n');
    transcript(w, gamma, 'sg', [userAt(now - MIN), toolAt(now - 30000, 't1', 'Read', { file_path: plan }),
      { type: 'assistant', timestamp: iso(now - 20000), message: { role: 'assistant', content: [{ type: 'text', text: 'Starting Task 2' }] } }]);
    session(w, 103, gamma, 'sg', 'busy');
    // delta: no live session, only a recent transcript.
    transcript(w, delta, 'sd', [userAt(now - 2 * 3600000)], now - 2 * 3600000);
    // beta: waiting on a permission prompt.
    transcript(w, beta, 'sb', [userAt(now - MIN)]);
    session(w, 102, beta, 'sb', 'waiting', { statusUpdatedAt: now - MIN });
    // alpha: busy but silent for 40 min with no CPU.
    transcript(w, alpha, 'sa', [userAt(now - 40 * MIN)], now - 40 * MIN);
    session(w, 101, alpha, 'sa', 'busy');

    const { buildModel } = await import('../../global/dashboard/lib/model.mjs');
    const m = await buildModel(now, { sampler: sampler() });
    assert.equal(m.error, null);
    assert.deepEqual(m.projects.map((p) => p.error), [null, null, null, null]);
    assert.deepEqual(m.projects.map((p) => p.name), ['alpha', 'beta', 'gamma', 'delta']);
    assert.deepEqual(m.projects.map((p) => p.state), ['stuck', 'waiting', 'working', 'quiet']);
    assert.deepEqual(m.counts, { stuck: 1, waiting: 1, working: 1, next: 1 });
    assert.equal(m.live, 3);
    const a = m.projects[0];
    assert.equal(a.open, true);
    assert.match(a.sessions[0].evidence, /No activity for 40 min/);
    assert.equal(a.sessions[0].life.length, 60);
    const g = m.projects[2].sessions[0];
    assert.equal(g.linkedTask?.title, 'Second');
    const tasks = m.projects[2].tree.epics.flatMap((e) => e.tasks);
    assert.equal(tasks.length, 2);
    assert.ok(tasks.every((t) => !('ticked' in t))); // plan steps never reach the page
    assert.equal(m.projects[2].quietSince, null);
    const d = m.projects[3];
    assert.equal(d.open, false);
    assert.deepEqual(d.sessions, []);
    assert.ok(Math.abs(d.quietSince - (now - 2 * 3600000)) < 2000);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('subagent never-reports rule needs the parent to be waiting on it', async () => {
  const w = makeWorld();
  try {
    const now = Date.now();
    const root = project(w, 'kappa');
    const old = now - 30 * MIN;
    const sub = (sid, id, finished) => {
      const dir = join(w.claude, 'projects', enc(root), sid, 'subagents');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `agent-${id}.jsonl`), JSON.stringify(userAt(old)) + '\n');
      utimesSync(join(dir, `agent-${id}.jsonl`), new Date(old), new Date(old));
      writeFileSync(join(dir, `agent-${id}.meta.json`), JSON.stringify({ description: `job ${id}`, finished }));
    };
    // Parent moved on (pending Bash): the quiet subagent is idle, not stuck.
    transcript(w, root, 's1', [toolAt(now - 10000, 'b1', 'Bash', { command: 'npm test' })]);
    sub('s1', 'x', false);
    session(w, 201, root, 's1', 'busy');
    // Same parent, a subagent left with a tool pending for days: still idle (nobody waits on it).
    const dir1 = join(w.claude, 'projects', enc(root), 's1', 'subagents');
    writeFileSync(join(dir1, 'agent-w.jsonl'), JSON.stringify(toolAt(now - 3 * 1440 * MIN, 'wb', 'Bash', { command: 'sleep 9' })) + '\n');
    utimesSync(join(dir1, 'agent-w.jsonl'), new Date(now - 3 * 1440 * MIN), new Date(now - 3 * 1440 * MIN));
    // Parent waits on an Agent call: the quiet subagent looks stuck.
    transcript(w, root, 's2', [toolAt(now - 10000, 'a1', 'Agent', { prompt: 'go' })]);
    sub('s2', 'y', false);
    session(w, 202, root, 's2', 'busy');
    // Parent died with a tool pending: it is gone, its finished subagent is idle.
    transcript(w, root, 's3', [toolAt(now - 10000, 'b3', 'Bash', { command: 'make' })]);
    sub('s3', 'z', true);
    session(w, 203, root, 's3', 'busy');

    const { buildModel } = await import('../../global/dashboard/lib/model.mjs');
    const m = await buildModel(now, { sampler: sampler((pid) => pid !== 203) });
    const by = Object.fromEntries(m.projects[0].sessions.map((s) => [s.sessionId, s]));
    assert.deepEqual(by.s1.subagents.map((a) => [a.agentId, a.state]).sort(), [['w', 'idle'], ['x', 'idle']]);
    assert.equal(by.s2.subagents[0].state, 'stuck');
    assert.equal(by.s3.state, 'gone');
    assert.equal(by.s3.subagents[0].state, 'idle');
    assert.equal(m.projects[0].state, 'stuck');
    assert.equal(m.live, 2);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('a dead session with no pending tool is dropped, not shown as gone', async () => {
  const w = makeWorld();
  try {
    const now = Date.now();
    const root = project(w, 'lambda');
    transcript(w, root, 's9', [userAt(now - 5 * MIN)]);
    session(w, 301, root, 's9', 'idle');
    const { buildModel } = await import('../../global/dashboard/lib/model.mjs');
    const m = await buildModel(now, { sampler: sampler(() => false) });
    assert.equal(m.live, 0);
    assert.deepEqual(m.projects.flatMap((p) => p.sessions), []);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('orderProjects ranks by state, then last activity', async () => {
  const { orderProjects } = await import('../../global/dashboard/lib/model.mjs');
  const p = (name, state, lastActivityMs) => ({ name, state, lastActivityMs });
  const out = orderProjects([p('a', 'idle', 9), p('b', 'working', 1), p('c', 'stuck', 1), p('d', 'quiet', 10),
    p('e', 'waiting', 1), p('f', 'working', 5), p('g', 'gone', 3)]);
  assert.deepEqual(out.map((x) => x.name), ['c', 'e', 'f', 'b', 'd', 'a', 'g']);
});
