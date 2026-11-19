// Status-line tap: records plan-usage numbers, then runs the user's original status line unchanged.
// Runs on every refresh: node built-ins only, no config load. Never throws; any error still runs the original.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { dashHome } from './lib/paths.mjs';

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
    process.stdin.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

function recordUsage(dir, input) {
  const tmp = join(dir, `usage.json.${process.pid}.tmp`);
  try {
    const rl = JSON.parse(input.toString('utf8'))?.rate_limits;
    if (!rl || typeof rl !== 'object') return;
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

async function main() {
  const input = await readStdin();
  let command = null;
  try {
    const dir = dashHome();
    recordUsage(dir, input);
    command = originalCommand(dir);
  } catch { /* fall through to the original, if any */ }
  if (!command) return 0;

  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'inherit'] });
    child.stdout.on('data', (c) => process.stdout.write(c));
    child.stdin.on('error', () => {}); // original may exit without reading
    child.stdin.end(input);
    child.on('error', () => resolve(0));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

main().then((code) => { process.exitCode = code; }, () => { process.exitCode = 0; });
