// Status-line tap: records plan-usage numbers and session spend, then runs the user's original status line unchanged.
// Runs on every refresh: node built-ins only, no config load. Never throws; any error still runs the original.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, statSync } from 'node:fs';
import { join, isAbsolute, delimiter } from 'node:path';
import { dashHome } from './lib/paths.mjs';

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    const done = () => resolve(Buffer.concat(chunks));
    try {
      process.stdin.on('data', (c) => chunks.push(c));
      process.stdin.on('end', done);
      process.stdin.on('close', done); // close without end must not leave this pending
      process.stdin.on('error', done);
    } catch { done(); }
  });
}

function recordUsage(dir, input) {
  const tmp = join(dir, `usage.json.${process.pid}.tmp`);
  try {
    const rl = JSON.parse(input.toString('utf8'))?.rate_limits;
    const isObj = (v) => v && typeof v === 'object';
    if (!isObj(rl) || !(isObj(rl.five_hour) || isObj(rl.seven_day))) return;
    mkdirSync(dir, { recursive: true });
    const body = JSON.stringify({ at: Date.now(), five_hour: rl.five_hour ?? null, seven_day: rl.seven_day ?? null });
    writeFileSync(tmp, body);
    renameSync(tmp, join(dir, 'usage.json'));
  } catch {
    try { unlinkSync(tmp); } catch { /* nothing to clean */ }
  }
}

// Session spend (decision 34): Claude Code's own running cost and token totals for this session, one file per
// session so a finished session still counts after its transcript is deleted.
const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/;
function recordSpend(dir, input) {
  let tmp = null;
  try {
    const j = JSON.parse(input.toString('utf8'));
    const id = j?.session_id;
    const cost = j?.cost?.total_cost_usd;
    if (typeof id !== 'string' || !SESSION_ID.test(id) || typeof cost !== 'number' || !Number.isFinite(cost)) return;
    const sdir = join(dir, 'spend');
    const file = join(sdir, `${id}.json`);
    mkdirSync(sdir, { recursive: true });
    let firstAt = null;
    try { firstAt = JSON.parse(readFileSync(file, 'utf8'))?.firstAt ?? null; } catch { /* first refresh */ }
    const now = Date.now();
    const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const cw = j.context_window ?? {};
    const body = JSON.stringify({
      sessionId: id, cwd: typeof j.cwd === 'string' ? j.cwd : '', model: typeof j.model?.id === 'string' ? j.model.id : null,
      costUsd: cost, tokensIn: n(cw.total_input_tokens), tokensOut: n(cw.total_output_tokens),
      firstAt: typeof firstAt === 'number' ? firstAt : now, at: now,
    });
    tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, body);
    renameSync(tmp, file);
  } catch {
    if (tmp) { try { unlinkSync(tmp); } catch { /* nothing to clean */ } }
  }
}

function originalCommand(dir) {
  try {
    const cmd = JSON.parse(readFileSync(join(dir, 'statusline-original.json'), 'utf8'))?.command;
    return typeof cmd === 'string' && cmd.trim() ? cmd : null;
  } catch { return null; }
}

const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

// Windows' System32\bash.exe is the WSL launcher, not Git Bash: with no Linux installed it fails, and with one it
// runs the command in Linux. Never pick it.
const isWslLauncher = (p) => process.platform === 'win32' && /[\\/]system32[\\/]bash\.exe$/i.test(p);

// `bash` from PATH (absolute entries only), with Windows' executable extensions.
function bashOnPath() {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of String(process.env.PATH || '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    for (const e of exts) { const p = join(dir, 'bash' + e); if (isFile(p) && !isWslLauncher(p)) return p; }
  }
  return null;
}

// Run the original the way Claude Code ran this tap (R23): Claude Code starts status lines in the user's shell
// (bash on Windows when Git Bash is installed), so `~`, `$HOME`, `$(...)`, single quotes and pipes must mean
// what they meant before the tap was installed. SHELL naming an existing program wins; else a `bash` on PATH
// when the environment is Git Bash's (MSYSTEM set); else the platform shell (cmd.exe on Windows).
function shellArgs(command, env = process.env) {
  const sh = env.SHELL;
  if (typeof sh === 'string' && sh && isFile(sh)) return { file: sh, args: ['-c', command], shell: false };
  if (env.MSYSTEM) { const b = bashOnPath(); if (b) return { file: b, args: ['-c', command], shell: false }; }
  return { file: command, args: [], shell: true };
}

async function main() {
  const input = await readStdin().catch(() => Buffer.alloc(0));
  process.stdout.on('error', () => {}); // EPIPE if the reader closed early
  let command = null;
  try {
    const dir = dashHome();
    recordUsage(dir, input);
    recordSpend(dir, input);
    command = originalCommand(dir);
  } catch { /* fall through to the original, if any */ }
  if (!command) return 0;

  return new Promise((resolve) => {
    const how = shellArgs(command);
    const child = spawn(how.file, how.args, { shell: how.shell, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    child.stdout.on('data', (c) => process.stdout.write(c));
    child.stdin.on('error', () => {}); // original may exit without reading
    child.stdin.end(input);
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGBREAK']) {
      try { process.on(sig, () => { try { child.kill(); } catch { /* gone */ } }); } catch { /* unsupported here */ }
    }
    child.on('error', () => resolve(0));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

main().then((code) => { process.exitCode = code; }, () => { process.exitCode = 0; });
