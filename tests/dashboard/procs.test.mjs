import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProcessTable, createSamplerState, outputGrowth, growthTracked } from '../../global/dashboard/lib/procs.mjs';

const csv = (rows) => '"ProcessId","ParentProcessId","KernelModeTime","UserModeTime","Created"\r\n'
  + rows.map((r) => r.map((c) => `"${c}"`).join(',')).join('\r\n') + '\r\n';

test('parseProcessTable reads CSV', () => {
  const t = parseProcessTable(csv([[10, 1, 10000000, 20000000, '134393997204242343'], [11, 10, 0, 5000000, '']]));
  assert.deepEqual(t, [
    { pid: 10, ppid: 1, cpuSeconds: 3, created: 134393997204242343n },
    { pid: 11, ppid: 10, cpuSeconds: 0.5, created: null },
  ]);
  assert.deepEqual(parseProcessTable('garbage'), []);
  assert.deepEqual(parseProcessTable(undefined), []);
  assert.deepEqual(parseProcessTable(csv([['x', 1, 1, 1, 1]])), []);
});

test('cpu percent from two samples', () => {
  const s = createSamplerState();
  s.ingest(csv([[10, 1, 0, 0, '']]), 1000);
  assert.equal(s.descendants(10)[0].cpuPct, null);
  s.ingest(csv([[10, 1, 10000000, 10000000, '']]), 3000); // +2s cpu over 2s wall
  assert.equal(s.descendants(10)[0].cpuPct, 100);
  s.ingest(csv([[10, 1, 10000000, 10000000, '']]), 5000);
  assert.equal(s.descendants(10)[0].cpuPct, 0);
  // pid reuse (cpu went down) never gives a negative figure
  s.ingest(csv([[10, 1, 0, 0, '']]), 7000);
  assert.equal(s.descendants(10)[0].cpuPct, 0);
});

test('descendants walks the ppid tree', () => {
  const s = createSamplerState();
  s.ingest(csv([[1, 0, 0, 0, ''], [2, 1, 0, 0, ''], [3, 2, 0, 0, ''], [4, 1, 0, 0, ''], [5, 9, 0, 0, '']]), 0);
  assert.deepEqual(s.descendants(2).map((d) => d.pid).sort(), [2, 3]);
  assert.deepEqual(s.descendants(99), []);
  // cycle from pid reuse terminates
  s.ingest(csv([[6, 7, 0, 0, ''], [7, 6, 0, 0, '']]), 1);
  assert.deepEqual(s.descendants(6).map((d) => d.pid).sort(), [6, 7]);
});

test('alive checks pid and start time', () => {
  const s = createSamplerState();
  s.ingest(csv([[10, 1, 0, 0, '134393997204242346']]), 0);
  assert.equal(s.alive(10, '134393997204242343'), true);   // within 10 ms
  assert.equal(s.alive(10, '134393997304242343'), false);  // different start: pid reused
  assert.equal(s.alive(10, undefined), true);
  assert.equal(s.alive(10, 'nope'), true);
  assert.equal(s.alive(11, '134393997204242343'), false);
});

test('outputGrowth tracks idle time since last growth', () => {
  const d = mkdtempSync(join(tmpdir(), 'cvr-procs-'));
  try {
    const f = join(d, 'out.log');
    assert.deepEqual(outputGrowth(join(d, 'missing')), { idleMs: null });
    writeFileSync(f, 'abc');
    const old = new Date(Date.now() - 60000);
    utimesSync(f, old, old);
    const a = outputGrowth(f).idleMs;
    assert.ok(a >= 59000 && a < 70000, String(a));
    const b = outputGrowth(f).idleMs; // unchanged: still measured from first stamp
    assert.ok(b >= a);
    appendFileSync(f, 'more');
    assert.ok(outputGrowth(f).idleMs < 5000);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('sampler restarts a dead child and stop() kills it', async () => {
  const { EventEmitter } = await import('node:events');
  const { startCpuSampler } = await import('../../global/dashboard/lib/procs.mjs');
  if (process.platform !== 'win32') return;
  const kids = [];
  const fake = () => {
    const k = new EventEmitter();
    k.stdout = new EventEmitter();
    k.stdout.setEncoding = () => {};
    k.killed = false;
    k.kill = () => { k.killed = true; };
    kids.push(k);
    return k;
  };
  const s = startCpuSampler(1000, { spawnFn: fake, restartMs: 20 });
  assert.equal(kids.length, 1);
  kids[0].stdout.emit('data', csv([[os_pid(), 1, 0, 0, '']]) + '#---sample---\r\n');
  assert.equal(s.alive(os_pid(), undefined), true);
  kids[0].emit('exit');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(kids.length, 2);
  s.stop();
  assert.equal(kids[1].killed, true);
  kids[1].emit('exit');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(kids.length, 2);
});
function os_pid() { return 4242; }

test('stale sampler sample falls back to kill(0) and unknown CPU', async () => {
  const { EventEmitter } = await import('node:events');
  const { spawnSync } = await import('node:child_process');
  const { startCpuSampler } = await import('../../global/dashboard/lib/procs.mjs');
  if (process.platform !== 'win32') return;
  // A pid that has exited: the sample still lists it, kill(0) does not.
  const dead = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
  const kids = [];
  const fake = () => {
    const k = new EventEmitter();
    k.stdout = new EventEmitter();
    k.stdout.setEncoding = () => {};
    k.kill = () => {};
    kids.push(k);
    return k;
  };
  let t = 1_000_000;
  const s = startCpuSampler(1000, { spawnFn: fake, restartMs: 60000, now: () => t });
  try {
    const me = process.pid;
    kids[0].stdout.emit('data', csv([[me, 1, 0, 0, ''], [dead, 1, 0, 0, '']]) + '#---sample---\r\n');
    t += 1000;
    kids[0].stdout.emit('data', csv([[me, 1, 10000000, 0, ''], [dead, 1, 0, 0, '']]) + '#---sample---\r\n');
    assert.equal(s.alive(dead, undefined), true); // fresh sample is trusted
    assert.equal(s.descendants(me)[0].cpuPct, 100);
    t += 3001; // older than 3 intervals: the child hung
    assert.equal(s.alive(dead, undefined), false);
    assert.equal(s.alive(me, undefined), true);
    assert.deepEqual(s.descendants(me), [{ pid: me, cpuPct: null }]);
    assert.deepEqual(s.descendants(dead), []);
  } finally { s.stop(); }
});

test('outputGrowth forgets files not asked about for an hour', () => {
  const d = mkdtempSync(join(tmpdir(), 'cvr-growth-'));
  try {
    writeFileSync(join(d, 'a.output'), 'x');
    writeFileSync(join(d, 'b.output'), 'y');
    const later = Date.now() + 30 * 86400000;
    outputGrowth(join(d, 'a.output'), later);
    outputGrowth(join(d, 'b.output'), later + 90 * 60000);
    assert.equal(growthTracked(), 1);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
