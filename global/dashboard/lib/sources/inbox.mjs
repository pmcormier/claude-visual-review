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
  const started = new Map(); // thread -> first message time
  const first = new Map(); // thread -> first message subject
  const root = new Map(); // thread -> subject of the message whose id is the thread id
  for (const e of readJsonl(join(dir, 'messages.jsonl')).records) {
    const m = e?.record;
    if (!m || typeof m !== 'object' || typeof m.thread_id !== 'string') continue;
    if (typeof m.thread_name === 'string' && m.thread_name.trim()) named.set(m.thread_id, m.thread_name.trim());
    const at = ms(m.created_at) ?? ms(e.at);
    if (at !== null && !(started.get(m.thread_id) <= at)) started.set(m.thread_id, at);
    if (typeof m.subject !== 'string' || !m.subject.trim()) continue;
    if (!first.has(m.thread_id)) first.set(m.thread_id, m.subject.trim());
    if (m.id === m.thread_id) root.set(m.thread_id, m.subject.trim());
  }
  return {
    titleOf: (thread) => named.get(thread) ?? root.get(thread) ?? first.get(thread) ?? 'Checklist',
    // The thread's subject, a fuller line than its name: an Inbox step's about line when no mirror has one.
    subjectOf: (thread) => root.get(thread) ?? first.get(thread) ?? null,
    startedOf: (thread) => started.get(thread) ?? null,
  };
}

function ms(at) {
  const t = Date.parse(at);
  return Number.isFinite(t) ? t : null;
}

/**
 * Open Inbox questions by the session that asked them, across every Inbox project: the latest envelope has no
 * answer, is not withdrawn (superseded_by), is not an action already done (action_result), and its thread is not
 * resolved. askedMs is the question's first envelope. Per session the newest wins. Never throws.
 * @returns {Map<string, {prompt: string, askedMs: number}>}
 */
export function readOpenQuestions() {
  const out = new Map();
  let keys = [];
  const base = join(plannotatorHome(), 'inbox', 'projects');
  try { keys = readdirSync(base); } catch { return out; }
  for (const key of keys) {
    try {
      const dir = join(base, key);
      const latest = new Map(); // id -> {env, firstMs}
      for (const e of readJsonl(join(dir, 'questions.jsonl')).records) {
        if (!e || e.kind !== 'question' || typeof e.id !== 'string' || !isObjRec(e.record)) continue;
        const prev = latest.get(e.id);
        if (prev && seqOf(prev.env) !== null && seqOf(e) !== null && seqOf(e) < seqOf(prev.env)) continue;
        latest.set(e.id, { env: e, firstMs: prev?.firstMs ?? ms(e.at) });
      }
      if (!latest.size) continue;
      const threadOf = new Map();
      const resolved = new Set();
      for (const e of readJsonl(join(dir, 'messages.jsonl')).records) {
        const m = e?.record;
        if (!m || typeof m.id !== 'string') continue;
        threadOf.set(m.id, m.thread_id);
        if (m.resolved_at) resolved.add(m.thread_id);
      }
      for (const { env, firstMs } of latest.values()) {
        const r = env.record;
        if (r.answer != null || r.superseded_by != null || (r.action && r.action_result)) continue;
        if (resolved.has(threadOf.get(r.message_id))) continue;
        const sid = typeof r.asked_by_agent_id === 'string' ? r.asked_by_agent_id : null;
        if (!sid || typeof r.prompt !== 'string' || firstMs === null) continue;
        const prev = out.get(sid);
        if (!prev || firstMs > prev.askedMs) out.set(sid, { prompt: r.prompt.trim(), askedMs: firstMs });
      }
    } catch { /* skip this project */ }
  }
  return out;
}

const isObjRec = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {string} root project root
 * @returns {import('../types.mjs').Epic[]}
 */
export function readInbox(root) {
  const epics = [];
  try {
    for (const dir of projectDirs(root)) {
      const latest = new Map(); // thread -> envelope: one checklist per thread, the newest whichever session wrote it
      for (const e of readJsonl(join(dir, 'steps.jsonl')).records) {
        const r = e?.record;
        if (!r || typeof r !== 'object' || typeof r.thread_id !== 'string' || !Array.isArray(r.steps)) continue;
        const session = typeof r.agent?.session === 'string' && r.agent.session ? r.agent.session : null;
        const key = r.thread_id;
        const prev = latest.get(key);
        // Later in the file wins unless both carry a seq and this one is older.
        if (prev && seqOf(prev) !== null && seqOf(e) !== null && seqOf(e) < seqOf(prev)) continue;
        latest.set(key, e);
      }
      if (!latest.size) continue;
      const { titleOf, subjectOf, startedOf } = titles(dir);
      for (const e of latest.values()) {
        const r = e.record;
        const session = typeof r.agent?.session === 'string' && r.agent.session ? r.agent.session : null;
        const id = `inbox:${r.thread_id}`;
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
            changedMs: at,
          });
        });
        if (!tasks.length) continue;
        epics.push({ id, source: 'inbox', title: titleOf(r.thread_id), subject: subjectOf(r.thread_id), file: null, tasks, _started: startedOf(r.thread_id) });
      }
    }
  } catch { /* return what was built */ }
  // Threads that share a name are told apart by the day they started ("Build status · Nov 14").
  const count = new Map();
  for (const e of epics) count.set(e.title, (count.get(e.title) ?? 0) + 1);
  for (const e of epics) {
    if (count.get(e.title) > 1 && e._started !== null) {
      e.title = `${e.title} · ${new Date(e._started).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
    }
    delete e._started;
  }
  return epics;
}
