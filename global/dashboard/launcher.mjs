// SessionStart hook: make sure the dashboard server is running. Connects to its port; if the connection is
// refused, starts server.mjs detached (no window, no stdio) and leaves. Prints nothing, always exits 0, and
// gives up after 300 ms in total. A connect that neither succeeds nor fails in time is left alone (something
// answers there, or the machine is busy: the next session start tries again).
// Env: CVR_DASH_SERVER overrides the server script path (tests); CVR_DASH_PORT overrides the configured port.
// Child process (R9): process.execPath (absolute), cwd = this folder (never a project),
// NoDefaultCurrentDirectoryInExePath=1, windowsHide.
import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CAP_MS = 250; // leaves room for Node's own start inside the 300 ms budget

const done = () => process.exit(0);
setTimeout(done, CAP_MS);

function envPort() {
  const n = Number(process.env.CVR_DASH_PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

function startServer() {
  try {
    const child = spawn(process.execPath, [process.env.CVR_DASH_SERVER || join(HERE, 'server.mjs')], {
      cwd: HERE,
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' },
    });
    child.on('error', () => {});
    child.unref();
  } catch { /* nothing more to try */ }
}

try {
  // Imported here, not statically, so a broken or missing lib/ still ends in a silent exit 0.
  const port = envPort() ?? (await import('./lib/config.mjs')).loadConfig().port;
  const sock = connect({ host: '127.0.0.1', port });
  sock.once('connect', () => { sock.destroy(); done(); });
  sock.once('error', (e) => {
    if (e?.code === 'ECONNREFUSED') startServer();
    done();
  });
} catch { done(); }
