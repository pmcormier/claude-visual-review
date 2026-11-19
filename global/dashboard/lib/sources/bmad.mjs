// BMAD tickets: runs the bmad-ticket skill's `tickets.py status` for a project that has `_bmad/` and maps its
// rows to epics (one per `epic` slug) and tasks. Never throws; any failure logs one line and returns [].
// Child processes (security ruling R9): cwd is this module's folder, never the project; the project is passed
// as --project-root; NoDefaultCurrentDirectoryInExePath=1, windowsHide, 10 s timeout, async so the server
// never blocks. python runs isolated (-I). Result is cached per root (see signature()).
import { execFile } from 'node:child_process';
import { existsSync, statSync, readdirSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeHome, dashHome } from '../paths.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const TIMEOUT_MS = 10_000;
const TTL_MS = 30_000; // directory mtimes miss edits inside nested folders, so the cache also expires

// BMAD ticket `state` -> task status. 'dropped' is hidden. 'review' is what the script reports for in-review.
const STATE = {
  planned: 'next', backlog: 'next', 'in-progress': 'doing', 'in-review': 'doing', review: 'doing', done: 'done',
};

function log(msg) {
  try {
    mkdirSync(dashHome(), { recursive: true });
    appendFileSync(join(dashHome(), 'dashboard.log'), `${new Date().toISOString()} bmad: ${String(msg).replace(/\s+/g, ' ').slice(0, 300)}\n`);
  } catch { /* logging must never throw */ }
}

function humanize(slug) {
  const t = slug.replace(/^epic-/, '').replace(/-+/g, ' ').trim() || slug;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Maps the JSON of `tickets.py status` to epics. Exported for tests. */
export function mapBmadStatus(data) {
  const byEpic = new Map();
  const rows = Array.isArray(data?.tickets) ? data.tickets : [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const status = STATE[r.state];
    if (!status) continue; // dropped or unknown
    const slug = typeof r.epic === 'string' && r.epic ? r.epic : 'tickets';
    if (!byEpic.has(slug)) byEpic.set(slug, { id: `bmad:${slug}`, source: 'bmad', title: humanize(slug), file: null, tasks: [] });
    const epic = byEpic.get(slug);
    const n = Number.isFinite(Number(r.id)) && r.id !== '' && r.id !== null ? Number(r.id) : null;
    const key = typeof r.ref === 'string' && r.ref ? r.ref : String(r.file || r.id || epic.tasks.length + 1);
    epic.tasks.push({
      id: `${epic.id}#${key}`, n, title: typeof r.title === 'string' && r.title ? r.title : key, status,
      size: typeof r.estimate === 'string' && r.estimate ? r.estimate : null,
      sessionId: null, startedMs: null, doneMs: null, ticked: null,
    });
  }
  return [...byEpic.values()];
}

function defaultCommands() {
  const script = join(claudeHome(), 'skills', 'bmad-ticket', 'scripts', 'tickets.py');
  return [
    { cmd: 'python', args: ['-I', script] },
    { cmd: 'uv', args: ['run', script] },
  ];
}

function run(cmd, args) {
  return new Promise((res, rej) => {
    execFile(cmd, args, {
      cwd: HERE, windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8',
      env: { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' },
    }, (err, stdout, stderr) => (err ? rej(Object.assign(err, { stderr })) : res(stdout)));
  });
}

const mtime = (p) => { try { return statSync(p).mtimeMs; } catch { return 0; } };

// Newest mtime among `_bmad/`, `_bmad/custom/` and a bounded walk of `_bmad-output/` (BMAD's default output
// folder). A project with another output_folder is only refreshed by the TTL.
function signature(root) {
  let max = Math.max(mtime(join(root, '_bmad')), mtime(join(root, '_bmad', 'custom')));
  let budget = 500;
  const walk = (dir, depth) => {
    max = Math.max(max, mtime(dir));
    if (depth > 4) return;
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (budget-- <= 0) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1); else max = Math.max(max, mtime(p));
    }
  };
  walk(join(root, '_bmad-output'), 0);
  return max;
}

const cache = new Map(); // resolved root -> { sig, at, epics } (failures cache [] the same way)
const inflight = new Map(); // resolved root -> Promise shared by concurrent callers
const lastLogged = new Map(); // resolved root -> last failure message written to the log

const copy = (epics) => structuredClone(epics); // callers may mutate what they get

async function fetchEpics(key, sig, opts) {
  const failures = [];
  for (const { cmd, args } of opts.commands || defaultCommands()) {
    try {
      const out = await run(cmd, [...args, '--project-root', key, 'status']);
      const epics = mapBmadStatus(JSON.parse(out));
      cache.set(key, { sig, at: Date.now(), epics });
      lastLogged.delete(key);
      return epics;
    } catch (e) {
      const why = String(e?.stderr || '').trim().split(/\r?\n/).pop();
      failures.push(`${cmd}: ${e?.code || e?.message || e}${why ? ' ' + why : ''}`);
    }
  }
  const msg = `status failed for a project: ${failures.join('; ')}`;
  if (lastLogged.get(key) !== msg) { lastLogged.set(key, msg); log(msg); }
  cache.set(key, { sig, at: Date.now(), epics: [] });
  return [];
}

/**
 * @param {string} root project root
 * @param {{commands?: {cmd: string, args: string[]}[]}} [opts] commands to try in order; each gets
 *   `--project-root <root> status` appended
 * @returns {Promise<import('../types.mjs').Epic[]>}
 */
export async function readBmad(root, opts = {}) {
  try {
    const key = resolve(String(root || ''));
    if (!existsSync(join(key, '_bmad'))) return [];
    const sig = signature(key);
    const hit = cache.get(key);
    if (hit && hit.sig === sig && Date.now() - hit.at < TTL_MS) return copy(hit.epics);
    let p = inflight.get(key);
    if (!p) {
      p = fetchEpics(key, sig, opts).finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    return copy(await p);
  } catch (e) {
    log(`unexpected: ${e?.message || e}`);
    return [];
  }
}
