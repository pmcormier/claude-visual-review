import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSessions, projectRoot, transcriptPathFor } from '../../global/dashboard/lib/sessions.mjs';

function withHome(fn) {
  const d = mkdtempSync(join(tmpdir(), 'cvr-dash-'));
  const saved = process.env.CVR_DASH_CLAUDE_HOME;
  process.env.CVR_DASH_CLAUDE_HOME = d;
  mkdirSync(join(d, 'sessions'));
  try { return fn(d); } finally {
    if (saved === undefined) delete process.env.CVR_DASH_CLAUDE_HOME; else process.env.CVR_DASH_CLAUDE_HOME = saved;
    rmSync(d, { recursive: true, force: true });
  }
}

function rec(over = {}) {
  return {
    pid: 4242, sessionId: 'aaaa-1111', cwd: join(tmpdir(), 'cvr-no-such-dir', 'web-shop'),
    startedAt: 1794926121170, procStart: '134393997204242343', version: '2.1.326',
    kind: 'interactive', entrypoint: 'cli', name: 'checkout work', nameSource: 'user',
    updatedAt: 1795057975025, status: 'busy', statusUpdatedAt: 1795057975025, ...over,
  };
}
const put = (d, file, obj) => writeFileSync(join(d, 'sessions', file), typeof obj === 'string' ? obj : JSON.stringify(obj));

test('reads busy/idle/waiting from registry files', () => withHome((d) => {
  put(d, '1.json', rec({ pid: 1, sessionId: 's1', status: 'busy' }));
  put(d, '2.json', rec({ pid: 2, sessionId: 's2', status: 'idle' }));
  put(d, '3.json', rec({ pid: 3, sessionId: 's3', status: 'waiting' }));
  put(d, '3.abcdef.key', 'not json');
  put(d, '4.json', '{broken');
  const got = readSessions().sort((a, b) => a.pid - b.pid);
  assert.deepEqual(got.map((s) => [s.pid, s.status]), [[1, 'busy'], [2, 'idle'], [3, 'waiting']]);
  const s = got[0];
  assert.equal(s.sessionId, 's1');
  assert.equal(s.procStart, '134393997204242343');
  assert.equal(s.name, 'checkout work');
  assert.equal(s.statusUpdatedAt, 1795057975025);
  assert.equal(s.project, 'web-shop');
  assert.equal(s.transcriptPath, transcriptPathFor(s.cwd, 's1'));
}));

test("unknown status value becomes 'unknown'", () => withHome((d) => {
  put(d, '1.json', rec({ status: 'dancing' }));
  assert.equal(readSessions()[0].status, 'unknown');
}));

test('missing fields do not throw', () => withHome((d) => {
  put(d, '9.json', { pid: 9 });
  put(d, '10.json', {});
  put(d, '11.json', 'null');
  const got = readSessions();
  assert.equal(got.length, 2); // 'null' file skipped; {} and {pid} yield records
  const s = got.find((x) => x.pid === 9);
  assert.equal(s.status, 'unknown');
  assert.equal(s.statusUpdatedAt, null);
  assert.equal(s.transcriptPath, null);
  assert.equal(s.sessionId, null);
}));

test('readSessions returns [] when the sessions folder is missing', () => withHome((d) => {
  rmSync(join(d, 'sessions'), { recursive: true });
  assert.deepEqual(readSessions(), []);
}));

test('transcriptPathFor encodes a cwd of drive X, folder work, folder web-shop as X--work-web-shop', () => withHome((d) => {
  const bs = '\\';
  assert.equal(transcriptPathFor(['X:', 'work', 'web-shop'].join(bs), 'abc'), join(d, 'projects', 'X--work-web-shop', 'abc.jsonl'));
  assert.equal(transcriptPathFor(['C:', 'Users', 'x', '.claude', 'skills'].join(bs), 'q'), join(d, 'projects', 'C--Users-x--claude-skills', 'q.jsonl'));
}));

test('projectRoot falls back to cwd when missing or empty', () => {
  const missing = join(tmpdir(), 'cvr-no-such-dir', 'billing-api');
  const got = projectRoot(missing);
  assert.ok(got === missing || existsSync(join(got, '.git')));
  assert.equal(projectRoot(''), '');
});

test('projectRoot walks up to a .git folder', () => {
  const t = mkdtempSync(join(tmpdir(), 'cvr-dash-'));
  try {
    mkdirSync(join(t, 'repo', '.git'), { recursive: true });
    mkdirSync(join(t, 'repo', 'a', 'b'), { recursive: true });
    assert.equal(projectRoot(join(t, 'repo', 'a', 'b')), join(t, 'repo'));
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('projectRoot treats a .git file (worktree) as a root', () => {
  const t = mkdtempSync(join(tmpdir(), 'cvr-dash-'));
  try {
    mkdirSync(join(t, 'wt', 'src'), { recursive: true });
    writeFileSync(join(t, 'wt', '.git'), 'gitdir: elsewhere');
    assert.equal(projectRoot(join(t, 'wt', 'src')), join(t, 'wt'));
  } finally { rmSync(t, { recursive: true, force: true }); }
});

test('projectRoot returns the cwd or a real repo ancestor when no .git is in the temp tree, and does not cache a fallback', () => {
  const t = mkdtempSync(join(tmpdir(), 'cvr-dash-'));
  try {
    const got = projectRoot(t);
    assert.ok(got === t || existsSync(join(got, '.git')));
    if (got === t) {
      mkdirSync(join(t, '.git'));
      assert.equal(projectRoot(t), t);
    }
  } finally { rmSync(t, { recursive: true, force: true }); }
});
