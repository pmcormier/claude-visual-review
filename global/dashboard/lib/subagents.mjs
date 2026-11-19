// Subagents of one session: <transcript dir>/<sessionId>/subagents/agent-<id>.{jsonl,meta.json}.
// Read-only. An id seen in only one of the two files still yields an entry (an orphan .meta.json has
// lastWriteMs null and empty signals; a .jsonl without meta is described as 'Subagent'). Never throws.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { scanTranscript } from './transcripts.mjs';
import { loadConfig } from './config.mjs';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v !== '' ? v : null);

function readMeta(path) {
  try {
    const m = JSON.parse(readFileSync(path, 'utf8'));
    return isObj(m) ? m : {};
  } catch { return {}; }
}

// Optional cache (a Map the caller keeps across calls): a dormant subagent, one whose transcript had not been
// written for DORMANT_MS when it was last read, is reused for up to RECHECK_MS instead of being read again. Its
// minutes are all zero and its loop window has passed, so only `finished` or a resumed write can be missed, for at
// most RECHECK_MS. Re-reading every subagent on every rebuild was 298 of 385 ms (measured 2026-11-19, 329 files).
export const DORMANT_MS = 61 * 60000;
export const RECHECK_MS = 60000;

export function readSubagents(transcriptPath, now = Date.now(), thresholds = null, { cache = null } = {}) {
  const dir = join(dirname(transcriptPath), basename(transcriptPath).replace(/\.jsonl$/, ''), 'subagents');
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  const ids = new Set();
  for (const n of names) {
    const m = /^agent-(.+?)(\.meta\.json|\.jsonl)$/.exec(n);
    if (m) ids.add(m[1]);
  }
  if (!ids.size) return [];
  const th = thresholds ?? loadConfig().thresholds;
  const out = [];
  for (const agentId of ids) {
    const key = join(dir, `agent-${agentId}`);
    const hit = cache?.get(key);
    if (hit && now >= hit.checkedAt && now - hit.checkedAt < RECHECK_MS) { out.push(hit.entry); continue; }
    const meta = readMeta(join(dir, `agent-${agentId}.meta.json`));
    const signals = scanTranscript(join(dir, `agent-${agentId}.jsonl`), now, th);
    const entry = {
      agentId,
      description: str(meta.description) ?? 'Subagent',
      model: str(meta.model),
      effort: str(meta.effort),
      finished: typeof meta.finished === 'boolean' ? meta.finished : null,
      lastWriteMs: signals.lastWriteMs,
      minutes: signals.minutes,
      signals,
    };
    out.push(entry);
    if (cache) {
      const lw = signals.lastWriteMs;
      if (lw !== null && lw < now - Math.max(DORMANT_MS, (th.loopWindow + 1) * 60000)) cache.set(key, { entry, checkedAt: now });
      else cache.delete(key);
    }
  }
  out.sort((a, b) => (b.lastWriteMs ?? -Infinity) - (a.lastWriteMs ?? -Infinity));
  return out;
}
