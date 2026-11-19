// /dashboard catch-up helper: lists a project's plans from before the dashboard that carry no `Status:` line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const HELPER = resolve(here, '../../global/dashboard/catchup.mjs');
const OLD = '2026-01-10T10:00:00Z';

function world() {
  const base = mkdtempSync(join(tmpdir(), 'cvr-catchup-'));
  const claude = join(base, 'claude');
  mkdirSync(join(claude, 'dashboard'), { recursive: true });
  const root = join(base, 'web-shop');
  mkdirSync(join(root, 'docs', 'superpowers', 'plans'), { recursive: true });
  return { base, claude, root };
}

function git(root, args, iso) {
  return execFileSync('git', ['-C', root, '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, ...(iso ? { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso } : {}) },
  });
}

function plan(root, name, text, iso) {
  const f = join(root, 'docs', 'superpowers', 'plans', name);
  writeFileSync(f, text);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '--no-verify', '-m', `add ${name}`], iso);
  if (iso) utimesSync(f, new Date(iso), new Date(iso));
}

function repo(root) {
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Test User']);
  git(root, ['config', 'user.email', 'tester']);
}

function run(w, dir, installedAt) {
  if (installedAt) writeFileSync(join(w.claude, 'dashboard', 'installed.json'), JSON.stringify({ installedAt }));
  const r = spawnSync(process.execPath, [HELPER, dir], { encoding: 'utf8', env: { ...process.env, CVR_DASH_CLAUDE_HOME: w.claude } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('catchup lists plans from before the install without a Status line', () => {
  const w = world();
  try {
    repo(w.root);
    plan(w.root, 'a.md', '# Checkout plan\n\n### Task 1: Cart\n- [x] s\n- [ ] t\n', OLD);
    plan(w.root, 'b.md', '# Coupons plan\n\n### Task 1: Codes\n- [ ] s\n', null); // added now, after the install
    const out = run(w, w.root, '2026-06-01T00:00:00Z');
    assert.equal(out.installedAt, '2026-06-01T00:00:00.000Z');
    assert.deepEqual(out.plans.map((p) => p.title), ['Checkout plan']);
    assert.deepEqual(out.plans[0].ticked, { done: 1, total: 2 });
    assert.ok(out.plans[0].file.endsWith('a.md'));
    assert.equal(typeof out.plans[0].addedMs, 'number');
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('catchup skips plans with Status', () => {
  const w = world();
  try {
    repo(w.root);
    plan(w.root, 'a.md', '# Old plan\nStatus: done\n\n### Task 1: x\n- [ ] s\n', OLD);
    plan(w.root, 'c.md', '# Other old plan\n\n### Task 1: x\n- [ ] s\n', OLD);
    const out = run(w, w.root, '2026-06-01T00:00:00Z');
    assert.deepEqual(out.plans.map((p) => p.title), ['Other old plan']);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('catchup with no install date lists every unmarked plan', () => {
  const w = world();
  try {
    repo(w.root);
    plan(w.root, 'a.md', '# Old plan\n\n### Task 1: x\n- [ ] s\n', OLD);
    plan(w.root, 'b.md', '# New plan\n\n### Task 1: x\n- [ ] s\n', null);
    const out = run(w, w.root, null);
    assert.equal(out.installedAt, null);
    assert.deepEqual(out.plans.map((p) => p.title).sort(), ['New plan', 'Old plan']);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('catchup in a folder that is not a repo prints an empty list', () => {
  const w = world();
  try {
    const out = run(w, join(w.base, 'claude'), '2026-06-01T00:00:00Z');
    assert.deepEqual(out.plans, []);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});
