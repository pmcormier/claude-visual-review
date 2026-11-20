// The heartbeat watcher's logic (decision 37). judge() is pure: given the watcher's state and one poll of the job's
// output file, it says whether to wake the session and with which line. Markers in <dashHome>/watch/ record that a
// session is watching a job; the dashboard and the Stop hook read them. Never throws.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dashHome } from './paths.mjs';

const MIN = 60000;
export const DEFAULT_QUIET_MIN = 15;
export const POLL_MS = 15000;
export const BEAT_MS = MIN;
export const LIVE_MS = 3 * MIN;
export const ENDED_GRACE_MS = 2 * MIN;
const KEEP_MS = 7 * 86400000;
const EXITED_RE = /^\[exited with code (-?\d+)\]$/;

const clip = (s, n = 200) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Command-line flags: --file <path> --what <text> [--quiet <5..120>]. */
export function parseArgs(argv) {
  const f = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) f[argv[i].slice(2)] = argv[++i];
  if (typeof f.file !== 'string' || !f.file.trim()) return { error: 'watch: --file <the job\'s output file> is required' };
  const what = typeof f.what === 'string' && f.what.trim() ? f.what.trim() : 'background job';
  let quietMin = DEFAULT_QUIET_MIN;
  if (f.quiet !== undefined) {
    quietMin = Number(f.quiet);
    if (!Number.isFinite(quietMin) || quietMin < 5 || quietMin > 120) return { error: `watch: --quiet must be 5 to 120 minutes, got "${f.quiet}"` };
  }
  return { file: f.file, what, quietMin };
}

/** The watcher's starting state. size: the file's size when watching starts. */
export function initState({ what, quietMin = DEFAULT_QUIET_MIN, size = 0, now, prevQuietSize = null }) {
  return {
    what, quietMin, size, lastGrowthAt: now, distinctSince: now, windowLines: [], lastLine: null,
    failures: 0, endedAt: null, endCode: null, prevQuietSize,
  };
}

/**
 * One poll. poll: {ok, size, tail: new lines since the last poll}. Exit rules in order: gone, job ended, repeating,
 * quiet. Returns {state, exit: string|null}.
 */
export function judge(prev, poll, now) {
  const s = { ...prev, windowLines: [...prev.windowLines] };
  const q = s.quietMin * MIN;
  if (!poll.ok) {
    s.failures += 1;
    return { state: s, exit: s.failures >= 2 ? `Output file gone: "${s.what}".` : null };
  }
  s.failures = 0;
  // Any change of size is new output, including a file that was replaced and is now shorter.
  if (poll.size !== s.size) { s.size = poll.size; s.lastGrowthAt = now; }
  for (const raw of poll.tail ?? []) {
    const text = String(raw).trim();
    if (!text) continue;
    const ended = EXITED_RE.exec(text);
    if (ended) { if (s.endedAt == null) { s.endedAt = now; s.endCode = Number(ended[1]); } continue; }
    if (!s.windowLines.some((l) => l.text === text)) s.distinctSince = now;
    s.windowLines.push({ text, at: now });
    s.lastLine = text;
  }
  s.windowLines = s.windowLines.filter((l) => now - l.at <= q);
  if (s.endedAt != null) {
    return { state: s, exit: now - s.endedAt >= ENDED_GRACE_MS ? `Job ended (code ${s.endCode}): "${s.what}". Stop watching it.` : null };
  }
  if (now - s.lastGrowthAt < q && now - s.distinctSince >= q && s.lastLine) {
    return { state: s, exit: `Repeating for ${s.quietMin} min: "${s.what}". Line: ${clip(s.lastLine)}.` };
  }
  if (now - s.lastGrowthAt >= q) {
    const same = s.prevQuietSize != null && s.prevQuietSize === s.size ? ' No new output since the last check.' : '';
    return { state: s, exit: `Quiet ${s.quietMin} min: "${s.what}". Last line: ${s.lastLine ? clip(s.lastLine) : '(none)'}.${same}` };
  }
  return { state: s, exit: null };
}

/** The exit reason a line stands for, kept in the marker. */
export const reasonOf = (line) => (line.startsWith('Quiet') ? 'quiet' : line.startsWith('Repeating') ? 'repeating'
  : line.startsWith('Job ended') ? 'ended' : line.startsWith('Output file gone') ? 'gone' : 'other');

const watchDir = () => join(dashHome(), 'watch');

/** <dashHome>/watch/<session>-<first 12 of sha1(file)>.json */
export function markerPath(session, file) {
  const h = createHash('sha1').update(String(file)).digest('hex').slice(0, 12);
  return join(watchDir(), `${String(session || 'unknown').replace(/[^A-Za-z0-9-]/g, '-')}-${h}.json`);
}

/** Writes a marker atomically. Never throws. */
export function writeMarker(m) {
  try {
    mkdirSync(watchDir(), { recursive: true });
    const p = markerPath(m.session, m.file);
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(m));
    renameSync(tmp, p);
  } catch { /* the heartbeat is best effort */ }
}

/** Every readable marker, or only one session's. */
export function readMarkers(session) {
  const out = [];
  let names = [];
  try { names = readdirSync(watchDir()); } catch { return out; }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try {
      const m = JSON.parse(readFileSync(join(watchDir(), n), 'utf8'));
      if (!m || typeof m !== 'object' || typeof m.file !== 'string') continue;
      if (session !== undefined && m.session !== session) continue;
      out.push(m);
    } catch { /* broken marker: skip */ }
  }
  return out;
}

/** The marker of the last watcher on this file, if any. */
export function readMarker(session, file) {
  try { return JSON.parse(readFileSync(markerPath(session, file), 'utf8')); } catch { return null; }
}

/** A watcher is live while it has not exited and has beaten within 3 minutes. */
export const isLive = (m, now) => !!m && !m.exited && Number.isFinite(m.beatAt) && now - m.beatAt <= LIVE_MS;

/** Removes markers untouched for 7 days. */
export function pruneMarkers(now = Date.now()) {
  let names = [];
  try { names = readdirSync(watchDir()); } catch { return; }
  for (const n of names) {
    const p = join(watchDir(), n);
    try {
      const m = JSON.parse(readFileSync(p, 'utf8'));
      const last = Math.max(Number(m?.beatAt) || 0, Number(m?.exited?.at) || 0);
      if (now - last > KEEP_MS) rmSync(p, { force: true });
    } catch { /* leave what can't be read */ }
  }
}

const norm = (p) => String(p).replace(/\\/g, '/').toLowerCase();

/** The live watcher on a job's output file: {lastGrowthAt, quietMin}, or null. Paths compare without case or slash style. */
export function watchFor(outputFile, markers, now) {
  if (!outputFile) return null;
  const m = markers.find((x) => isLive(x, now) && norm(x.file) === norm(outputFile));
  return m ? { lastGrowthAt: m.lastGrowthAt, quietMin: m.quietMin } : null;
}

/** The session a job belongs to: CLAUDE_CODE_SESSION_ID, else the folder before `tasks` in its output path. */
export function sessionOf(file, env = process.env) {
  if (env.CLAUDE_CODE_SESSION_ID) return env.CLAUDE_CODE_SESSION_ID;
  const parts = String(file).split(/[\\/]/);
  const i = parts.lastIndexOf('tasks');
  return i > 0 ? parts[i - 1] : null;
}
