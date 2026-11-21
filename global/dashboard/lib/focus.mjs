// "Bring to front" (decision 49): find a session's window from its process and raise it; in Windows Terminal, select
// the tab named after the session first. The work is done by focus.ps1, which gets the pid, title and folder as
// separate arguments (never pasted into a command line), and only for a live session the dashboard lists.
import { execFile } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', 'focus.ps1');
const TIMEOUT_MS = 8000;

export const FOCUS_TEXT = Object.freeze({
  front: 'Brought to the front',
  code: 'Brought its VS Code window to the front',
  window: 'Brought its window to the front',
  dup: 'Window up, but two tabs share this title',
  flash: 'Windows only flashed it in the taskbar',
  nowindow: "Couldn't find its window",
  gone: "That session isn't open any more",
});

/** Runs focus.ps1 and returns its JSON line ({result, host}); rejects on any failure. */
export function runFocusScript({ pid, title, folder }) {
  return new Promise((resolve, reject) => {
    execFile('pwsh', ['-NoProfile', '-NonInteractive', '-File', SCRIPT, '-ProcessId', String(pid), '-Title', String(title ?? ''), '-Folder', String(folder ?? '')],
      { timeout: TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
        if (err) { reject(err); return; }
        try { resolve(JSON.parse(String(stdout).trim().split(/\r?\n/).pop())); } catch (e) { reject(e); }
      });
  });
}

/**
 * Brings a listed, live session's window to the front. Never throws.
 * @returns {Promise<{ok: boolean, text: string}>}
 */
export async function focusSession(model, sessionId, run = runFocusScript) {
  if (typeof sessionId !== 'string' || !sessionId) return { ok: false, text: FOCUS_TEXT.gone };
  const s = (Array.isArray(model?.projects) ? model.projects : []).flatMap((p) => (Array.isArray(p?.sessions) ? p.sessions : []))
    .find((x) => x?.sessionId === sessionId && x.alive === true && Number.isInteger(x.pid));
  if (!s) return { ok: false, text: FOCUS_TEXT.gone };
  let r;
  try { r = await run({ pid: s.pid, title: s.title ?? '', folder: s.cwd ?? '' }); } catch { r = null; }
  const key = r?.result === 'window' && r.host === 'Code' ? 'code' : r?.result;
  const text = key && Object.hasOwn(FOCUS_TEXT, key) && key !== 'gone' ? FOCUS_TEXT[key] : FOCUS_TEXT.nowindow;
  return { ok: ['front', 'code', 'window', 'dup'].includes(key), text };
}
