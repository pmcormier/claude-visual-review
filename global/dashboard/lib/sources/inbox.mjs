// Plannotator Inbox checklists: the `steps.jsonl` of the Plannotator project whose root is this project.
// Every line is an envelope { v, seq, at, kind, id, record }. A steps record is a full checklist snapshot,
// so the latest per thread + agent session wins (by seq, else file order). Never throws.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { plannotatorHome } from '../paths.mjs';
import { readJsonl } from '../jsonl.mjs';

const STATUS = { todo: 'next', doing: 'doing', done: 'done', waiting: 'waiting' }; // dropped: hidden

const seqOf = (r) => (Number.isFinite(r?.seq) ? r.seq : null);

function sameRoot(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = resolve(a);
  const y = resolve(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

// project.json is JSONL: the project record is rewritten by appending, so the highest-seq `project` envelope
// is current. A file holding a single JSON object (no trailing newline, or pretty-printed) is read too.
function projectRecord(file) {
  const envs = readJsonl(file).records.filter((e) => e && e.kind === 'project' && e.record && typeof e.record === 'object');
  if (envs.length) {
    let best = envs[0];
    for (const e of envs) if (!(seqOf(e) !== null && seqOf(best) !== null && seqOf(e) < seqOf(best))) best = e;
    return best.record;
  }
  try {
    const one = JSON.parse(readFileSync(file, 'utf8'));
    return one?.record && typeof one.record === 'object' ? one.record : one;
  } catch { return null; }
}

function projectDirs(root) {
  const base = join(plannotatorHome(), 'inbox', 'projects');
  let keys;
  try { keys = readdirSync(base); } catch { return []; }
  const out = [];
  for (const key of keys) {
    try {
      if (sameRoot(projectRecord(join(base, key, 'project.json'))?.root, root)) out.push(join(base, key));
    } catch { /* not a project folder */ }
  }
  return out;
}

function titles(dir) {
  const named = new Map(); // thread -> thread_name
  const first = new Map(); // thread -> first message subject
  const root = new Map(); // thread -> subject of the message whose id is the thread id
  for (const e of readJsonl(join(dir, 'messages.jsonl')).records) {
    const m = e?.record;
    if (!m || typeof m !== 'object' || typeof m.thread_id !== 'string') continue;
    if (typeof m.thread_name === 'string' && m.thread_name.trim()) named.set(m.thread_id, m.thread_name.trim());
    if (typeof m.subject !== 'string' || !m.subject.trim()) continue;
    if (!first.has(m.thread_id)) first.set(m.thread_id, m.subject.trim());
    if (m.id === m.thread_id) root.set(m.thread_id, m.subject.trim());
  }
  return (thread) => named.get(thread) ?? root.get(thread) ?? first.get(thread) ?? 'Checklist';
}

function ms(at) {
  const t = Date.parse(at);
  return Number.isFinite(t) ? t : null;
}

/**
 * @param {string} root project root
 * @returns {import('../types.mjs').Epic[]}
 */
export function readInbox(root) {
  const epics = [];
  try {
    for (const dir of projectDirs(root)) {
      const latest = new Map(); // thread \u0000 session -> envelope
      for (const e of readJsonl(join(dir, 'steps.jsonl')).records) {
        const r = e?.record;
        if (!r || typeof r !== 'object' || typeof r.thread_id !== 'string' || !Array.isArray(r.steps)) continue;
        const session = typeof r.agent?.session === 'string' && r.agent.session ? r.agent.session : null;
        const key = `${r.thread_id}\u0000${session ?? ''}`;
        const prev = latest.get(key);
        // Later in the file wins unless both carry a seq and this one is older.
        if (prev && seqOf(prev) !== null && seqOf(e) !== null && seqOf(e) < seqOf(prev)) continue;
        latest.set(key, e);
      }
      if (!latest.size) continue;
      const titleOf = titles(dir);
      for (const e of latest.values()) {
        const r = e.record;
        const session = typeof r.agent?.session === 'string' && r.agent.session ? r.agent.session : null;
        const id = `inbox:${r.thread_id}:${session ?? ''}`;
        const tasks = [];
        r.steps.forEach((s, i) => {
          if (!s || typeof s !== 'object' || s.status === 'dropped') return;
          const status = STATUS[s.status];
          const title = typeof s.step === 'string' ? s.step.trim() : '';
          if (!status || !title) return;
          const at = ms(s.at);
          tasks.push({
            id: `${id}#${i + 1}`, n: null, title, status, size: null, sessionId: session,
            startedMs: status === 'doing' ? at : null, doneMs: status === 'done' ? at : null, ticked: null,
          });
        });
        if (!tasks.length) continue;
        epics.push({ id, source: 'inbox', title: titleOf(r.thread_id), file: null, tasks });
      }
    }
  } catch { /* return what was built */ }
  return epics;
}
