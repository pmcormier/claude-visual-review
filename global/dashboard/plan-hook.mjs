// PostToolUse hook (matcher Read|Edit|Write): when a session reads or edits a plan or BMAD ticket file, append
// {session, file, at} to <dashHome>/events.jsonl (outside any project). Runs on every matched tool call, so it
// imports only node built-ins and does no other work. Prints nothing and always exits 0.
// Plan file: docs/superpowers/plans/*.md. BMAD ticket file: a .md with a `_bmad-output` path segment. Either
// path separator.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const PLAN_RE = /(?:^|[\\/])docs[\\/]superpowers[\\/]plans[\\/][^\\/]+\.md$/i;
const BMAD_RE = /(?:^|[\\/])_bmad-output[\\/](?:[^\\/]+[\\/])*[^\\/]+\.md$/i;
const MAX_STDIN = 16 * 1024 * 1024; // Read and Write inputs carry the file text

// Same folder as lib/paths.mjs dashHome(), spelled out to keep this hook free of other imports.
const dash = () => join(process.env.CVR_DASH_CLAUDE_HOME || join(homedir(), '.claude'), 'dashboard');

function record(text) {
  try {
    const input = JSON.parse(text);
    const file = input?.tool_input?.file_path;
    const session = input?.session_id;
    if (typeof file !== 'string' || typeof session !== 'string' || !session) return;
    if (!PLAN_RE.test(file) && !BMAD_RE.test(file)) return;
    mkdirSync(dash(), { recursive: true });
    appendFileSync(join(dash(), 'events.jsonl'), JSON.stringify({ session, file, at: new Date().toISOString() }) + '\n');
  } catch { /* bad input or unwritable: nothing to record */ }
}

const chunks = [];
let size = 0;
let finished = false;
const finish = () => {
  if (finished) return;
  finished = true;
  record(Buffer.concat(chunks).toString('utf8'));
  process.exit(0);
};
setTimeout(finish, 2000); // stdin that never closes must not hold the tool call up
try {
  process.stdin.on('data', (c) => { size += c.length; if (size <= MAX_STDIN) chunks.push(c); });
  process.stdin.on('end', finish);
  process.stdin.on('close', finish);
  process.stdin.on('error', finish);
} catch { finish(); }
