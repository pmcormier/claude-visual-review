// Recent commits of a project, read with `git log` (read-only). Never throws; any failure logs one line and
// returns [].
// Child processes (security ruling R9): cwd is this module's folder, never the project; the project is passed
// with -C; NoDefaultCurrentDirectoryInExePath=1, windowsHide, 10 s timeout, async so the server never blocks;
// core.fsmonitor is emptied so a repo's config cannot make git start another program.
// Cache per root: reused while HEAD, the branch ref HEAD points to, refs/heads and packed-refs keep their
// mtimes AND the entry is younger than 30 s (the TTL covers worktrees and ref layouts the mtimes miss).
import { execFile } from 'node:child_process';
import { existsSync, statSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dashHome } from './paths.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const TIMEOUT_MS = 10_000;
const TTL_MS = 30_000;
const MAX_COUNT = 2000;
const RS = '\x1e';
const US = '\x1f';

function log(msg) {
  try {
    mkdirSync(dashHome(), { recursive: true });
    appendFileSync(join(dashHome(), 'dashboard.log'), `${new Date().toISOString()} git: ${String(msg).replace(/\s+/g, ' ').slice(0, 300)}\n`);
  } catch { /* logging must never throw */ }
}

function run(args) {
  return new Promise((res, rej) => {
    execFile('git', args, {
      cwd: HERE, windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8',
      env: { ...process.env, NoDefaultCurrentDirectoryInExePath: '1', GIT_TERMINAL_PROMPT: '0' },
    }, (err, stdout, stderr) => (err ? rej(Object.assign(err, { stderr })) : res(stdout)));
  });
}

/** Parses `git log --format=%x1e%H%x1f%ct%x1f%B%x1f --name-only` output. Exported for tests. */
export function parseLog(out) {
  const commits = [];
  for (const rec of String(out).split(RS)) {
    const parts = rec.split(US);
    if (parts.length < 4) continue;
    const sha = parts[0].trim();
    const ct = Number(parts[1]);
    if (!/^[0-9a-f]{7,64}$/i.test(sha) || !Number.isFinite(ct)) continue;
    const message = parts.slice(2, -1).join(US).replace(/\s+$/, '');
    const files = parts[parts.length - 1].split(/\r?\n/).map((f) => f.trim()).filter(Boolean);
    commits.push({ sha, ms: ct * 1000, message, files });
  }
  return commits;
}

const mtime = (p) => { try { return statSync(p).mtimeMs; } catch { return 0; } };

function gitDir(root) {
  const dot = join(root, '.git');
  try {
    if (statSync(dot).isDirectory()) return dot;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dot, 'utf8')); // worktree or submodule
    if (m) return isAbsolute(m[1]) ? m[1] : resolve(root, m[1]);
  } catch { /* fall through */ }
  return null;
}

function signature(dir) {
  let ref = 0;
  try {
    const m = /^ref:\s*(\S+)/.exec(readFileSync(join(dir, 'HEAD'), 'utf8'));
    if (m) ref = mtime(join(dir, ...m[1].split('/')));
  } catch { /* detached or unreadable */ }
  return [mtime(join(dir, 'HEAD')), ref, mtime(join(dir, 'refs', 'heads')), mtime(join(dir, 'packed-refs'))].join(':');
}

const cache = new Map(); // resolved root -> { sig, at, since, commits }
const inflight = new Map(); // resolved root + since -> Promise
const lastLogged = new Map(); // resolved root -> last failure message written to the log

function fail(key, msg) {
  if (lastLogged.get(key) !== msg) { lastLogged.set(key, msg); log(msg); }
}

const copy = (list, sinceMs) => list.filter((c) => c.ms >= sinceMs).map((c) => ({ ...c, files: [...c.files] }));

async function fetchCommits(key, sig, sinceMs) {
  try {
    const out = await run([
      '--no-pager', '-c', 'core.fsmonitor=', '-c', 'core.quotepath=off', '-c', 'log.showSignature=false',
      '-C', key, 'log', `--since=${new Date(sinceMs).toISOString()}`, `--max-count=${MAX_COUNT}`,
      '--no-color', '--name-only', `--format=${RS}%H${US}%ct${US}%B${US}`,
    ]);
    const commits = parseLog(out);
    cache.set(key, { sig, at: Date.now(), since: sinceMs, commits });
    lastLogged.delete(key);
    return commits;
  } catch (e) {
    const why = String(e?.stderr || '').trim().split(/\r?\n/).pop();
    fail(key, `log failed for a project: ${e?.killed ? 'timeout' : e?.code || e?.message || e}${why ? ' ' + why : ''}`);
    cache.set(key, { sig, at: Date.now(), since: sinceMs, commits: [] });
    return [];
  }
}

/**
 * @param {string} root project root (git top-level)
 * @param {number} sinceMs only commits whose committer time is at or after this
 * @returns {Promise<{sha: string, ms: number, message: string, files: string[]}[]>} newest first
 */
export async function readCommits(root, sinceMs = 0) {
  try {
    const key = resolve(String(root || ''));
    const since = Number.isFinite(sinceMs) ? Math.max(0, sinceMs) : 0;
    const dir = existsSync(join(key, '.git')) ? gitDir(key) : null;
    if (!dir) { fail(key, 'not a git repository'); return []; }
    const sig = signature(dir);
    const hit = cache.get(key);
    if (hit && hit.sig === sig && Date.now() - hit.at < TTL_MS && hit.since <= since) return copy(hit.commits, since);
    const fk = `${key}\u0000${since}`;
    let p = inflight.get(fk);
    if (!p) {
      p = fetchCommits(key, sig, since).finally(() => inflight.delete(fk));
      inflight.set(fk, p);
    }
    return copy(await p, since);
  } catch (e) {
    log(`unexpected: ${e?.message || e}`);
    return [];
  }
}
