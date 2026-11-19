// Reads Claude Code's own session registry (<claudeHome>/sessions/<pid>.json). Read-only; never throws.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename, resolve, dirname } from 'node:path';
import { claudeHome } from './paths.mjs';

const STATUSES = new Set(['busy', 'idle', 'waiting']);
const rootCache = new Map();

export function projectRoot(cwd) {
  if (!cwd) return cwd || '';
  if (rootCache.has(cwd)) return rootCache.get(cwd);
  try {
    // Walk up to the first folder holding a .git entry (a folder, or a file in worktrees). No process is run.
    let dir = resolve(cwd);
    for (;;) {
      if (existsSync(join(dir, '.git'))) { rootCache.set(cwd, dir); return dir; }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  } catch { /* fall through */ }
  return cwd; // not cached: a folder that is git-init'ed later is picked up
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
