// Where the dashboard reads and writes. Env overrides exist for tests, which never touch the real folders.
import { homedir } from 'node:os';
import { join } from 'node:path';

export function claudeHome() {
  return process.env.CVR_DASH_CLAUDE_HOME || join(homedir(), '.claude');
}

export function plannotatorHome() {
  return process.env.CVR_DASH_PLANNOTATOR_HOME || join(homedir(), '.plannotator');
}

export function dashHome() {
  return join(claudeHome(), 'dashboard');
}
