import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanTranscript, trackedTranscripts } from '../../global/dashboard/lib/transcripts.mjs';

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const iso = (minAgo) => new Date(NOW - minAgo * 60000).toISOString();

function withDir(fn) {
  const d = mkdtempSync(join(tmpdir(), 'cvr-dash-'));
  const saved = process.env.CVR_DASH_CLAUDE_HOME;
  process.env.CVR_DASH_CLAUDE_HOME = d;
  try { return fn(d); } finally {
    if (saved === undefined) delete process.env.CVR_DASH_CLAUDE_HOME; else process.env.CVR_DASH_CLAUDE_HOME = saved;
    rmSync(d, { recursive: true, force: true });
  }
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

// Seen live 2026-11-19: a job ended with TaskStop gets no completion note; it read "running" for a day and a half.
test('a background job stopped with TaskStop is no longer pending', () => withDir((d) => {
  const p = join(d, 't.jsonl');
  const bg = (id, job) => [
    toolUse(id, 'Bash', { command: `watch ${job}`, run_in_background: true }),
    result(id, [{ type: 'text', text: `Command running in background with ID: ${job}. Output is being written to: ${join(d, job)}.output` }]),
  ];
  writeFileSync(p, lines(
    ...bg('toolu_a', 'jobA'),
    ...bg('toolu_b', 'jobB'),
    toolUse('toolu_s', 'TaskStop', { task_id: 'jobB' }),
    result('toolu_s', [{ type: 'text', text: '{"message":"Successfully stopped task: jobB (watch jobB)"}' }]),
    toolUse('toolu_k', 'KillShell', { shell_id: 'jobA' }),
    { type: 'user', timestamp: iso(1), message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_k', is_error: true, content: 'No such shell' }] } },
  ));
  // jobB is gone; the failed KillShell leaves jobA running.
  assert.equal(scanTranscript(p, NOW).pendingTool?.command, 'watch jobA');
  appendFileSync(p, lines(
    toolUse('toolu_k2', 'KillShell', { shell_id: 'jobA' }),
    result('toolu_k2', [{ type: 'text', text: 'Shell jobA killed' }]),
  ));
  assert.equal(scanTranscript(p, NOW).pendingTool, null);
}));

// Seen live 2026-11-19: a foreground command printed a transcript excerpt quoting that message, and the dashboard
// showed it "running" for 12 hours.
test('a foreground result that quotes the background message is finished', () => withDir((d) => {
  const p = join(d, 't.jsonl');
  const quoted = 'match: "Command running in background with ID: job9. Output is being written to: x/job9.output"';
  writeFileSync(p, lines(
    toolUse('toolu_f', 'Bash', { command: 'grep background t.jsonl' }),
    result('toolu_f', [{ type: 'text', text: quoted }]),
    toolUse('toolu_g', 'Bash', { command: 'grep again', run_in_background: true }),
    result('toolu_g', [{ type: 'text', text: `found it\n${quoted}` }]),
  ));
  assert.equal(scanTranscript(p, NOW).pendingTool, null);
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

test('metadata records after an API error do not clear the error or move lastEntryMs', () => withDir((d) => {
  const p = join(d, 't.jsonl');
  writeFileSync(p, lines(
    { type: 'assistant', timestamp: iso(5), isApiErrorMessage: true, message: { content: [] } },
    { type: 'system', timestamp: iso(4) }, { type: 'queue-operation', timestamp: iso(3) },
    { type: 'queue-operation', timestamp: iso(2) }, { type: 'last-prompt', timestamp: iso(1) },
  ));
  const s = scanTranscript(p, NOW);
  assert.equal(s.lastEntryIsApiError, true);
  assert.equal(s.lastEntryMs, NOW - 5 * 60000);
  assert.equal(s.minutes[59 - 1], 1); // metadata still counts as activity
}));

test('a shrunk and rewritten file does not carry tokens or seen ids over', () => withDir((d) => {
  const p = join(d, 't.jsonl');
  const usage = { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const a = (req, pad = '') => ({ type: 'assistant', timestamp: iso(1), requestId: req, message: { usage, content: [{ type: 'text', text: 'x' + pad }] } });
  writeFileSync(p, lines(a('r1', 'y'.repeat(200)), a('r2')));
  assert.equal(scanTranscript(p, NOW).tokens.input, 10);
  writeFileSync(p, lines(a('r1')));
  assert.deepEqual(scanTranscript(p, NOW).tokens, { input: 5, output: 7, cacheRead: 0, cacheCreate: 0 });
}));

test('explicit thresholds override the config', () => withDir((d) => {
  const p = join(d, 't.jsonl');
  writeFileSync(p, lines(...[8, 7].map((m, i) => toolUse('toolu_' + i, 'Bash', { command: 'ls' }, m))));
  assert.equal(scanTranscript(p, NOW, { loopWindow: 5 }).repeat, null);
  assert.equal(scanTranscript(p, NOW, { loopWindow: 10 }).repeat.count, 2);
}));

const notif = (id, status = 'completed') => `<task-notification> <task-id>job1</task-id> <tool-use-id>${id}</tool-use-id> <output-file>x.output</output-file> <status>${status}</status> <summary>done</summary> </task-notification>`;
const bgStart = (out) => lines(
  toolUse('toolu_b', 'Bash', { command: 'npm run watch', run_in_background: true }, 30),
  result('toolu_b', [{ type: 'text', text: `Command running in background with ID: job1. Output is being written to: ${out}.` }], 30),
);

test('background job notification (queue-operation) clears the pending tool', () => withDir((d) => {
  const p = join(d, 't.jsonl');
  writeFileSync(p, bgStart(join(d, 'job1.output')));
  assert.equal(scanTranscript(p, NOW).pendingTool.outputFile, join(d, 'job1.output'));
  appendFileSync(p, lines(
    { type: 'queue-operation', operation: 'enqueue', timestamp: iso(5), content: notif('toolu_b', 'failed') },
    { type: 'attachment', timestamp: iso(5), attachment: { type: 'queued_command', prompt: notif('toolu_b', 'failed') } },
  ));
  assert.equal(scanTranscript(p, NOW).pendingTool, null);
}));

test('the attachment form alone also clears the pending tool', () => withDir((d) => {
  const p = join(d, 't.jsonl');
  writeFileSync(p, bgStart(join(d, 'job1.output')));
  appendFileSync(p, lines({ type: 'attachment', timestamp: iso(5), attachment: { type: 'queued_command', prompt: notif('toolu_b') } }));
  assert.equal(scanTranscript(p, NOW).pendingTool, null);
}));

test('a notification for another tool id leaves the pending tool alone', () => withDir((d) => {
  const p = join(d, 't.jsonl');
  writeFileSync(p, bgStart(join(d, 'job1.output')));
  appendFileSync(p, lines({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(5), content: notif('toolu_other') }));
  assert.equal(scanTranscript(p, NOW).pendingTool.name, 'Bash');
}));

test('plan and BMAD paths match in any case, like the plan hook', () => withDir((d) => {
  const p = join(d, 't.jsonl');
  const plan = ['X:', 'Work', 'Docs', 'SuperPowers', 'Plans', 'Checkout.MD'].join(String.fromCharCode(92));
  const ticket = 'work/_BMAD-output/tickets/T-1.Md';
  writeFileSync(p, lines(toolUse('t1', 'Read', { file_path: plan }, 3), toolUse('t2', 'Read', { file_path: ticket }, 2)));
  assert.deepEqual(scanTranscript(p, NOW).planRefs.map((r) => r.file), [plan, ticket]);
}));

test('transcripts not scanned for an hour are forgotten', () => withDir((d) => {
  const a = join(d, 'a.jsonl');
  const b = join(d, 'b.jsonl');
  writeFileSync(a, lines(toolUse('x', 'Read', { file_path: 'f' }, 1)));
  writeFileSync(b, lines(toolUse('y', 'Read', { file_path: 'f' }, 1)));
  const later = NOW + 30 * 86400000; // after every other test's scans
  scanTranscript(a, later);
  scanTranscript(b, later + 90 * 60000);
  assert.equal(trackedTranscripts(), 1);
}));

test('title prefers the newest custom title over ai titles, and survives an incremental scan', () => withDir((d) => {
  const f = join(d, 't.jsonl');
  writeFileSync(f, lines(
    { type: 'ai-title', aiTitle: 'First guess', sessionId: 's' },
    { type: 'custom-title', customTitle: 'Named by me', sessionId: 's' },
    { type: 'ai-title', aiTitle: 'Later guess', sessionId: 's' },
  ));
  assert.equal(scanTranscript(f, NOW).title, 'Named by me');
  appendFileSync(f, lines({ type: 'user', timestamp: iso(1), message: { content: 'hi' } }));
  assert.equal(scanTranscript(f, NOW).title, 'Named by me');
  appendFileSync(f, lines({ type: 'custom-title', customTitle: 'Renamed', sessionId: 's' }));
  assert.equal(scanTranscript(f, NOW).title, 'Renamed');
}));

test('title falls back to the newest ai title, and is null without one', () => withDir((d) => {
  const f = join(d, 't.jsonl');
  writeFileSync(f, lines({ type: 'ai-title', aiTitle: 'Login bug', sessionId: 's' }, { type: 'ai-title', aiTitle: 'Login bug again', sessionId: 's' }));
  assert.equal(scanTranscript(f, NOW).title, 'Login bug again');
  const g = join(d, 'u.jsonl');
  writeFileSync(g, lines({ type: 'user', timestamp: iso(1), message: { content: 'hi' } }));
  assert.equal(scanTranscript(g, NOW).title, null);
}));

test('a pending tool keeps its description, trimmed; empty reads null', () => withDir((d) => {
  const f = join(d, 't.jsonl');
  writeFileSync(f, lines(toolUse('a', 'Bash', { command: 'gh run watch 1', description: ' Watch CI ' })));
  assert.equal(scanTranscript(f, NOW).pendingTool.description, 'Watch CI');
  const g = join(d, 'u.jsonl');
  writeFileSync(g, lines(toolUse('b', 'Bash', { command: 'ls', description: '  ' })));
  assert.equal(scanTranscript(g, NOW).pendingTool.description, null);
  const h = join(d, 'v.jsonl');
  writeFileSync(h, lines(toolUse('c', 'Read', { file_path: 'x' })));
  assert.equal(scanTranscript(h, NOW).pendingTool.description, null);
}));

test('a long description is clipped at the source, so stall evidence stays short', () => withDir((d) => {
  const f = join(d, 'long.jsonl');
  writeFileSync(f, lines(toolUse('a', 'Bash', { command: 'x', description: 'w'.repeat(1000) })));
  const desc = scanTranscript(f, NOW).pendingTool.description;
  assert.equal(desc.length, 200);
  assert.ok(desc.endsWith('…'));
}));

// Needs-you (2026-11-19): a question left to the owner.
const say = (text, minAgo = 1) => ({ type: 'assistant', timestamp: iso(minAgo), message: { content: [{ type: 'text', text }] } });

test('lastAsk: a closing question is kept; a later tool call or user reply clears it', () => withDir((d) => {
  const f = join(d, 'ask.jsonl');
  writeFileSync(f, lines(say('Done the build.\nShould I merge it?', 2)));
  assert.deepEqual(scanTranscript(f, NOW).lastAsk, { text: 'Should I merge it?', ms: NOW - 2 * 60000 });
  appendFileSync(f, lines(toolUse('t1', 'Bash', { command: 'ls' })));
  assert.equal(scanTranscript(f, NOW).lastAsk, null);
  const g = join(d, 'ask2.jsonl');
  writeFileSync(g, lines(say('Merge it?'), { type: 'user', timestamp: iso(0), message: { content: 'yes' } }));
  assert.equal(scanTranscript(g, NOW).lastAsk, null);
  const h = join(d, 'ask3.jsonl');
  writeFileSync(h, lines(say('All done.')));
  assert.equal(scanTranscript(h, NOW).lastAsk, null);
}));

test('an AskUserQuestion call keeps its first question as the description', () => withDir((d) => {
  const f = join(d, 'auq.jsonl');
  writeFileSync(f, lines(toolUse('q1', 'AskUserQuestion', { questions: [{ question: 'Which way?' }, { question: 'Other' }] })));
  assert.equal(scanTranscript(f, NOW).pendingTool.description, 'Which way?');
}));

test('a watcher started after a job never becomes the pending tool', () => withDir((d) => {
  const p = join(d, 't.jsonl');
  const out = join(d, 'job1.output');
  writeFileSync(p, bgStart(out) + lines(
    toolUse('toolu_w', 'Bash', { command: `node ~/.claude/dashboard/watch.mjs --file "${out}" --what "CI"`, run_in_background: true }, 29),
    result('toolu_w', [{ type: 'text', text: `Command running in background with ID: job2. Output is being written to: ${join(d, 'job2.output')}.` }], 29),
  ));
  assert.equal(scanTranscript(p, NOW).pendingTool.command, 'npm run watch');
}));

test('every running tool is listed, oldest first, watchers left out', () => withDir((d) => {
  const p = join(d, 't.jsonl');
  writeFileSync(p, lines(
    toolUse('toolu_a', 'Bash', { command: 'npm test', description: 'Run the tests' }, 3),
    toolUse('toolu_b', 'Bash', { command: 'node ~/.claude/dashboard/watch.mjs --file x' }, 2),
    toolUse('toolu_c', 'Read', { file_path: 'docs/x.md' }, 1),
  ));
  const s = scanTranscript(p, NOW);
  assert.deepEqual(s.pendingTools.map((t) => t.name), ['Bash', 'Read']);
  assert.equal(s.pendingTools[0].description, 'Run the tests');
  appendFileSync(p, lines(result('toolu_a', 'ok'), result('toolu_c', 'ok')));
  assert.deepEqual(scanTranscript(p, NOW).pendingTools, []);
}));
