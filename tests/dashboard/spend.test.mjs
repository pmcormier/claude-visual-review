// Session spend (plan 2026-11-19 session spend): the status-line tap records each session's cost and tokens under
// <claudeHome>/dashboard/spend/, and lib/spend.mjs reads them back for the page. Tests never touch the real ~/.claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readSpend, pruneSpend, spendFor, sessionSpend, readSpendCached } from '../../global/dashboard/lib/spend.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TAP = join(here, '..', '..', 'global', 'dashboard', 'statusline-tap.mjs');
const q = (s) => JSON.stringify(s);
const ECHO = `${q(process.execPath)} -e ${q('process.stdin.pipe(process.stdout)')}`;
const DAY = 86400000;
const W = join(tmpdir(), 'cvr-work');

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'cvr-spend-'));
  const dash = join(home, 'dashboard');
  mkdirSync(dash, { recursive: true });
  writeFileSync(join(dash, 'statusline-original.json'), JSON.stringify({ command: ECHO }));
  return { home, dash, spend: join(dash, 'spend') };
}
const runTap = (home, body) => spawnSync(process.execPath, [TAP], {
  input: JSON.stringify(body), env: { ...process.env, CVR_DASH_CLAUDE_HOME: home },
});
const status = (id, cost, inTok = 1000, outTok = 200, cwd = join(W, 'proj')) => ({
  session_id: id, cwd, model: { id: 'claude-x' }, cost: { total_cost_usd: cost },
  context_window: { total_input_tokens: inTok, total_output_tokens: outTok },
});

test('tap records a session spend file and still runs the original', () => {
  const { home, spend } = setup();
  const r = runTap(home, status('abc-123', 1.25));
  assert.equal(r.status, 0);
  assert.ok(r.stdout.length > 0, 'original still ran');
  const s = JSON.parse(readFileSync(join(spend, 'abc-123.json'), 'utf8'));
  assert.equal(s.sessionId, 'abc-123');
  assert.equal(s.costUsd, 1.25);
  assert.equal(s.tokensIn, 1000);
  assert.equal(s.tokensOut, 200);
  assert.equal(s.model, 'claude-x');
  assert.equal(s.cwd, join(W, 'proj'));
  assert.equal(typeof s.at, 'number');
  rmSync(home, { recursive: true, force: true });
});

test('tap keeps firstAt across refreshes and updates cost', () => {
  const { home, spend } = setup();
  runTap(home, status('s1', 0.5));
  const a = JSON.parse(readFileSync(join(spend, 's1.json'), 'utf8'));
  runTap(home, status('s1', 0.9));
  const b = JSON.parse(readFileSync(join(spend, 's1.json'), 'utf8'));
  assert.equal(b.firstAt, a.firstAt);
  assert.equal(b.costUsd, 0.9);
  rmSync(home, { recursive: true, force: true });
});

test('tap refuses unsafe session ids and input without cost', () => {
  const { home, spend } = setup();
  for (const id of ['../evil', 'a/b', 'x'.repeat(65), '', 5]) runTap(home, status(id, 1));
  runTap(home, { session_id: 'nocost' });
  const files = existsSync(spend) ? readdirSync(spend) : [];
  assert.deepEqual(files, []);
  assert.equal(existsSync(join(home, 'evil.json')), false);
  rmSync(home, { recursive: true, force: true });
});

test('readSpend reads the files; spendFor sums by project and week', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cvr-spend-r-'));
  const now = Date.now();
  const put = (id, cwd, cost, at) => writeFileSync(join(dir, `${id}.json`), JSON.stringify({ sessionId: id, cwd, costUsd: cost, tokensIn: 100, tokensOut: 10, firstAt: at, at }));
  const P = join(W, 'Proj');
  put('a', P, 1, now - DAY);
  put('b', join(P, 'sub'), 2, now - 2 * DAY);
  put('c', P, 4, now - 10 * DAY);
  put('d', join(W, 'Project2'), 8, now - DAY);
  writeFileSync(join(dir, 'broken.json'), '{');
  const recs = readSpend(dir);
  assert.equal(recs.size, 4);
  assert.equal(recs.get('a').costUsd, 1);
  const p = spendFor(recs, P, now);
  assert.equal(p.weekUsd, 3);
  assert.equal(p.totalUsd, 7);
  assert.equal(p.sessions, 3);
  assert.equal(p.weekTokens, 220);
  assert.deepEqual(spendFor(readSpend(join(dir, 'missing')), P, now), { weekUsd: 0, totalUsd: 0, weekTokens: 0, sessions: 0 });
  rmSync(dir, { recursive: true, force: true });
});

test('pruneSpend deletes files untouched for a year', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cvr-spend-p-'));
  writeFileSync(join(dir, 'old.json'), '{}');
  writeFileSync(join(dir, 'new.json'), '{}');
  const old = (Date.now() - 400 * DAY) / 1000;
  utimesSync(join(dir, 'old.json'), old, old);
  pruneSpend(dir, Date.now());
  assert.deepEqual(readdirSync(dir), ['new.json']);
  pruneSpend(join(dir, 'missing'), Date.now()); // never throws
  rmSync(dir, { recursive: true, force: true });
});

test('sessionSpend uses the status-line record, else transcript tokens with no cost', () => {
  assert.deepEqual(sessionSpend({ costUsd: 2.5, tokensIn: 900, tokensOut: 100 }, { input: 1, output: 1 }),
    { costUsd: 2.5, tokensIn: 900, tokensOut: 100, source: 'statusline' });
  assert.deepEqual(sessionSpend(undefined, { input: 10, cacheRead: 20, cacheCreate: 5, output: 7 }),
    { costUsd: null, tokensIn: 35, tokensOut: 7, source: 'transcript' });
  assert.equal(sessionSpend(undefined, undefined), null);
});

test('readSpendCached re-reads only files that changed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cvr-spend-c-'));
  const put = (id, cost) => writeFileSync(join(dir, `${id}.json`), JSON.stringify({ sessionId: id, cwd: W, costUsd: cost, at: Date.now() }));
  put('a', 1);
  assert.equal(readSpendCached(dir).get('a').costUsd, 1);
  put('a', 3);
  const later = (Date.now() + 5000) / 1000;
  utimesSync(join(dir, 'a.json'), later, later);
  assert.equal(readSpendCached(dir).get('a').costUsd, 3);
  rmSync(join(dir, 'a.json'));
  assert.equal(readSpendCached(dir).size, 0);
  rmSync(dir, { recursive: true, force: true });
});
