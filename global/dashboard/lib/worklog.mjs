// The work log: one JSON line per note, written by note.mjs, read here into epics and tasks.
// Lines are { v: 1, at, session, verb, ... } in <dashHome>/worklog/<project-slug>.jsonl.
// Never throws; unknown verbs, other versions and broken lines are skipped.
import { join } from 'node:path';
import { dashHome } from './paths.mjs';
import { readJsonl } from './jsonl.mjs';

/** @typedef {import('./types.mjs')} _Types */

export function projectSlug(root) {
  return String(root || '').replace(/[^A-Za-z0-9]/g, '-');
}

export function worklogPath(root) {
  return join(dashHome(), 'worklog', projectSlug(root) + '.jsonl');
}

const STATUS = { todo: 'next', doing: 'doing', done: 'done', waiting: 'waiting' };

function ms(at) {
  if (typeof at === 'number' && Number.isFinite(at)) return at;
  const t = Date.parse(at);
  return Number.isFinite(t) ? t : null;
}

function mkTask(id, title, n, session, status, at) {
  return {
    id, n, title, status, size: null, sessionId: session,
    startedMs: status === 'doing' ? at : null, doneMs: null, ticked: null,
  };
}

/**
 * @param {string} root project root
 * @returns {import('./types.mjs').Epic[]} one epic per `start`, in log order; dropped epics omitted
 */
export function readWorklog(root) {
  const epics = [];
  const open = new Map(); // session (or null) -> internal epic
  try {
    const { records } = readJsonl(worklogPath(root));
    for (const r of records) {
      if (!r || typeof r !== 'object' || r.v !== 1) continue;
      const session = typeof r.session === 'string' && r.session ? r.session : null;
      const at = ms(r.at);
      if (r.verb === 'start') {
        const title = typeof r.title === 'string' ? r.title.trim() : '';
        if (!title) continue;
        const id = `wl-${epics.length + 1}`;
        const n = Number.isFinite(Number(r.task)) && r.task !== null && r.task !== '' ? Number(r.task) : null;
        const steps = Array.isArray(r.steps) ? r.steps.filter((s) => typeof s === 'string' && s.trim()) : [];
        const tasks = steps.length
          ? steps.map((s, i) => mkTask(`${id}-${i + 1}`, s.trim(), i === 0 ? n : null, session, 'next', at))
          : [mkTask(`${id}-1`, title, n, session, 'doing', at)];
        const epic = {
          id, source: 'worklog', title, file: typeof r.plan === 'string' && r.plan ? r.plan : null,
          tasks, _hidden: new Set(), _dropped: false, _closed: false, _startMs: at,
        };
        epics.push(epic);
        open.set(session, epic);
        continue;
      }
      const epic = open.get(session);
      if (!epic) continue;
      if (r.verb === 'step') {
        const i = Number(r.n) - 1;
        if (!Number.isInteger(i) || i < 0 || i >= epic.tasks.length) continue;
        if (r.status === 'dropped') { epic._hidden.add(i); continue; }
        const status = STATUS[r.status];
        if (!status) continue;
        epic._hidden.delete(i);
        const t = epic.tasks[i];
        t.status = status;
        if (status === 'doing' && t.startedMs === null) t.startedMs = at;
        t.doneMs = status === 'done' ? at : null;
      } else if (r.verb === 'done') {
        epic.tasks.forEach((t, i) => {
          if (epic._hidden.has(i)) return;
          t.status = 'done';
          t.doneMs = at;
          if (t.startedMs === null) t.startedMs = epic._startMs;
        });
        open.delete(session);
      } else if (r.verb === 'drop') {
        epic._dropped = true;
        open.delete(session);
      }
    }
  } catch { /* return what was built */ }
  return epics
    .filter((e) => !e._dropped)
    .map((e) => ({
      id: e.id, source: e.source, title: e.title, file: e.file,
      tasks: e.tasks.filter((_, i) => !e._hidden.has(i)),
    }));
}
