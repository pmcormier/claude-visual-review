// Work log helper: node note.mjs start "<task>" [--plan <file> --task <n>] [--steps "a|b|c"]
//                  node note.mjs step <n> <todo|doing|done|waiting|dropped>
//                  node note.mjs done | drop "<reason>"
// Prints nothing and always exits 0. Errors go to <dashHome>/note.log. Writes only under <dashHome>.
import { mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const STATUSES = ['todo', 'doing', 'done', 'waiting', 'dropped'];

function logError(msg) {
  try {
    // Same folder as lib/paths.mjs dashHome(), spelled out so logging works even when lib/ is missing.
    const file = join(process.env.CVR_DASH_CLAUDE_HOME || join(homedir(), '.claude'), 'dashboard', 'note.log');
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${new Date().toISOString()} ${String(msg).replace(/\s+/g, ' ')}\n`);
  } catch { /* nowhere left to report */ }
}

function parse(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && a.length > 2) flags[a.slice(2)] = argv[++i];
    else pos.push(a);
  }
  return { pos, flags };
}

async function main() {
  const { projectRoot } = await import('./lib/sessions.mjs');
  const { worklogPath } = await import('./lib/worklog.mjs');
  const { pos, flags } = parse(process.argv.slice(2));
  const verb = pos[0];
  const rec = { v: 1, at: new Date().toISOString(), session: process.env.CLAUDE_CODE_SESSION_ID || null, verb };
  if (verb === 'start') {
    const title = pos.slice(1).join(' ').trim();
    if (!title) return logError('start: missing task text');
    rec.title = title;
    if (flags.plan) rec.plan = flags.plan;
    if (flags.task !== undefined) {
      if (/^\d+$/.test(String(flags.task).trim()) && Number(flags.task) >= 1) rec.task = Number(flags.task);
      else logError(`start: ignored --task "${flags.task}"`);
    }
    if (flags.steps) rec.steps = flags.steps.split('|').map((s) => s.trim()).filter(Boolean);
  } else if (verb === 'step') {
    const n = Number(pos[1]);
    if (!Number.isInteger(n) || n < 1) return logError(`step: bad number "${pos[1]}"`);
    if (!STATUSES.includes(pos[2])) return logError(`step: bad status "${pos[2]}"`);
    rec.n = n;
    rec.status = pos[2];
  } else if (verb === 'done') {
    // no arguments
  } else if (verb === 'drop') {
    rec.reason = pos.slice(1).join(' ').trim();
  } else {
    return logError(`unknown verb "${verb}"`);
  }
  const file = worklogPath(projectRoot(process.cwd()));
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(rec) + '\n');
}

try { await main(); } catch (e) { logError(e && e.stack ? e.stack : e); }
process.exitCode = 0;
