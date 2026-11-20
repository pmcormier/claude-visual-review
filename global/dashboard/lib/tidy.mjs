// The end-of-turn tidy-up's decisions (decision 37), kept pure so they can be tested; tidy-hook.mjs does the I/O,
// except backgroundHelperRunning, which reads the session's helper files (decision 41).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** The reminder, in the words the owner approved. Names the first step still marked doing. */
export function reminderText(entry) {
  const s = entry.doing[0];
  return `Work-log check: "${entry.title}" still has step ${s.n} "${s.name}" marked doing, and no job is being watched. ` +
    'If it\'s finished, mark it done (and your Inbox checklist). If it waits on the owner, mark it waiting. ' +
    'If a job is running, start a watcher for it. If it\'s right as it is, say nothing and end the turn.';
}

/**
 * Remind only when a step is doing, nothing is watched, the turn doesn't end on a question to the owner, this turn
 * isn't already a reminder's, and this exact state wasn't reminded before.
 * @returns {{remind: string|null, state: string|null}}
 */
export function tidyDecision({ entry, live, asking, stopActive, lastState }) {
  if (!entry || !entry.doing?.length) return { remind: null, state: null };
  const state = `${entry.startedAt ?? ''}|${entry.title}|${entry.doing.map((s) => `${s.n}:${s.name}`).join(',')}`;
  if (live || asking || stopActive || state === lastState) return { remind: null, state };
  return { remind: reminderText(entry), state };
}

/**
 * Whether the turn ends on a question to the owner: the last assistant text ends in "?" with no tool call or user
 * entry after it (the rule transcripts.mjs uses for lastAsk), or an AskUserQuestion has no result yet.
 * @param {string[]} lines the transcript's last lines (JSONL); broken lines are skipped
 */
export function askingAtEnd(lines) {
  let ask = false;
  const openAsks = new Set();
  for (const l of lines) {
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    const content = Array.isArray(e?.message?.content) ? e.message.content : [];
    if (e?.type === 'user') {
      ask = false;
      for (const b of content) if (b?.type === 'tool_result') openAsks.delete(b.tool_use_id);
    } else if (e?.type === 'assistant') {
      for (const b of content) {
        if (b?.type === 'tool_use') { ask = false; if (b.name === 'AskUserQuestion') openAsks.add(b.id); }
        else if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) ask = b.text.trim().endsWith('?');
      }
    }
  }
  return ask || openAsks.size > 0;
}

const HELPER_QUIET_MS = 30 * 60000; // a helper silent this long is taken as dead, so it can't hush the reminder forever

/**
 * Whether the session has a helper agent working in the background: Claude Code's meta file beside it says
 * requestShape "background" and not finished, and its transcript was written within 30 minutes (decision 41).
 * Never throws; false when nothing can be read.
 */
export function backgroundHelperRunning(transcriptPath, now = Date.now()) {
  try {
    const dir = join(dirname(transcriptPath), basename(transcriptPath).replace(/\.jsonl$/, ''), 'subagents');
    for (const n of readdirSync(dir)) {
      const m = /^agent-(.+)\.meta\.json$/.exec(n);
      if (!m) continue;
      let meta;
      try { meta = JSON.parse(readFileSync(join(dir, n), 'utf8')); } catch { continue; }
      if (meta?.requestShape !== 'background' || meta?.finished === true) continue;
      let wrote = 0;
      try { wrote = statSync(join(dir, `agent-${m[1]}.jsonl`)).mtimeMs; } catch { continue; }
      if (now - wrote <= HELPER_QUIET_MS) return true;
    }
  } catch { /* no helpers folder */ }
  return false;
}
