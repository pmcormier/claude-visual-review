import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanTranscript } from '../../global/dashboard/lib/transcripts.mjs';

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const iso = (minAgo) => new Date(NOW - minAgo * 60000).toISOString();

function withDir(fn) {
  const d = mkdtempSync(join(tmpdir(), 'cvr-dash-'));
  try { return fn(d); } finally { rmSync(d, { recursive: true, force: true }); }
}
const lines = (...objs) => objs.map((o) => JSON.stringify(o) + '\n').join('');
const toolUse = (id, name, input, minAgo = 1, extra = {}) => ({
  type: 'assistant', timestamp: iso(minAgo), requestId: 'req-' + id,
  message: { content: [{ type: 'tool_use', id, name, input }], ...extra },
});
const result = (id, content, minAgo = 1) => ({
  type: 'user', timestamp: iso(minAgo),
  message: { content: [{ type: 'tool_result', tool_use_id: id, content }] },
});

test('pending tool detected until its result arrives', () => withDir((d) => {
  const p = join(d, 't.jsonl');
  writeFileSync(p, lines(toolUse('toolu_1', 'Bash', { command: 'npm test' }, 2)));
  const s = scanTranscript(p, NOW);
  assert.equal(s.pendingTool.name, 'Bash');
  assert.equal(s.pendingTool.command, 'npm test');
  assert.equal(s.pendingTool.startedMs, NOW - 2 * 60000);
  assert.equal(s.pendingTool.outputFile, null);
  appendFileSync(p, lines(result('toolu_1', 'ok')));
  assert.equal(scanTranscript(p, NOW).pendingTool, null);
}));

test('background bash stays pending with its output file', () => withDir((d) => {
  const p = join(d, 't.jsonl');
  const out = join(d, 'job1.output');
  writeFileSync(p, lines(
    toolUse('toolu_b', 'Bash', { command: 'npm run watch', run_in_background: true }),
    result('toolu_b', [{ type: 'text', text: `Command running in background with ID: job1. Output is being written to: ${out}.` }]),
  ));
  const s = scanTranscript(p, NOW);
  assert.equal(s.pendingTool.outputFile, out);
}));

test('api error as last entry', () => withDir((d) => {
  const p = join(d, 't.jsonl');
  writeFileSync(p, lines({ type: 'user', timestamp: iso(3), message: { content: 'hello' } },
    { type: 'assistant', timestamp: iso(2), isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'API Error' }] } }));
  const s = scanTranscript(p, NOW);
  assert.equal(s.lastEntryIsApiError, true);
  assert.equal(s.lastEntryMs, NOW - 2 * 60000);
  appendFileSync(p, lines({ type: 'user', timestamp: iso(1), message: { content: 'retry' } }));
  assert.equal(scanTranscript(p, NOW).lastEntryIsApiError, false);
}));

test('tokens summed from message.usage, once per requestId', () => withDir((d) => {
  const p = join(d, 't.jsonl');
  const usage = { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 10 };
  const a = (id, req) => ({ type: 'assistant', timestamp: iso(1), requestId: req, message: { id, usage, content: [{ type: 'text', text: 'x' }] } });
  writeFileSync(p, lines(a('m1', 'r1'), a('m1', 'r1'), a('m2', 'r2')));
  assert.deepEqual(scanTranscript(p, NOW).tokens, { input: 4, output: 20, cacheRead: 100, cacheCreate: 200 });
}));

test('six identical commands in ten minutes gives repeat count 6', () => withDir((d) => {
  const p = join(d, 't.jsonl');
  const es = [];
  for (let i = 0; i < 6; i++) es.push(toolUse('toolu_r' + i, 'Bash', { command: 'npm test' }, 6 - i));
  es.push(toolUse('toolu_o', 'Bash', { command: 'ls' }, 1));
  writeFileSync(p, lines(...es));
  assert.deepEqual(scanTranscript(p, NOW).repeat, { command: 'npm test', count: 6 });
}));

test('identical commands outside the loop window do not count', () => withDir((d) => {
  const p = join(d, 't.jsonl');
  writeFileSync(p, lines(...[30, 25, 20].map((m, i) => toolUse('toolu_' + i, 'Bash', { command: 'npm test' }, m))));
  assert.equal(scanTranscript(p, NOW).repeat, null);
}));

test('plan file read recorded in planRefs, plus BMAD ticket and task refs', () => withDir((d) => {
  const p = join(d, 't.jsonl');
  const plan = ['X:', 'work', 'web-shop', 'docs', 'superpowers', 'plans', 'checkout.md'].join(String.fromCharCode(92));
  const ticket = ['work', 'billing-api', '_bmad-output', 'tickets', 'T-1.md'].join('/');
  writeFileSync(p, lines(
    toolUse('toolu_1', 'Read', { file_path: plan }, 4),
    toolUse('toolu_2', 'Edit', { file_path: ticket, old_string: 'a', new_string: 'b' }, 3),
    toolUse('toolu_3', 'Read', { file_path: 'src/index.js' }, 2),
    { type: 'assistant', timestamp: iso(1), requestId: 'r9', message: { content: [{ type: 'text', text: 'Starting Task 7 now' }] } },
  ));
  const s = scanTranscript(p, NOW);
  assert.deepEqual(s.planRefs, [{ file: plan, ms: NOW - 4 * 60000 }, { file: ticket, ms: NOW - 3 * 60000 }]);
  assert.deepEqual(s.taskRefs, [{ n: 7, ms: NOW - 60000 }]);
}));

test('partial last line ignored then picked up', () => withDir((d) => {
  const p = join(d, 't.jsonl');
  const full = JSON.stringify(toolUse('toolu_1', 'Bash', { command: 'make' }, 1));
  writeFileSync(p, full.slice(0, 30));
  assert.equal(scanTranscript(p, NOW).pendingTool, null);
  writeFileSync(p, full + '\n');
  assert.equal(scanTranscript(p, NOW).pendingTool.command, 'make');
}));

test('minutes marks activity, index 59 is the minute of now', () => withDir((d) => {
  const p = join(d, 't.jsonl');
  writeFileSync(p, lines({ type: 'user', timestamp: iso(0), message: { content: 'a' } }, { type: 'user', timestamp: iso(5), message: { content: 'b' } }, { type: 'user', timestamp: iso(90), message: { content: 'c' } }));
  const m = scanTranscript(p, NOW).minutes;
  assert.equal(m.length, 60);
  assert.equal(m[59], 1);
  assert.equal(m[54], 1);
  assert.equal(m.reduce((a, b) => a + b, 0), 2);
}));

test('missing file and non-object lines do not throw', () => withDir((d) => {
  const s = scanTranscript(join(d, 'nope.jsonl'), NOW);
  assert.equal(s.lastWriteMs, null);
  assert.equal(s.pendingTool, null);
  assert.equal(s.repeat, null);
  assert.deepEqual(s.tokens, { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
  const p = join(d, 'x.jsonl');
  writeFileSync(p, 'null\n42\n"s"\n{"type":"assistant"}\n');
  assert.equal(scanTranscript(p, NOW).pendingTool, null);
}));
