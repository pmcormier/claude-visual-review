import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSubagents } from '../../global/dashboard/lib/subagents.mjs';

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
const entry = (minAgo) => JSON.stringify({ type: 'assistant', timestamp: iso(minAgo), message: { content: [] } }) + '\n';

function layout(d) {
  const transcript = join(d, 'web-shop-session.jsonl');
  writeFileSync(transcript, entry(1));
  const sub = join(d, 'web-shop-session', 'subagents');
  mkdirSync(sub, { recursive: true });
  return { transcript, sub };
}

test('reads description/model/finished from meta', () => withDir((d) => {
  const { transcript, sub } = layout(d);
  writeFileSync(join(sub, 'agent-a1.jsonl'), entry(2));
  writeFileSync(join(sub, 'agent-a1.meta.json'), JSON.stringify({ description: 'Review billing-api', model: 'sonnet', effort: 'high', finished: true }));
  writeFileSync(join(sub, 'agent-a2.jsonl'), entry(1));
  writeFileSync(join(sub, 'agent-a2.meta.json'), JSON.stringify({ description: 'Running one', model: 'opus' }));
  const list = readSubagents(transcript, NOW);
  const a1 = list.find((s) => s.agentId === 'a1');
  assert.equal(a1.description, 'Review billing-api');
  assert.equal(a1.model, 'sonnet');
  assert.equal(a1.effort, 'high');
  assert.equal(a1.finished, true);
  const a2 = list.find((s) => s.agentId === 'a2');
  assert.equal(a2.finished, null);
  assert.equal(a2.effort, null);
}));

test('missing meta gives description Subagent', () => withDir((d) => {
  const { transcript, sub } = layout(d);
  writeFileSync(join(sub, 'agent-b1.jsonl'), entry(1));
  writeFileSync(join(sub, 'agent-b2.jsonl'), entry(1));
  writeFileSync(join(sub, 'agent-b2.meta.json'), '{not json');
  for (const s of readSubagents(transcript, NOW)) {
    assert.equal(s.description, 'Subagent');
    assert.equal(s.model, null);
    assert.equal(s.effort, null);
    assert.equal(s.finished, null);
  }
}));

test("minutes from the subagent's own transcript", () => withDir((d) => {
  const { transcript, sub } = layout(d);
  const p = join(sub, 'agent-c1.jsonl');
  writeFileSync(p, entry(0) + entry(5));
  const [s] = readSubagents(transcript, NOW);
  assert.equal(s.minutes.length, 60);
  assert.equal(s.minutes[59], 1);
  assert.equal(s.minutes[54], 1);
  assert.equal(s.minutes[53], 0);
  assert.equal(typeof s.lastWriteMs, 'number');
  assert.equal(s.signals.lastWriteMs, s.lastWriteMs);
}));

test('missing folder gives empty list; orphan meta kept; newest first', () => withDir((d) => {
  const transcript = join(d, 'billing-api.jsonl');
  assert.deepEqual(readSubagents(transcript, NOW), []);
  const sub = join(d, 'billing-api', 'subagents');
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, 'agent-old.jsonl'), entry(30));
  utimesSync(join(sub, 'agent-old.jsonl'), new Date(NOW - 1800000), new Date(NOW - 1800000));
  writeFileSync(join(sub, 'agent-new.jsonl'), entry(1));
  utimesSync(join(sub, 'agent-new.jsonl'), new Date(NOW - 60000), new Date(NOW - 60000));
  writeFileSync(join(sub, 'agent-orphan.meta.json'), JSON.stringify({ description: 'No transcript yet' }));
  const list = readSubagents(transcript, NOW);
  assert.deepEqual(list.map((s) => s.agentId), ['new', 'old', 'orphan']);
  assert.equal(list[2].lastWriteMs, null);
  assert.equal(list[2].description, 'No transcript yet');
  assert.equal(list[2].minutes.length, 60);
}));

test('cache reuses a dormant subagent for a minute and always re-reads an active one', () => {
  const d = mkdtempSync(join(tmpdir(), 'cvr-dash-'));
  try {
    const t = Date.now();
    const parent = join(d, 'sess.jsonl');
    const dir = join(d, 'sess', 'subagents');
    mkdirSync(dir, { recursive: true });
    const write = (id, minAgo, desc) => {
      const f = join(dir, `agent-${id}.jsonl`);
      writeFileSync(f, JSON.stringify({ type: 'user', timestamp: new Date(t - minAgo * 60000).toISOString(), message: { content: 'x' } }) + '\n');
      utimesSync(f, new Date(t - minAgo * 60000), new Date(t - minAgo * 60000));
      writeFileSync(join(dir, `agent-${id}.meta.json`), JSON.stringify({ description: desc }));
    };
    write('old', 120, 'old v1');
    write('new', 1, 'new v1');
    const cache = new Map();
    const th = { loopWindow: 10 };
    readSubagents(parent, t, th, { cache });
    write('old', 120, 'old v2');
    write('new', 1, 'new v2');
    const desc = (list) => Object.fromEntries(list.map((a) => [a.agentId, a.description]));
    assert.deepEqual(desc(readSubagents(parent, t + 30000, th, { cache })), { old: 'old v1', new: 'new v2' });
    assert.deepEqual(desc(readSubagents(parent, t + 61000, th, { cache })), { old: 'old v2', new: 'new v2' });
    assert.deepEqual(desc(readSubagents(parent, t + 30000, th)), { old: 'old v2', new: 'new v2' }); // no cache: always read
  } finally { rmSync(d, { recursive: true, force: true }); }
});
