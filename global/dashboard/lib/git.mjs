// A project's commits (its whole history, newest first, up to MAX_COUNT), read with `git log` (read-only). Never throws; any failure logs one line and
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

// Variables inherited from the server's environment that would point git at another repo, object store or
// namespace, or inject config, are dropped.
const DROP_ENV = new Set([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CEILING_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
]);
const DROP_PREFIX = /^GIT_CONFIG_(KEY|VALUE)_/;
function childEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    const K = k.toUpperCase();
    if (!DROP_ENV.has(K) && !DROP_PREFIX.test(K)) env[k] = v;
  }
  return { ...env, NoDefaultCurrentDirectoryInExePath: '1', GIT_TERMINAL_PROMPT: '0' };
}

function run(args) {
  return new Promise((res, rej) => {
    execFile('git', args, {
      cwd: HERE, windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8',
      env: childEnv(),
    }, (err, stdout, stderr) => (err ? rej(Object.assign(err, { stderr })) : res(stdout)));
  });
}

/**
 * Parses `git log --format=%x1e%H%x1f%ct%x1f%B%x1f --name-status` output. Exported for tests.
 * files: every path a commit lists (both sides of a rename or copy). added: paths whose status is `A`, a real
 * add, which is what dates a plan's birth.
 */
export function parseLog(out) {
  const commits = [];
  for (const rec of String(out).split(RS)) {
    const parts = rec.split(US);
    if (parts.length < 4) continue;
    const sha = parts[0].trim();
    const ct = Number(parts[1]);
    if (!/^[0-9a-f]{7,64}$/i.test(sha) || !Number.isFinite(ct)) continue;
    const message = parts.slice(2, -1).join(US).replace(/\s+$/, '');
    const files = [];
    const added = [];
    for (const line of parts[parts.length - 1].split(/\r?\n/)) {
      const cols = line.split('\t');
      if (cols.length < 2 || !/^[A-Z]/.test(cols[0])) continue;
      const paths = cols.slice(1).map((f) => f.trim()).filter(Boolean);
      files.push(...paths);
      if (cols[0] === 'A' && paths.length) added.push(paths[0]);
    }
    commits.push({ sha, ms: ct * 1000, message, files, added });
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

const copy = (list, sinceMs) => list.filter((c) => c.ms >= sinceMs).map((c) => ({ ...c, files: [...c.files], added: [...c.added] }));

async function fetchCommits(key, sig, sinceMs) {
  try {
    const out = await run([
      '--no-pager', '-c', 'core.fsmonitor=', '-c', 'core.quotepath=off', '-c', 'log.showSignature=false',
      '-C', key, 'log', ...(sinceMs > 0 ? [`--since=${new Date(sinceMs).toISOString()}`] : []), `--max-count=${MAX_COUNT}`,
      '--no-color', '--name-status', `--format=${RS}%H${US}%ct${US}%B${US}`,
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
 * @param {number} [sinceMs] only commits whose committer time is at or after this (default 0: the whole history)
 * @returns {Promise<{sha: string, ms: number, message: string, files: string[], added: string[]}[]>} newest first
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
