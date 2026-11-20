// Heartbeat watcher (decision 37). Run beside a long background job, itself in the background:
//   node ~/.claude/dashboard/watch.mjs --file "<the job's output file>" --what "<what the job is>" [--quiet <5..120>]
// Costs no model tokens while the job keeps printing. Exits with one line, which wakes the session, when the job's
// output has been quiet or repeating for the quiet window, when the job ended, or when its file is gone. Keeps a
// marker in <dashHome>/watch/ so the dashboard and the end-of-turn check know the job is watched. Always exits 0.
import { appendFileSync, closeSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dashHome } from './lib/paths.mjs';
import {
  parseArgs, initState, judge, reasonOf, writeMarker, readMarker, sessionOf, splitChunk, POLL_MS, BEAT_MS,
} from './lib/watch.mjs';

const MAX_READ = 1024 * 1024; // only the newest megabyte of a burst is read

function logError(msg) {
  try {
    mkdirSync(dashHome(), { recursive: true });
    appendFileSync(join(dashHome(), 'watch.log'), `${new Date().toISOString()} ${String(msg).replace(/\s+/g, ' ')}\n`);
  } catch { /* nowhere left to report */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) { console.log(args.error); return; }
  const { file, what, quietMin } = args;
  const session = sessionOf(file);
  const now0 = Date.now();
  const prev = readMarker(session, file);
  const prevQuietSize = prev?.exited?.reason === 'quiet' && Number.isFinite(prev.exited.size) ? prev.exited.size : null;
  const prevRepeatLine = prev?.exited?.reason === 'repeating' && typeof prev.exited.line === 'string' ? prev.exited.line : null;

  let offset = 0;
  let partial = '';
  // Reads the bytes added since the last poll; a shorter file was replaced, so reading starts over.
  const poll = () => {
    let st;
    try { st = statSync(file); } catch { return { ok: false }; }
    if (st.size < offset) { offset = 0; partial = ''; }
    let text = '';
    if (st.size > offset) {
      const from = Math.max(offset, st.size - MAX_READ);
      if (from > offset) partial = ''; // bytes were skipped, so the old partial line doesn't continue here
      const buf = Buffer.alloc(st.size - from);
      let fd;
      try { fd = openSync(file, 'r'); readSync(fd, buf, 0, buf.length, from); } catch { return { ok: false }; } finally { if (fd !== undefined) closeSync(fd); }
      text = buf.toString('utf8');
      offset = st.size;
    }
    const split = splitChunk(partial, text);
    const lines = split.lines;
    partial = split.partial;
    // A last line without its newline still counts when nothing more is coming.
    const tail = partial && text === '' ? [...lines, partial] : lines;
    if (partial && text === '') partial = '';
    return { ok: true, size: st.size, tail };
  };

  let state = initState({ what, quietMin, size: 0, now: now0, prevQuietSize, prevRepeatLine });
  const marker = { session, file, what, pid: process.pid, startedAt: now0, beatAt: now0, lastGrowthAt: now0, size: 0, quietMin, exited: null };
  let lastBeat = 0;
  for (;;) {
    const now = Date.now();
    const r = judge(state, poll(), now);
    const grew = r.state.lastGrowthAt !== state.lastGrowthAt;
    state = r.state;
    if (r.exit) {
      writeMarker({ ...marker, beatAt: now, lastGrowthAt: state.lastGrowthAt, size: state.size, exited: { at: now, reason: reasonOf(r.exit), size: state.size, line: state.lastLine } });
      console.log(r.exit);
      return;
    }
    if (grew || now - lastBeat >= BEAT_MS) {
      lastBeat = now;
      writeMarker({ ...marker, beatAt: now, lastGrowthAt: state.lastGrowthAt, size: state.size });
    }
    await sleep(POLL_MS);
  }
}

main().catch((e) => { logError(e?.stack || e); console.log(`watch: stopped on an error, see ${join(dashHome(), 'watch.log')}`); });
