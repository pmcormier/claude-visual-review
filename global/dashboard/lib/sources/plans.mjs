// Superpowers plans: <root>/docs/superpowers/plans/*.md become epics, `### Task N: <title> [S|M|L]` headings
// become tasks, and `- [x]` / `- [ ]` lines under a task are its ticked steps.
// Plan-derived status (the tree merge combines it with the work log and git): all ticked -> done,
// some ticked -> doing, none ticked or no checkboxes -> next. Never throws.
import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const TASK = /^###\s+Task\s+(\d+)\s*[:.\u2013-]\s*(.*?)\s*$/i;
const SIZE = /\s*\[([SML])\]\s*$/;
const TICK = /^\s*[-*]\s+\[([ xX])\]/;

function parsePlan(text) {
  const lines = String(text).split(/\r?\n/);
  const title = lines.map((l) => /^#\s+(.+?)\s*$/.exec(l)).find(Boolean)?.[1] ?? null;
  const tasks = [];
  let cur = null;
  let fence = null;
  for (const line of lines) {
    const f = /^\s*(```|~~~)/.exec(line);
    if (f) { fence = fence === null ? f[1] : fence === f[1] ? null : fence; continue; }
    if (fence !== null) continue;
    if (/^#{2,3}\s/.test(line)) {
      const m = TASK.exec(line);
      if (m) {
        let t = m[2];
        let size = null;
        const s = SIZE.exec(t);
        if (s) { size = s[1].toUpperCase(); t = t.slice(0, s.index); }
        cur = { n: Number(m[1]), title: t.trim(), size, done: 0, total: 0 };
        tasks.push(cur);
      } else {
        cur = null; // any other ## / ### heading ends the task's range
      }
      continue;
    }
    if (!cur) continue;
    const k = TICK.exec(line);
    if (k) { cur.total += 1; if (k[1] !== ' ') cur.done += 1; }
  }
  return { title, tasks };
}

/**
 * @param {string} root project root
 * @returns {import('../types.mjs').Epic[]}
 */
export function readPlans(root) {
  const dir = join(String(root || ''), 'docs', 'superpowers', 'plans');
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.md')).sort();
  } catch {
    return [];
  }
  const epics = [];
  for (const name of names) {
    try {
      const file = join(dir, name);
      const { title, tasks } = parsePlan(readFileSync(file, 'utf8'));
      const id = `plan:docs/superpowers/plans/${name}`;
      epics.push({
        id, source: 'plan', title: title || basename(name, '.md'), file,
        tasks: tasks.map((t) => ({
          id: `${id}#${t.n}`, n: t.n, title: t.title,
          status: t.total > 0 && t.done === t.total ? 'done' : t.done > 0 ? 'doing' : 'next',
          size: t.size, sessionId: null, startedMs: null, doneMs: null,
          ticked: t.total > 0 ? { done: t.done, total: t.total } : null,
        })),
      });
    } catch { /* unreadable plan: skip it */ }
  }
  return epics;
}
