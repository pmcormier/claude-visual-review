// End-of-turn tidy-up (plan 2026-11-20 dashboard heartbeat, Task 3): a Stop hook reminds a session once when its
// work log says a step is "doing" while nothing is watched and it isn't asking the owner. Never the real ~/.claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const home = mkdtempSync(join(tmpdir(), 'cvr-tidy-'));
process.env.CVR_DASH_CLAUDE_HOME = home;
const { openEntryFor, worklogPath } = await import('../../global/dashboard/lib/worklog.mjs');
const { tidyDecision, askingAtEnd, reminderText } = await import('../../global/dashboard/lib/tidy.mjs');
const { writeMarker } = await import('../../global/dashboard/lib/watch.mjs');
const HOOK = fileURLToPath(new URL('../../global/dashboard/tidy-hook.mjs', import.meta.url));

const root = mkdtempSync(join(tmpdir(), 'cvr-tidy-proj-'));
let n = 0;
const at = () => new Date(Date.UTC(2026, 10, 20, 10, 0, n++)).toISOString();
function log(rec) {
  const p = worklogPath(root);
  mkdirSync(join(home, 'dashboard', 'worklog'), { recursive: true });
  appendFileSync(p, JSON.stringify({ v: 1, at: at(), ...rec }) + '\n');
}

test('openEntryFor: the session\'s open entry and its doing steps', () => {
  log({ session: 'a', verb: 'start', title: 'Ship it', steps: ['Plan', 'Build', 'Test'] });
  log({ session: 'a', verb: 'step', n: 1, status: 'done' });
  log({ session: 'a', verb: 'step', n: 2, status: 'doing' });
  log({ session: 'b', verb: 'start', title: 'Other', steps: ['X'] });
  log({ session: 'b', verb: 'step', n: 1, status: 'doing' });
  const a = openEntryFor(root, 'a');
  assert.deepEqual({ title: a.title, doing: a.doing }, { title: 'Ship it', doing: [{ n: 2, name: 'Build' }] });
  assert.match(a.startedAt, /^2026-11-20T/);
  assert.equal(openEntryFor(root, 'b').title, 'Other');
  assert.equal(openEntryFor(root, 'nobody'), null);
  log({ session: 'b', verb: 'done' });
  assert.equal(openEntryFor(root, 'b'), null);
  log({ session: 'b', verb: 'start', title: 'Chat', steps: [] });
  assert.deepEqual(openEntryFor(root, 'b').doing, []);
});

const entry = { title: 'Ship it', startedAt: '2026-11-20T10:00:00.000Z', doing: [{ n: 2, name: 'Build' }] };
const base = { entry, live: false, asking: false, stopActive: false, lastState: null };

test('tidyDecision: reminds with the spec text', () => {
  const r = tidyDecision(base);
  assert.equal(r.remind, reminderText(entry));
  assert.equal(r.remind, 'Work-log check: "Ship it" still has step 2 "Build" marked doing, and no job is being watched. If it\'s finished, mark it done (and your Inbox checklist). If it waits on the owner, mark it waiting. If a job is running, start a watcher for it. If it\'s right as it is, say nothing and end the turn.');
  assert.equal(r.state, '2026-11-20T10:00:00.000Z|Ship it|2:Build');
});

test('tidyDecision: no reminder when watched, asking, chained, already reminded, or nothing doing', () => {
  assert.equal(tidyDecision({ ...base, live: true }).remind, null);
  assert.equal(tidyDecision({ ...base, asking: true }).remind, null);
  assert.equal(tidyDecision({ ...base, stopActive: true }).remind, null);
  assert.equal(tidyDecision({ ...base, lastState: '2026-11-20T10:00:00.000Z|Ship it|2:Build' }).remind, null);
  assert.equal(tidyDecision({ ...base, entry: { title: 'Chat', doing: [] } }).remind, null);
  assert.equal(tidyDecision({ ...base, entry: null }).remind, null);
});

const L = (o) => JSON.stringify(o);
const text = (t) => L({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
const use = (name, id = 'tu1') => L({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: {} }] } });
const result = (id = 'tu1') => L({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id }] } });

test('askingAtEnd', () => {
  assert.equal(askingAtEnd([text('Which way should I go?')]), true);
  assert.equal(askingAtEnd([text('Which way?'), use('Bash')]), false);
  assert.equal(askingAtEnd([text('Done.')]), false);
  assert.equal(askingAtEnd([use('AskUserQuestion', 'q1')]), true);
  assert.equal(askingAtEnd([use('AskUserQuestion', 'q1'), result('q1'), text('Thanks.')]), false);
  assert.equal(askingAtEnd(['not json', text('Ok?')]), true);
});

function hook(body) {
  return spawnSync(process.execPath, [HOOK], { input: JSON.stringify(body), env: { ...process.env, CVR_DASH_CLAUDE_HOME: home }, encoding: 'utf8' });
}

test('hook: missing transcript or work log means no output, exit 0', () => {
  const r = hook({ session_id: 'ghost', cwd: join(root, 'nowhere'), transcript_path: join(root, 'missing.jsonl'), stop_hook_active: false });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  const bad = spawnSync(process.execPath, [HOOK], { input: '{not json', env: { ...process.env, CVR_DASH_CLAUDE_HOME: home }, encoding: 'utf8' });
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout, '');
});

test('hook: reminds once, then stays quiet for the same state', () => {
  const tr = join(root, 'tr.jsonl');
  writeFileSync(tr, text('Build started.') + '\n');
  const body = { session_id: 'a', cwd: root, transcript_path: tr, stop_hook_active: false };
  const r1 = hook(body);
  assert.equal(r1.status, 0);
  const out = JSON.parse(r1.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /^Work-log check: "Ship it" still has step 2 "Build"/);
  assert.equal(hook(body).stdout, '');
});

test('hook: a live watcher means no reminder', () => {
  log({ session: 'c', verb: 'start', title: 'CI', steps: ['Watch'] });
  log({ session: 'c', verb: 'step', n: 1, status: 'doing' });
  const tr = join(root, 'tr-c.jsonl');
  writeFileSync(tr, text('Watching CI.') + '\n');
  const now = Date.now();
  writeMarker({ session: 'c', file: 'work/c/tasks/j.output', what: 'CI', startedAt: now, beatAt: now, lastGrowthAt: now, size: 0, quietMin: 15, exited: null });
  assert.equal(hook({ session_id: 'c', cwd: root, transcript_path: tr, stop_hook_active: false }).stdout, '');
});

test('hook: an unreadable transcript means no reminder, even with a doing step', () => {
  log({ session: 'd', verb: 'start', title: 'Docs', steps: ['Write'] });
  log({ session: 'd', verb: 'step', n: 1, status: 'doing' });
  const r = hook({ session_id: 'd', cwd: root, transcript_path: join(root, 'gone-d.jsonl'), stop_hook_active: false });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('tidyDecision: a new entry with the same title and steps is reminded again', () => {
  const first = tidyDecision(base);
  const again = tidyDecision({ ...base, entry: { ...entry, startedAt: '2026-11-20T12:00:00.000Z' }, lastState: first.state });
  assert.equal(again.remind, reminderText(entry));
});
