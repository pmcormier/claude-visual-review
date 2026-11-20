// The watcher (plan 2026-11-20 dashboard heartbeat, Task 2): judge() decides when a background job has gone quiet,
// repeats itself, ended or vanished; markers record that a session is watching. Tests never touch the real ~/.claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'cvr-watch-'));
process.env.CVR_DASH_CLAUDE_HOME = home;
const W = await import('../../global/dashboard/lib/watch.mjs');
const { judge, initState, parseArgs, markerPath, writeMarker, readMarkers, isLive, pruneMarkers, sessionOf } = W;

const MIN = 60000;
const T0 = Date.parse('2026-11-20T10:00:00Z');
const at = (m) => T0 + m * MIN;
const start = (over = {}) => initState({ what: 'CI watch', quietMin: 15, size: 0, now: T0, ...over });
// Feed polls in order: [minute, {ok, size, tail}]; returns the first exit with its minute.
function run(state, polls) {
  for (const [m, p] of polls) {
    const r = judge(state, { ok: true, tail: [], ...p }, at(m));
    state = r.state;
    if (r.exit) return { exit: r.exit, m };
  }
  return { exit: null };
}

test('quiet after 15 min with no growth', () => {
  const r = run(start(), [[0, { size: 10, tail: ['waiting'] }], [10, { size: 10 }], [15, { size: 10 }]]);
  assert.equal(r.exit, 'Quiet 15 min: "CI watch". Last line: waiting.');
  assert.equal(r.m, 15);
});

test('growth resets quiet', () => {
  const r = run(start(), [[0, { size: 10, tail: ['a'] }], [14, { size: 20, tail: ['b'] }], [15, { size: 20 }], [28, { size: 20 }]]);
  assert.equal(r.exit, null);
});

test('repeating: the same line for 15 min while the file grows', () => {
  const polls = [];
  for (let m = 0; m <= 16; m++) polls.push([m, { size: 10 * (m + 1), tail: ['Error: connection refused, retrying'] }]);
  const r = run(start(), polls);
  assert.match(r.exit, /^Repeating for 15 min: "CI watch"\. Line: Error: connection refused, retrying\.$/);
});

test('changing progress lines are not repeating', () => {
  const polls = [];
  for (let m = 0; m <= 30; m++) polls.push([m, { size: 10 * (m + 1), tail: [`${10 + m}%`] }]);
  assert.equal(run(start(), polls).exit, null);
});

test('job ended waits 2 min, then wins over quiet', () => {
  const s = start();
  const r1 = run(s, [[0, { size: 10, tail: ['done building'] }], [14, { size: 30, tail: ['[exited with code 0]'] }], [15, { size: 30 }]]);
  assert.equal(r1.exit, null);
  const r2 = run(start(), [[0, { size: 10, tail: ['x'] }], [14, { size: 30, tail: ['[exited with code 0]'] }], [15, { size: 30 }], [16, { size: 30 }]]);
  assert.equal(r2.exit, 'Job ended (code 0): "CI watch". Stop watching it.');
  assert.equal(r2.m, 16);
  // Ended while already quiet: ended still wins.
  const r3 = run(start(), [[0, { size: 10, tail: ['x'] }], [14, { size: 30, tail: ['[exited with code 1]'] }], [29, { size: 30 }], [30, { size: 30 }]]);
  assert.equal(r3.exit, 'Job ended (code 1): "CI watch". Stop watching it.');
});

test('gone after 2 failed polls; one failed poll is not gone', () => {
  assert.equal(run(start(), [[0, { size: 10 }], [1, { ok: false }], [2, { size: 10 }]]).exit, null);
  assert.equal(run(start(), [[0, { size: 10 }], [1, { ok: false }], [2, { ok: false }]]).exit, 'Output file gone: "CI watch".');
});

test('a file that shrinks counts as new output', () => {
  assert.equal(run(start(), [[0, { size: 100, tail: ['a'] }], [14, { size: 5, tail: ['b'] }], [15, { size: 5 }]]).exit, null);
});

test('no new output since the last check', () => {
  const r = run(start({ prevQuietSize: 10, size: 10 }), [[0, { size: 10 }], [15, { size: 10 }]]);
  assert.equal(r.exit, 'Quiet 15 min: "CI watch". Last line: (none). No new output since the last check.');
  const grown = run(start({ prevQuietSize: 10, size: 10 }), [[0, { size: 12, tail: ['x'] }], [15, { size: 12 }]]);
  assert.equal(grown.exit, 'Quiet 15 min: "CI watch". Last line: x.');
});

test('a long line is clipped to 200 characters with …', () => {
  const r = run(start(), [[0, { size: 10, tail: ['y'.repeat(300)] }], [15, { size: 10 }]]);
  const line = r.exit.slice(r.exit.indexOf('Last line: ') + 11, -1);
  assert.equal(line.length, 200);
  assert.ok(line.endsWith('…'));
});

test('parseArgs: --quiet between 5 and 120', () => {
  assert.ok(parseArgs(['--file', 'f', '--what', 'w', '--quiet', '3']).error);
  assert.ok(parseArgs(['--file', 'f', '--what', 'w', '--quiet', '121']).error);
  assert.deepEqual(parseArgs(['--file', 'f', '--what', 'w', '--quiet', '30']), { file: 'f', what: 'w', quietMin: 30 });
  assert.equal(parseArgs(['--file', 'f', '--what', 'w']).quietMin, 15);
  assert.ok(parseArgs(['--what', 'w']).error);
});

test('isLive: fresh beat and not exited', () => {
  const now = at(0);
  assert.equal(isLive({ beatAt: now - MIN, exited: null }, now), true);
  assert.equal(isLive({ beatAt: now - 4 * MIN, exited: null }, now), false);
  assert.equal(isLive({ beatAt: now, exited: { at: now, reason: 'quiet', size: 1 } }, now), false);
});

test('markers: two per session, one live; prune after 7 days', () => {
  const now = Date.now();
  const mk = (file, beatAt, exited = null) => ({ session: 's1', file, what: 'w', startedAt: beatAt, beatAt, lastGrowthAt: beatAt, size: 0, quietMin: 15, exited });
  writeMarker(mk('work/t/a.output', now));
  writeMarker(mk('work/t/b.output', now, { at: now, reason: 'quiet', size: 0 }));
  writeMarker({ ...mk('work/t/c.output', now - 8 * 86400000), session: 's2' });
  const mine = readMarkers('s1');
  assert.equal(mine.length, 2);
  assert.equal(mine.some((m) => isLive(m, now)), true);
  assert.notEqual(markerPath('s1', 'work/t/a.output'), markerPath('s1', 'work/t/b.output'));
  pruneMarkers(now);
  assert.equal(readMarkers('s2').length, 0);
  assert.equal(readMarkers('s1').length, 2);
});

test('sessionOf: env first, else the folder before tasks', () => {
  assert.equal(sessionOf('work/x/abc-123/tasks/b1.output', { CLAUDE_CODE_SESSION_ID: 'env-id' }), 'env-id');
  assert.equal(sessionOf('work\\x\\abc-123\\tasks\\b1.output', {}), 'abc-123');
  assert.equal(sessionOf('work/x/y.output', {}), null);
});

test('the command: bad flags print one line and exit 0', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const cli = fileURLToPath(new URL('../../global/dashboard/watch.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [cli, '--what', 'x'], { env: { ...process.env, CVR_DASH_CLAUDE_HOME: home }, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^watch: --file .* is required\n$/);
});

test('watchFor: a live marker on the same file, whatever the slashes or case', async () => {
  const { watchFor } = await import('../../global/dashboard/lib/watch.mjs');
  const now = Date.now();
  const m = { session: 's', file: 'Work/T/job.output', what: 'w', startedAt: now, beatAt: now, lastGrowthAt: now - 2 * MIN, size: 1, quietMin: 15, exited: null };
  assert.deepEqual(watchFor('work\\t\\job.output', [m], now), { lastGrowthAt: now - 2 * MIN, quietMin: 15 });
  assert.equal(watchFor('work/t/other.output', [m], now), null);
  assert.equal(watchFor('work/t/job.output', [{ ...m, beatAt: now - 4 * MIN }], now), null);
  assert.equal(watchFor(null, [m], now), null);
});
