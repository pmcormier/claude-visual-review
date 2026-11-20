import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../../global/dashboard/lib/stall.mjs';

const MIN = 60000;
const T = { quiet: 20, hungTool: 20, apiError: 5, waiting: 5, waitingEscalate: 15, subagentQuiet: 20, loopCount: 6, loopWindow: 10 };
const now = 10_000_000_000;
const ago = (m) => now - m * MIN;

function sig(over = {}) {
  return { lastWriteMs: ago(1), minutes: [], pendingTool: null, lastEntryIsApiError: false, lastEntryMs: ago(1), tokens: 0, repeat: null, planRefs: [], taskRefs: [], ...over };
}
function inp(over = {}) {
  return { kind: 'session', status: 'busy', alive: true, signals: sig(), cpuPct: 0, outputIdleMs: null, finished: null, now, ...over };
}
const tool = (m, over = {}) => ({ name: 'Bash', command: 'pytest -x tests', startedMs: ago(m), outputFile: null, ...over });

test('busy build with CPU and no output for 60 min is working', () => {
  const r = classify(inp({ signals: sig({ lastWriteMs: ago(60), pendingTool: tool(70, { command: 'make all' }) }), cpuPct: 85, outputIdleMs: 60 * MIN }), T);
  assert.equal(r.state, 'working');
  assert.equal(r.evidence, null);
});

test('tool pending, 0% CPU, no output 31 min is stuck with evidence', () => {
  const r = classify(inp({ signals: sig({ lastWriteMs: ago(31), pendingTool: tool(52) }), cpuPct: 0 }), T);
  assert.equal(r.state, 'stuck');
  assert.equal(r.evidence, 'pytest running 52 min · 0% CPU · no output for 31 min');
  assert.equal(r.since, ago(52));
});

test('api error last entry 6 min ago is stuck', () => {
  const r = classify(inp({ signals: sig({ lastEntryIsApiError: true, lastEntryMs: ago(6) }) }), T);
  assert.equal(r.state, 'stuck');
  assert.equal(r.evidence, 'Last reply was an API error 6 min ago');
  assert.equal(r.since, ago(6));
  const fresh = classify(inp({ signals: sig({ lastEntryIsApiError: true, lastEntryMs: ago(2) }) }), T);
  assert.notEqual(fresh.state, 'stuck');
});

test('waiting 10 min is waiting with permission evidence', () => {
  const r = classify(inp({ status: 'waiting', statusUpdatedAt: ago(10) }), T);
  assert.equal(r.state, 'waiting');
  assert.equal(r.evidence, 'Permission prompt open for 10 min in a terminal');
  assert.equal(r.since, ago(10));
  const early = classify(inp({ status: 'waiting', statusUpdatedAt: ago(1) }), T);
  assert.equal(early.state, 'waiting');
  assert.equal(early.evidence, null);
});

test('subagent not finished and stale 48 min is stuck', () => {
  const r = classify(inp({ kind: 'subagent', status: null, cpuPct: null, signals: sig({ lastWriteMs: ago(48) }) }), T);
  assert.equal(r.state, 'stuck');
  assert.equal(r.evidence, 'Not marked finished · transcript unchanged for 48 min');
  assert.equal(r.since, ago(48));
});

test('finished subagent is idle', () => {
  const r = classify(inp({ kind: 'subagent', status: null, finished: true, signals: sig({ lastWriteMs: ago(48) }) }), T);
  assert.equal(r.state, 'idle');
});

test('dead pid with pending tool is gone', () => {
  const r = classify(inp({ alive: false, signals: sig({ pendingTool: tool(3) }) }), T);
  assert.equal(r.state, 'gone');
  assert.ok(r.evidence.includes('pytest'));
  const none = classify(inp({ alive: false }), T);
  assert.equal(none.state, 'gone');
  assert.equal(none.evidence, null);
});

test('idle status is idle', () => {
  const r = classify(inp({ status: 'idle', signals: sig({ lastWriteMs: ago(120) }) }), T);
  assert.equal(r.state, 'idle');
  assert.equal(r.evidence, null);
});

test('loop gives hint but stays working', () => {
  const r = classify(inp({ signals: sig({ repeat: { command: 'npm test', count: 7 } }) }), T);
  assert.equal(r.state, 'working');
  assert.equal(r.hint, 'Repeated npm test 7× in 10 min');
  const few = classify(inp({ signals: sig({ repeat: { command: 'npm test', count: 3 } }) }), T);
  assert.equal(few.hint, null);
});

test('unknown CPU alone never makes a tool stuck', () => {
  const r = classify(inp({ cpuPct: null, signals: sig({ lastWriteMs: ago(2), pendingTool: tool(52) }) }), T);
  assert.equal(r.state, 'working');
});

test('unknown CPU with no output and no transcript write is stuck, saying CPU unknown', () => {
  const r = classify(inp({ cpuPct: null, signals: sig({ lastWriteMs: ago(40), pendingTool: tool(52) }) }), T);
  assert.equal(r.state, 'stuck');
  assert.equal(r.evidence, 'pytest running 52 min · CPU unknown · no output for 40 min');
});

test('unknown CPU: quiet rule rests on the transcript, not the CPU', () => {
  const r = classify(inp({ cpuPct: null, signals: sig({ lastWriteMs: ago(30) }) }), T);
  assert.equal(r.state, 'stuck');
  assert.equal(r.evidence, 'No activity for 30 min while busy');
  assert.equal(classify(inp({ cpuPct: null, signals: sig({ lastWriteMs: ago(3) }) }), T).state, 'working');
});

test('quiet busy session with CPU is working; with 0% CPU is stuck', () => {
  assert.equal(classify(inp({ cpuPct: 30, signals: sig({ lastWriteMs: ago(30) }) }), T).state, 'working');
  assert.equal(classify(inp({ cpuPct: 0, signals: sig({ lastWriteMs: ago(30) }) }), T).state, 'stuck');
});

test('background job whose output keeps growing is working, however old', () => {
  const t = tool(300, { command: 'npm run watch', outputFile: 'bg-out.txt' });
  const r = classify(inp({ cpuPct: 0, outputIdleMs: 1 * MIN, signals: sig({ lastWriteMs: ago(100), pendingTool: t }) }), T);
  assert.equal(r.state, 'working');
});

test('background job with no output and 0% CPU is stuck; idle session is not judged', () => {
  const t = tool(300, { command: 'npm run watch', outputFile: 'bg-out.txt' });
  const s = sig({ lastWriteMs: ago(100), pendingTool: t });
  const r = classify(inp({ cpuPct: 0, outputIdleMs: 40 * MIN, signals: s }), T);
  assert.equal(r.state, 'stuck');
  assert.equal(r.evidence, 'npm running 300 min · 0% CPU · no output for 40 min');
  assert.equal(classify(inp({ status: 'idle', cpuPct: 0, outputIdleMs: 40 * MIN, signals: s }), T).state, 'idle');
});

test('busy session writing its transcript is never stuck on a quiet background job (R27)', () => {
  const t = tool(45, { command: 'npm run dev', outputFile: 'bg-out.txt' });
  const live = classify(inp({ cpuPct: 0, outputIdleMs: 25 * MIN, signals: sig({ lastWriteMs: now - 5000, pendingTool: t }) }), T);
  assert.equal(live.state, 'working');
  const quiet = classify(inp({ cpuPct: 0, outputIdleMs: 25 * MIN, signals: sig({ lastWriteMs: ago(25), pendingTool: t }) }), T);
  assert.equal(quiet.state, 'stuck');
  assert.equal(quiet.evidence, 'npm running 45 min · 0% CPU · no output for 25 min');
  const unknown = classify(inp({ cpuPct: 0, outputIdleMs: 25 * MIN, signals: sig({ lastWriteMs: null, pendingTool: t }) }), T);
  assert.equal(unknown.state, 'working');
});

test('unknown tool CPU falls back to transcript quiet', () => {
  const t = tool(25, { name: 'mcp__x__long', command: null });
  assert.equal(classify(inp({ cpuPct: null, signals: sig({ lastWriteMs: ago(1), pendingTool: t }) }), T).state, 'working');
  const r = classify(inp({ cpuPct: null, signals: sig({ lastWriteMs: ago(25), pendingTool: t }) }), T);
  assert.equal(r.state, 'stuck');
  assert.equal(r.evidence, 'mcp__x__long running 25 min · CPU unknown · no output for 25 min');
});

test('evidence names the tool when there is no command', () => {
  const r = classify(inp({ signals: sig({ lastWriteMs: ago(31), pendingTool: tool(52, { name: 'WebFetch', command: null }) }) }), T);
  assert.equal(r.evidence, 'WebFetch running 52 min · 0% CPU · no output for 31 min');
});

test('precedence: gone > waiting > api error > hung tool > quiet', () => {
  const hung = sig({ pendingTool: tool(52), lastEntryIsApiError: true, lastEntryMs: ago(10), lastWriteMs: ago(40) });
  assert.equal(classify(inp({ alive: false, status: 'waiting', signals: hung }), T).state, 'gone');
  assert.equal(classify(inp({ status: 'waiting', statusUpdatedAt: ago(9), signals: hung }), T).state, 'waiting');
  assert.match(classify(inp({ signals: hung }), T).evidence, /^Last reply was an API error/);
  const noErr = sig({ pendingTool: tool(52), lastWriteMs: ago(40) });
  assert.match(classify(inp({ signals: noErr }), T).evidence, /^pytest running/);
});

test('a pending Agent call for 60 min with 0% CPU stays working', () => {
  const r = classify(inp({ cpuPct: 0, signals: sig({ lastWriteMs: ago(50), pendingTool: tool(60, { name: 'Agent', command: null }) }) }), T);
  assert.equal(r.state, 'working');
  assert.equal(classify(inp({ cpuPct: 0, signals: sig({ lastWriteMs: ago(50), pendingTool: tool(60, { name: 'Task', command: null }) }) }), T).state, 'working');
});

test('foreground WebFetch: recent transcript write is working, quiet 25 min is stuck (M = 25)', () => {
  const wf = tool(60, { name: 'WebFetch', command: null });
  assert.equal(classify(inp({ cpuPct: 0, signals: sig({ lastWriteMs: ago(2), pendingTool: wf }) }), T).state, 'working');
  const r = classify(inp({ cpuPct: 0, signals: sig({ lastWriteMs: ago(25), pendingTool: wf }) }), T);
  assert.equal(r.state, 'stuck');
  assert.equal(r.evidence, 'WebFetch running 60 min · 0% CPU · no output for 25 min');
});

test('foreground tool with no lastWriteMs and no outputIdleMs is never stuck', () => {
  const r = classify(inp({ cpuPct: 0, signals: sig({ lastWriteMs: null, pendingTool: tool(60) }) }), T);
  assert.equal(r.state, 'working');
});

test('idle session with a stale foreground tool is idle', () => {
  const r = classify(inp({ status: 'idle', cpuPct: 0, signals: sig({ lastWriteMs: ago(60), pendingTool: tool(60) }) }), T);
  assert.equal(r.state, 'idle');
});

test('known outputIdleMs is clamped to the tool age', () => {
  const t = tool(25, { command: 'npm run watch', outputFile: 'bg-out.txt' });
  const r = classify(inp({ cpuPct: 0, outputIdleMs: 90 * MIN, signals: sig({ lastWriteMs: ago(30), pendingTool: t }) }), T);
  assert.equal(r.state, 'stuck');
  assert.equal(r.evidence, 'npm running 25 min · 0% CPU · no output for 25 min');
});

test('CPU rounding boundary: 0.4% is stuck and reads 0%; 0.5% is working', () => {
  const s = sig({ lastWriteMs: ago(30), pendingTool: tool(52) });
  const low = classify(inp({ cpuPct: 0.4, signals: s }), T);
  assert.equal(low.state, 'stuck');
  assert.match(low.evidence, /· 0% CPU ·/);
  assert.equal(classify(inp({ cpuPct: 0.5, signals: s }), T).state, 'working');
});

test("status 'unknown': working while the transcript moves, idle once it is quiet", () => {
  assert.equal(classify(inp({ status: 'unknown', signals: sig({ lastWriteMs: ago(3) }) }), T).state, 'working');
  assert.equal(classify(inp({ status: 'unknown', signals: sig({ lastWriteMs: ago(30) }) }), T).state, 'idle');
});

// Review fixes (2026-11-19): a tool is named by Claude's own description of it.
test('stuck and gone evidence name the tool by its description', () => {
  const desc = "Watch the fix PR's CI run to the end";
  const fg = classify(inp({ signals: sig({ lastWriteMs: ago(31), pendingTool: tool(52, { description: desc }) }), cpuPct: 0 }), T);
  assert.equal(fg.evidence, `"${desc}" running 52 min · 0% CPU · no output for 31 min`);
  const t = tool(300, { command: 'sleep 20; gh run watch 1', outputFile: 'bg-out.txt', description: desc });
  const bg = classify(inp({ cpuPct: null, outputIdleMs: 40 * MIN, signals: sig({ lastWriteMs: ago(100), pendingTool: t }) }), T);
  assert.equal(bg.state, 'stuck');
  assert.equal(bg.evidence, `Background job quiet for 40 min, still running: ${desc}. It may be waiting on something outside, such as a CI run or a download.`);
  const gone = classify(inp({ alive: false, signals: sig({ pendingTool: tool(3, { description: desc }) }) }), T);
  assert.equal(gone.evidence, `"${desc}" was still running when the process ended`);
});
