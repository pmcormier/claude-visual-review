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
    assert.deepEqual(m.thresholds, { waitingEscalate: 15 }); // the default reaches the page
    const tuned = await buildModel(now, { sampler: sampler(), config: { thresholds: { waitingEscalate: 30 } } });
    assert.deepEqual(tuned.thresholds, { waitingEscalate: 30 });
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
    assert.equal(m.counts.stuck, 1); // the stuck subagent counts, so the headline agrees with the project
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

test('a failing project shows an error note while the others still render', async () => {
  const w = makeWorld();
  try {
    const now = Date.now();
    const good = project(w, 'good');
    const broken = project(w, 'broken');
    transcript(w, good, 'g1', [userAt(now - MIN)]);
    session(w, 401, good, 'g1', 'busy');
    transcript(w, broken, 'b1', [userAt(now - MIN)]);
    session(w, 402, broken, 'b1', 'busy');
    const { buildModel } = await import('../../global/dashboard/lib/model.mjs');
    const { readPlans } = await import('../../global/dashboard/lib/sources/plans.mjs');
    const sources = { readPlans: (root) => { if (root.endsWith('broken')) throw new Error('plan exploded'); return readPlans(root); } };
    const m = await buildModel(now, { sampler: sampler(), sources });
    const by = Object.fromEntries(m.projects.map((p) => [p.name, p]));
    assert.match(by.broken.error, /Could not read this project: plan exploded/);
    assert.equal(by.broken.tree, null);
    assert.equal(by.broken.sessions.length, 1); // its sessions still show
    assert.equal(by.good.error, null);
    assert.ok(by.good.tree);
    assert.equal(m.error, null);
    assert.equal(m.counts.working, 2);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('a cached plan is read again once it changes', async () => {
  const w = makeWorld();
  try {
    const now = Date.now();
    const root = project(w, 'mu');
    mkdirSync(join(root, 'docs', 'superpowers', 'plans'), { recursive: true });
    const plan = join(root, 'docs', 'superpowers', 'plans', 'p.md');
    writeFileSync(plan, ['# P', '', '### Task 1: One', ''].join('\n'));
    transcript(w, root, 'm1', [userAt(now - MIN)]);
    session(w, 501, root, 'm1', 'idle');
    const { buildModel } = await import('../../global/dashboard/lib/model.mjs');
    const titles = (m) => m.projects[0].tree.epics.flatMap((e) => e.tasks.map((t) => t.title));
    assert.deepEqual(titles(await buildModel(now, { sampler: sampler() })), ['One']);
    assert.deepEqual(titles(await buildModel(now, { sampler: sampler() })), ['One']);
    writeFileSync(plan, ['# P', '', '### Task 1: One', '', '### Task 2: Two', ''].join('\n'));
    assert.deepEqual(titles(await buildModel(now, { sampler: sampler() })), ['One', 'Two']);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

// R22: the stall rules read the CPU of the processes the pending tool started, not the whole session tree.
test('stall CPU is the pending tool\'s own processes, not Claude Code or its MCP servers', async () => {
  const ft = (ms) => (BigInt(ms) + 11644473600000n) * 10000n; // FILETIME, as the sampler reports CreationDate
  const now = Date.now();
  const toolStart = now - 30 * MIN;
  const table = (toolChildCpu) => (pid) => {
    const base = pid * 10;
    return [
      { pid, cpuPct: 3, created: ft(now - 5 * 60 * MIN) }, // claude.exe, idle-ish
      { pid: base + 1, cpuPct: 50, created: ft(now - 4 * 60 * MIN) }, // an MCP server, busy, started long before
      { pid: base + 2, cpuPct: toolChildCpu, created: ft(toolStart + 500) }, // what the tool started
    ];
  };
  const run = async (toolChildCpu) => {
    const w = makeWorld();
    try {
      const root = project(w, 'nu');
      // A foreground tool pending 30 min, transcript quiet for 25 min.
      transcript(w, root, 'h1', [toolAt(toolStart, 'b1', 'Bash', { command: 'npm test' })], now - 25 * MIN);
      session(w, 601, root, 'h1', 'busy');
      // No tool pending, busy, transcript quiet for 25 min: only status and the transcript decide.
      transcript(w, root, 'q1', [userAt(now - 25 * MIN)], now - 25 * MIN);
      session(w, 602, root, 'q1', 'busy');
      // The parent waits on a subagent whose own Bash call has been pending 30 min.
      transcript(w, root, 'a1', [toolAt(now - 31 * MIN, 'ag', 'Agent', { prompt: 'go' })], now - 31 * MIN);
      session(w, 603, root, 'a1', 'busy');
      const dir = join(w.claude, 'projects', enc(root), 'a1', 'subagents');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'agent-s.jsonl'), JSON.stringify(toolAt(toolStart, 'sb', 'Bash', { command: 'make' })) + '\n');
      utimesSync(join(dir, 'agent-s.jsonl'), new Date(now - 25 * MIN), new Date(now - 25 * MIN));
      writeFileSync(join(dir, 'agent-s.meta.json'), JSON.stringify({ description: 'build', finished: false }));
      const { buildModel } = await import('../../global/dashboard/lib/model.mjs');
      const m = await buildModel(now, { sampler: { alive: () => true, descendants: table(toolChildCpu) } });
      const by = Object.fromEntries(m.projects[0].sessions.map((s) => [s.sessionId, s]));
      return by;
    } finally { rmSync(w.base, { recursive: true, force: true }); }
  };

  const quietTool = await run(0);
  assert.equal(quietTool.h1.cpuPct, 0);
  assert.equal(quietTool.h1.state, 'stuck');
  assert.match(quietTool.h1.evidence, /0% CPU/);
  assert.equal(quietTool.q1.cpuPct, null); // nothing pending: CPU not consulted
  assert.equal(quietTool.q1.state, 'stuck');
  assert.equal(quietTool.a1.subagents[0].state, 'stuck');

  const busyTool = await run(40);
  assert.equal(busyTool.h1.cpuPct, 40);
  assert.equal(busyTool.h1.state, 'working');
  assert.equal(busyTool.a1.subagents[0].state, 'working');
});

test('toolCpu: unknown when the sampler has no figure, 0 when the tool started nothing', async () => {
  const { toolCpu } = await import('../../global/dashboard/lib/model.mjs');
  const ft = (ms) => (BigInt(ms) + 11644473600000n) * 10000n;
  const t = 1.9e12;
  assert.equal(toolCpu({ descendants: (pid) => [{ pid, cpuPct: null, created: ft(t - 1e6) }] }, 7, t), null);
  assert.equal(toolCpu({ descendants: (pid) => [{ pid, cpuPct: 2, created: ft(t - 1e6) }] }, 7, t), 0);
  assert.equal(toolCpu({ descendants: (pid) => [{ pid, cpuPct: 2, created: ft(t - 1e6) }] }, 7, null), null);
  // Created within the 2 s slack before the tool's start still counts.
  assert.equal(toolCpu({ descendants: (pid) => [{ pid, cpuPct: 2, created: ft(t - 1e6) }, { pid: 8, cpuPct: 9, created: ft(t - 1500) }] }, 7, t), 9);
});
