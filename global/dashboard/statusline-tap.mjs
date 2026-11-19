// Status-line tap: records plan-usage numbers, then runs the user's original status line unchanged.
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
