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

export function readSubagents(transcriptPath, now = Date.now(), thresholds = null) {
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
    const meta = readMeta(join(dir, `agent-${agentId}.meta.json`));
    const signals = scanTranscript(join(dir, `agent-${agentId}.jsonl`), now, th);
    out.push({
      agentId,
      description: str(meta.description) ?? 'Subagent',
      model: str(meta.model),
      effort: str(meta.effort),
      finished: typeof meta.finished === 'boolean' ? meta.finished : null,
      lastWriteMs: signals.lastWriteMs,
      minutes: signals.minutes,
      signals,
    });
  }
  out.sort((a, b) => (b.lastWriteMs ?? -Infinity) - (a.lastWriteMs ?? -Infinity));
  return out;
}
