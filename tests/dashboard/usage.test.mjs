import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const TAP = join(here, '..', '..', 'global', 'dashboard', 'statusline-tap.mjs');
const USAGE = join(here, '..', '..', 'global', 'dashboard', 'lib', 'usage.mjs');
const q = (s) => JSON.stringify(s);
const nodeCmd = (js) => `${q(process.execPath)} -e ${q(js)}`;

function setup(original) {
  const home = mkdtempSync(join(tmpdir(), 'cvr-tap-'));
  const dash = join(home, 'dashboard');
  mkdirSync(dash, { recursive: true });
  if (original !== undefined) writeFileSync(join(dash, 'statusline-original.json'), JSON.stringify(original));
  return { home, dash };
}
function runTap(home, input) {
  return spawnSync(process.execPath, [TAP], {
    input, env: { ...process.env, CVR_DASH_CLAUDE_HOME: home },
  });
}
const ECHO = nodeCmd('process.stdin.pipe(process.stdout)');

test('tap passes stdin to original and echoes its output byte-for-byte', () => {
  const { home } = setup({ type: 'command', command: ECHO });
  const input = Buffer.from('{"x":"héllo ✓ 日本"}\u00ff', 'utf8'); // no trailing newline
  const r = runTap(home, input);
  assert.equal(r.status, 0);
  assert.ok(Buffer.compare(r.stdout, input) === 0);
  rmSync(home, { recursive: true, force: true });
});

test('tap with no original prints nothing', () => {
  for (const orig of [undefined, null, { type: 'command' }]) {
    const { home } = setup(orig);
    const r = runTap(home, '{"rate_limits":{}}');
    assert.equal(r.status, 0);
    assert.equal(r.stdout.length, 0);
    rmSync(home, { recursive: true, force: true });
  }
});

test('tap writes usage only when rate_limits present', () => {
  const { home, dash } = setup({ command: ECHO });
  runTap(home, '{"model":"x"}');
  assert.equal(existsSync(join(dash, 'usage.json')), false);
  const body = { rate_limits: { five_hour: { used_percentage: 12, resets_at: 2000000000 }, seven_day: { used_percentage: 40, resets_at: 2000500000 } } };
  runTap(home, JSON.stringify(body));
  const u = JSON.parse(readFileSync(join(dash, 'usage.json'), 'utf8'));
  assert.equal(u.five_hour.used_percentage, 12);
  assert.equal(u.seven_day.resets_at, 2000500000);
  assert.equal(typeof u.at, 'number');
  rmSync(home, { recursive: true, force: true });
});

test('tap with failing usage write still runs original', () => {
  const { home, dash } = setup({ command: ECHO });
  mkdirSync(join(dash, 'usage.json')); // rename onto a directory fails
  const input = '{"rate_limits":{"five_hour":{"used_percentage":1,"resets_at":1}}}';
  const r = runTap(home, input);
  assert.equal(r.stdout.toString(), input);
  rmSync(home, { recursive: true, force: true });
});

test('tap propagates the original exit code', () => {
  const { home } = setup({ command: nodeCmd('process.stdout.write("out");process.exit(7)') });
  const r = runTap(home, '{}');
  assert.equal(r.status, 7);
  assert.equal(r.stdout.toString(), 'out');
  rmSync(home, { recursive: true, force: true });
});

async function usageMod(home) {
  process.env.CVR_DASH_CLAUDE_HOME = home;
  return import(pathToFileURL(USAGE).href + '?t=' + Math.random());
}

test('expired window reads null', async () => {
  const { home, dash } = setup();
  const now = 1_000_000_000_000;
  writeFileSync(join(dash, 'usage.json'), JSON.stringify({ at: now - 1000,
    five_hour: { used_percentage: 10, resets_at: now / 1000 - 5 },
    seven_day: { used_percentage: 50, resets_at: now / 1000 + 100 } }));
  const { readUsage } = await usageMod(home);
  const u = readUsage(now);
  assert.equal(u.fiveHour, null);
  assert.deepEqual(u.week, { pct: 50, resetsAt: now + 100000 });
  assert.equal(u.stale, false);
  rmSync(home, { recursive: true, force: true });
});

test('readUsage converts seconds to ms, flags stale, handles missing file', async () => {
  const { home, dash } = setup();
  const now = 1_000_000_000_000;
  const { readUsage } = await usageMod(home);
  assert.deepEqual(readUsage(now), { fiveHour: null, week: null, stale: true });
  writeFileSync(join(dash, 'usage.json'), JSON.stringify({ at: now - 16 * 60_000,
    five_hour: { used_percentage: 3, resets_at: now / 1000 + 60 } }));
  const u = readUsage(now);
  assert.deepEqual(u.fiveHour, { pct: 3, resetsAt: now + 60000 });
  assert.equal(u.week, null);
  assert.equal(u.stale, true);
  rmSync(home, { recursive: true, force: true });
});
