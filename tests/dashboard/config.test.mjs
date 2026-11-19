import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../global/dashboard/lib/config.mjs';
import { claudeHome, plannotatorHome, dashHome } from '../../global/dashboard/lib/paths.mjs';

function withHome(fn) {
  const d = mkdtempSync(join(tmpdir(), 'cvr-dash-'));
  const saved = process.env.CVR_DASH_CLAUDE_HOME;
  process.env.CVR_DASH_CLAUDE_HOME = d;
  try { return fn(d); } finally {
    if (saved === undefined) delete process.env.CVR_DASH_CLAUDE_HOME; else process.env.CVR_DASH_CLAUDE_HOME = saved;
    rmSync(d, { recursive: true, force: true });
  }
}

test('loadConfig returns defaults when no file exists', () => withHome(() => {
  const c = loadConfig();
  assert.equal(c.port, 47800);
  assert.deepEqual(c.thresholds, {
    quiet: 20, hungTool: 20, apiError: 5, waiting: 5, waitingEscalate: 15,
    subagentQuiet: 20, loopCount: 6, loopWindow: 10, idleGap: 15, autoStop: 30,
  });
}));

test('loadConfig merges a partial thresholds object over defaults', () => withHome((d) => {
  mkdirSync(join(d, 'dashboard'));
  writeFileSync(join(d, 'dashboard', 'config.json'), JSON.stringify({ thresholds: { quiet: 30 } }));
  const c = loadConfig();
  assert.equal(c.thresholds.quiet, 30);
  assert.equal(c.thresholds.apiError, 5);
  assert.equal(c.port, 47800);
}));

test('loadConfig tolerates a broken config file', () => withHome((d) => {
  mkdirSync(join(d, 'dashboard'));
  writeFileSync(join(d, 'dashboard', 'config.json'), '{oops');
  assert.equal(loadConfig().port, 47800);
}));

test('paths honour the env overrides', () => withHome((d) => {
  assert.equal(claudeHome(), d);
  assert.equal(dashHome(), join(d, 'dashboard'));
  const saved = process.env.CVR_DASH_PLANNOTATOR_HOME;
  process.env.CVR_DASH_PLANNOTATOR_HOME = d;
  try { assert.equal(plannotatorHome(), d); } finally {
    if (saved === undefined) delete process.env.CVR_DASH_PLANNOTATOR_HOME; else process.env.CVR_DASH_PLANNOTATOR_HOME = saved;
  }
}));
