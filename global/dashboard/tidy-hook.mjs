// Stop hook (decision 37): when a session ends a turn with a work-log step still marked doing, nothing watched and
// no question to the owner, it asks the session once to bring its log up to date ({"decision":"block"}). The same
// state is never reminded twice. Prints nothing otherwise and always exits 0. Writes only under <dashHome>/tidy/.
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dashHome } from './lib/paths.mjs';
import { projectRoot } from './lib/sessions.mjs';
import { openEntryFor } from './lib/worklog.mjs';
import { readMarkers, isLive } from './lib/watch.mjs';
import { tidyDecision, askingAtEnd } from './lib/tidy.mjs';

const TAIL_BYTES = 64 * 1024;

function logError(msg) {
  try {
    mkdirSync(dashHome(), { recursive: true });
    appendFileSync(join(dashHome(), 'tidy.log'), `${new Date().toISOString()} ${String(msg).replace(/\s+/g, ' ')}\n`);
  } catch { /* nowhere left to report */ }
}

function tailLines(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split(/\r?\n/);
    if (len < size) lines.shift(); // the first line is cut
    return lines.filter(Boolean);
  } catch { return []; } finally { if (fd !== undefined) closeSync(fd); }
}

function run(text) {
  const input = JSON.parse(text);
  const session = typeof input?.session_id === 'string' && input.session_id ? input.session_id : null;
  if (!session || typeof input.cwd !== 'string') return;
  const entry = openEntryFor(projectRoot(input.cwd), session);
  if (!entry?.doing.length) return;
  const stateFile = join(dashHome(), 'tidy', `${session.replace(/[^A-Za-z0-9-]/g, '-')}.json`);
  let lastState = null;
  try { lastState = JSON.parse(readFileSync(stateFile, 'utf8'))?.state ?? null; } catch { /* first time */ }
  const now = Date.now();
  const d = tidyDecision({
    entry,
    live: readMarkers(session).some((m) => isLive(m, now)),
    asking: typeof input.transcript_path === 'string' ? askingAtEnd(tailLines(input.transcript_path)) : false,
    stopActive: input.stop_hook_active === true,
    lastState,
  });
  if (!d.remind) return;
  mkdirSync(join(dashHome(), 'tidy'), { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ state: d.state, at: new Date(now).toISOString() }));
  process.stdout.write(JSON.stringify({ decision: 'block', reason: d.remind }));
}

const chunks = [];
let finished = false;
const finish = () => {
  if (finished) return;
  finished = true;
  try { run(Buffer.concat(chunks).toString('utf8')); } catch (e) { if (!(e instanceof SyntaxError)) logError(e?.stack || e); }
  process.exit(0);
};
setTimeout(finish, 2000); // stdin that never closes must not hold the session up
try {
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', finish);
  process.stdin.on('close', finish);
  process.stdin.on('error', finish);
} catch { finish(); }
