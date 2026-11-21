import { test } from 'node:test';
import assert from 'node:assert/strict';

const { focusSession, FOCUS_TEXT } = await import('../../global/dashboard/lib/focus.mjs');

const model = { projects: [{ root: 'work/shop', sessions: [
  { sessionId: 'aaaa-1', pid: 101, alive: true, title: 'Fix the cart', cwd: 'work/shop' },
  { sessionId: 'bbbb-2', pid: 102, alive: false, title: 'Old one', cwd: 'work/shop' },
] }] };

test('focusSession: only a live session the dashboard lists; its pid, title and folder go to the helper as values', async () => {
  const calls = [];
  const run = async (args) => { calls.push(args); return { result: 'front', host: 'WindowsTerminal' }; };
  assert.deepEqual(await focusSession(model, 'aaaa-1', run), { ok: true, text: FOCUS_TEXT.front });
  assert.deepEqual(calls, [{ pid: 101, title: 'Fix the cart', folder: 'work/shop' }]);
  assert.deepEqual(await focusSession(model, 'bbbb-2', run), { ok: false, text: FOCUS_TEXT.gone });
  assert.deepEqual(await focusSession(model, 'zzzz', run), { ok: false, text: FOCUS_TEXT.gone });
  assert.deepEqual(await focusSession(model, { x: 1 }, run), { ok: false, text: FOCUS_TEXT.gone });
  assert.equal(calls.length, 1, 'nothing runs for a session it does not list');
});

test('focusSession: each helper result in plain words; a failing helper never throws', async () => {
  const say = async (r) => (await focusSession(model, 'aaaa-1', async () => r)).text;
  assert.equal(await say({ result: 'dup' }), 'Window up, but two tabs share this title');
  assert.equal(await say({ result: 'nowindow' }), "Couldn't find its window");
  assert.equal(await say({ result: 'window', host: 'Code' }), 'Brought its VS Code window to the front');
  assert.equal(await say({ result: 'flash' }), 'Windows only flashed it in the taskbar');
  assert.equal(await say({ result: 'weird' }), "Couldn't find its window");
  assert.equal((await focusSession(model, 'aaaa-1', async () => { throw new Error('boom'); })).text, "Couldn't find its window");
  assert.equal(await say({ result: 'front' }), 'Brought to the front');
});
