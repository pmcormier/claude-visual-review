// SessionStart hook: make sure the dashboard server is running. Connects to its port; if the connection is
// refused, starts server.mjs detached (no window, no stdio) and leaves. Prints nothing, always exits 0, and
// gives up after 300 ms in total. A connect that neither succeeds nor fails in time is left alone (something
// answers there, or the machine is busy: the next session start tries again).
// With --open (the Start menu shortcut and /dashboard), it also opens http://127.0.0.1:<port>/ once the server
// answers: with the VS Code opener (~/.claude/visual-review/bin/open-in-vscode.exe) if present, else the default
// browser. A person asked for this, so it waits up to 5 s for a server it just started, then opens the page anyway.
// Env: CVR_DASH_SERVER overrides the server script path (tests); CVR_DASH_PORT overrides the configured port;
// CVR_DASH_OPENER overrides the opener (tests; a .mjs opener runs under this Node).
// Child processes (R9): absolute program paths, cwd = this folder (never a project),
// NoDefaultCurrentDirectoryInExePath=1, windowsHide.
import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OPEN = process.argv.slice(2).includes('--open');
const CAP_MS = OPEN ? 5000 : 250; // the hook's 250 ms leaves room for Node's own start inside its 300 ms budget
const childEnv = { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' };

let port = null;
let opened = false;
const done = () => { if (OPEN && port && !opened) openPage(); process.exit(0); };
setTimeout(done, CAP_MS);

function envPort() {
  const n = Number(process.env.CVR_DASH_PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

function detached(file, args, extra = {}) {
  try {
    const child = spawn(file, args, { cwd: HERE, detached: true, windowsHide: true, stdio: 'ignore', env: childEnv, ...extra });
    child.on('error', () => {});
    child.unref();
  } catch { /* nothing more to try */ }
}

function startServer() {
  detached(process.execPath, [process.env.CVR_DASH_SERVER || join(HERE, 'server.mjs')]);
}

function openPage() {
  opened = true;
  const url = `http://127.0.0.1:${port}/`;
  try {
    const home = process.env.CVR_DASH_CLAUDE_HOME || join(homedir(), '.claude');
    const opener = process.env.CVR_DASH_OPENER || join(home, 'visual-review', 'bin', 'open-in-vscode.exe');
    if (existsSync(opener)) {
      if (opener.endsWith('.mjs')) detached(process.execPath, [opener, url]);
      else detached(opener, [url]);
    } else if (process.platform === 'win32') {
      // `start "" <url>` hands the URL to the default browser; the URL has no characters cmd treats specially.
      const cmd = process.env.ComSpec || join(process.env.SystemRoot || '', 'System32', 'cmd.exe');
      detached(cmd, ['/d', '/c', 'start', '""', url], { windowsVerbatimArguments: true });
    }
  } catch { /* nothing more to try */ }
}

// Resolves when something answers on the port: true on connect, false on refusal; a hang is left to the cap.
function probe() {
  return new Promise((resolve) => {
    const sock = connect({ host: '127.0.0.1', port });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', (e) => resolve(e?.code === 'ECONNREFUSED' ? false : null));
  });
}

try {
  // Imported here, not statically, so a broken or missing lib/ still ends in a silent exit 0.
  port = envPort() ?? (await import('./lib/config.mjs')).loadConfig().port;
  let up = await probe();
  if (up === false) {
    startServer();
    // Only --open waits for the server it started; the hook leaves at once.
    while (OPEN && up !== true) {
      await new Promise((r) => setTimeout(r, 100));
      up = await probe();
    }
  }
  done();
} catch { done(); }
