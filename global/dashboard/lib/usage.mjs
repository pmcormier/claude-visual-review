// Plan-usage numbers captured by statusline-tap.mjs (only the status line receives them).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dashHome } from './paths.mjs';

// The tap runs on every status-line refresh, so a healthy file is seconds old. Past 15 minutes
// no session is refreshing it (all closed, or the tap is no longer installed): flag it stale.
export const STALE_MS = 15 * 60_000;

export function usagePath() {
  return join(dashHome(), 'usage.json');
}

function windowOf(w, now) {
  if (!w || typeof w.used_percentage !== 'number' || typeof w.resets_at !== 'number') return null;
  const resetsAt = w.resets_at * 1000; // Claude Code sends epoch seconds
  if (resetsAt <= now) return null;
  return { pct: w.used_percentage, resetsAt };
}

export function readUsage(now = Date.now()) {
  let u;
  try { u = JSON.parse(readFileSync(usagePath(), 'utf8')); } catch { return { fiveHour: null, week: null, stale: true }; }
  if (!u || typeof u !== 'object') return { fiveHour: null, week: null, stale: true };
  return {
    fiveHour: windowOf(u.five_hour, now),
    week: windowOf(u.seven_day, now),
    stale: typeof u.at !== 'number' || now - u.at > STALE_MS,
  };
}
