// Reads Claude Code's own session registry (<claudeHome>/sessions/<pid>.json). Read-only; never throws.
import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename, resolve } from 'node:path';
import { claudeHome } from './paths.mjs';

const STATUSES = new Set(['busy', 'idle', 'waiting']);
const rootCache = new Map();

export function projectRoot(cwd) {
  if (!cwd) return cwd || '';
  if (rootCache.has(cwd)) return rootCache.get(cwd);
  let root = cwd;
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
    }).toString().trim();
    if (out) root = resolve(out); // git prints forward slashes; resolve gives the platform form
  } catch { /* missing dir, not a repo, or no git */ }
  rootCache.set(cwd, root);
  return root;
}

export function transcriptPathFor(cwd, sessionId) {
  return join(claudeHome(), 'projects', String(cwd).replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`);
}

function toInfo(r) {
  if (!r || typeof r !== 'object') return null;
  const cwd = typeof r.cwd === 'string' ? r.cwd : null;
  const sessionId = typeof r.sessionId === 'string' ? r.sessionId : null;
  return {
    sessionId,
    pid: Number.isFinite(r.pid) ? r.pid : null,
    procStart: r.procStart == null ? null : String(r.procStart),
    cwd,
    name: typeof r.name === 'string' ? r.name : null,
    status: STATUSES.has(r.status) ? r.status : 'unknown',
    statusUpdatedAt: Number.isFinite(r.statusUpdatedAt) ? r.statusUpdatedAt : null,
    transcriptPath: cwd && sessionId ? transcriptPathFor(cwd, sessionId) : null,
    project: cwd ? basename(projectRoot(cwd)) : '',
  };
}

export function readSessions() {
  let files;
  try { files = readdirSync(join(claudeHome(), 'sessions')); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const info = toInfo(JSON.parse(readFileSync(join(claudeHome(), 'sessions', f), 'utf8')));
      if (info) out.push(info);
    } catch { /* unparsable or unreadable: skip */ }
  }
  return out;
}
