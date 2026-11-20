// The dashboard page: renders the model pushed over /events, port of the approved mockup onto live data.
// Every string that comes from the model (transcripts, plans, file names) reaches the DOM through textContent or
// a text node; markup is built with createElement from this file's own templates. Updates are incremental: each
// project's panel is rebuilt only when its data (or the page's own state for it) changed, and focus is carried
// over to the rebuilt node.
import {
  STATE_LABEL, STATE_CLASS, formatDuration, agoWords, updatedText, shortId, shortDate, lifePath, foldEpics,
  effortLeft, liveIds, usageView, detailText, sessionWhat, nowLines, watchedNote, watchedAgo, watchedHover, triage, epicDone, epicLastActivity, sizeSummary,
  filterToken, GROUPS, groupEpics, foldOpen, projectFoldKeys, tipText, currentTask, panelOrder, spendLine, projectSpend,
  taskLiveness, leftOpenText, sessionLabel, projectOpen, themeLabel,
} from '/render.mjs';

const MIN = 60000;
const HOUR = 60 * MIN;
const QUIET_SHOWN = 10;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const arr = (v) => (Array.isArray(v) ? v : []);
const token = $('meta[name="dash-token"]')?.getAttribute('content') ?? '';
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---- per-browser state (localStorage, never required) ---------------------------------------------------------

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window or blocked */ } },
};
const TABS = ['projects', 'sessions', 'triage'];
let tab = TABS.includes(store.get('dash-tab', 'projects')) ? store.get('dash-tab', 'projects') : 'projects';
let showHistory = store.get('dash-history', false) === true;
const openState = (() => { const o = store.get('dash-open', {}); return o && typeof o === 'object' ? o : {}; })();
const seen = new Set(arr(store.get('dash-seen', [])).filter((k) => typeof k === 'string'));

let model = null;
let heardAt = 0; // last model or heartbeat from the server (R19)
const SILENT_MS = 60000; // after this long without either, the bar says "Server not responding"
let filter = null;
let stopped = false;
let showAllQuiet = false;
const dirty = { projects: true, sessions: true, triage: true };
const details = new Map(); // detail key -> item for detailText
const panels = new Map(); // root -> {sig, el}
const qrows = new Map(); // root -> {sig, el}

// ---- building blocks --------------------------------------------------------------------------------------------

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'data') { for (const [dk, dv] of Object.entries(v)) if (dv !== null && dv !== undefined) el.dataset[dk] = String(dv); }
    else if (k === 'hidden') el.hidden = true;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const NS = 'http://www.w3.org/2000/svg';
function svg(cls, viewBox, attrs, shapes) {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', viewBox);
  if (cls) s.setAttribute('class', cls);
  s.setAttribute('aria-hidden', 'true');
  for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
  for (const [tag, a] of shapes) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(a)) e.setAttribute(k, v);
    s.append(e);
  }
  return s;
}

const STROKE = { fill: 'none', stroke: 'currentColor' };
const ICONS = {
  work: [{ ...STROKE, 'stroke-width': '1.8' }, [['circle', { cx: 8, cy: 8, r: 5.5 }], ['path', { d: 'M8 2.5a5.5 5.5 0 0 1 5.5 5.5', 'stroke-width': '2.6', 'stroke-linecap': 'round' }]]],
  idle: [{ ...STROKE, 'stroke-width': '1.6' }, [['circle', { cx: 8, cy: 8, r: 5.5, 'stroke-dasharray': '2.5 2.2' }]]],
  // Started, not active: a ring with its first quarter drawn, no motion. Left open: a dashed ring with a pause bar.
  started: [{ ...STROKE, 'stroke-width': '1.6' }, [['circle', { cx: 8, cy: 8, r: 5.5 }], ['path', { d: 'M8 2.5a5.5 5.5 0 0 1 5.5 5.5', 'stroke-width': '2.6', 'stroke-linecap': 'round', opacity: '.55' }]]],
  stale: [{ ...STROKE, 'stroke-width': '1.6', 'stroke-linecap': 'round' }, [['circle', { cx: 8, cy: 8, r: 5.5, 'stroke-dasharray': '2.5 2.2' }], ['path', { d: 'M6.5 6v4M9.5 6v4' }]]],
  done: [{ ...STROKE, 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, [['path', { d: 'M3.5 8.5 6.5 11.5 12.5 4.5' }]]],
  stuck: [{ ...STROKE, 'stroke-width': '1.8', 'stroke-linecap': 'round' }, [['path', { d: 'M8 2.5 14 13.5H2Z', 'stroke-linejoin': 'round' }], ['path', { d: 'M8 7v3M8 12v.01' }]]],
  wait: [{ ...STROKE, 'stroke-width': '1.8', 'stroke-linecap': 'round' }, [['circle', { cx: 8, cy: 8, r: 5.5 }], ['path', { d: 'M8 5v3.2l2 1.3' }]]],
  sub: [{ ...STROKE, 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, [['path', { d: 'M4 3v6a2 2 0 0 0 2 2h6' }], ['path', { d: 'M10 9l2 2-2 2' }]]],
};
ICONS.gone = ICONS.stuck;
const icon = (kind) => { const [a, s] = ICONS[kind] ?? ICONS.idle; return svg('ic', '0 0 16 16', a, s); };
const chevron = () => svg(null, '0 0 12 12', { width: 12, height: 12, ...STROKE, 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, [['path', { d: 'M3 4.5 6 7.5 9 4.5' }]]);

function tw(open, key, label, kind) {
  return h('button', {
    type: 'button', class: 'tw', 'aria-expanded': String(open), 'aria-label': `${open ? 'Fold' : 'Open'} ${label}`,
    data: { fk: key, tw: kind },
  }, chevron());
}

function chip(state) {
  const cls = STATE_CLASS[state] ?? 'idle';
  return h('span', { class: `chip s-${cls}` }, h('span', { class: `dot${state === 'working' ? ' live' : ''}` }), STATE_LABEL[state] ?? 'Unknown');
}

function life(minutes) {
  const s = svg('life ridge', '0 0 120 18', {}, [['path', { d: lifePath(minutes) }]]);
  s.removeAttribute('aria-hidden');
  s.setAttribute('role', 'img');
  s.setAttribute('aria-label', 'Signs of life over the last hour');
  return s;
}

/** A live timer: the ticker rewrites it from data-since (elapsed) or data-until (remaining). */
const since = (ms, now) => h('span', { class: 't', data: { since: ms }, text: formatDuration(Math.max(0, now - ms)) });
const until = (ms, now) => h('span', { class: 't', data: { until: ms }, text: formatDuration(Math.max(0, ms - now)) });

// ---- model helpers ----------------------------------------------------------------------------------------------

const keyOf = (...parts) => parts.join('|');
const isActiveSub = (a) => a?.finished !== true && a?.state !== 'idle';

function alertKeys(p) {
  const out = [];
  for (const s of arr(p.sessions)) {
    if (s.state === 'stuck' || s.state === 'waiting') out.push(`${s.sessionId}|${s.state}|${s.since ?? ''}`);
    for (const a of arr(s.subagents)) if (a.state === 'stuck') out.push(`${s.sessionId}/${a.agentId}|${a.state}|${a.since ?? ''}`);
  }
  return out;
}
const unseenOf = (keys) => keys.filter((k) => !seen.has(k));

function markSeen(keys) {
  let added = false;
  for (const k of keys) if (k && !seen.has(k)) { seen.add(k); added = true; }
  if (!added) return;
  const list = [...seen];
  store.set('dash-seen', list.slice(-300));
  for (const el of $$('[data-alerts]')) {
    if (unseenOf(el.dataset.alerts.split(',')).length) continue;
    el.classList.remove('changed');
    for (const b of $$('.newbadge', el)) if (b.closest('[data-alerts]') === el) b.remove();
  }
}

function stateTokens(p, shown) {
  const t = new Set([filterToken(p.state)]);
  for (const s of arr(p.sessions)) {
    t.add(filterToken(s.state));
    for (const a of arr(s.subagents)) if (isActiveSub(a)) t.add(filterToken(a.state));
  }
  if (shown.some((e) => arr(e.tasks).some((x) => x.status === 'next'))) t.add('next');
  return [...t].join(' ');
}

function leftText(p, shown, header = false) {
  if (!arr(p.tree?.epics).length) return header ? '' : 'No plan found';
  const left = effortLeft(p.tree, shown);
  if (!left.count) return 'Nothing left';
  return [`${left.count} left`, sizeSummary(shown), left.hours ? `≈ ${left.hours}h` : ''].filter(Boolean).join(' · ');
}

function buildDetails(m) {
  details.clear();
  for (const p of arr(m?.projects)) {
    details.set(keyOf('p', p.root), { kind: 'project', project: p });
    const ps = projectSpend(p.spend);
    if (ps) details.set(keyOf('$', p.root), { kind: 'spend', text: ps.tip });
    const byId = new Map(arr(p.sessions).map((s) => [s.sessionId, s]));
    for (const s of arr(p.sessions)) {
      details.set(keyOf('s', p.root, s.sessionId), { kind: 'session', session: s, project: p });
      const sl = spendLine(s.spend);
      if (sl) details.set(keyOf('$', p.root, s.sessionId), { kind: 'spend', text: sl.tip });
      for (const a of arr(s.subagents)) details.set(keyOf('a', p.root, s.sessionId, a.agentId), { kind: 'subagent', subagent: a, session: s, project: p });
    }
    for (const e of arr(p.tree?.epics)) {
      details.set(keyOf('e', p.root, e.id), { kind: 'epic', epic: e });
      for (const t of arr(e.tasks)) {
        const now = Date.now();
        details.set(keyOf('t', p.root, t.id), { kind: 'task', task: t, epic: e, session: liveSession(byId, t), liveness: taskLiveness(t, byId, now, e.id), now });
      }
    }
  }
}
const liveSession = (byId, t) => { const s = t?.sessionId ? byId.get(t.sessionId) : null; return s?.alive ? s : null; };

// ---- Projects view ----------------------------------------------------------------------------------------------

// A fold holds unless the project became active after it (spec 2026-11-19 clarity, rule 9).
const isOpen = (p) => projectOpen(p, openState[keyOf('p', p.root)]);

function sessionBlock(p, s, now) {
  const cls = STATE_CLASS[s.state] ?? 'idle';
  const { what, line } = sessionWhat(s);
  const cur = currentTask(s);
  const link = cur?.id ? keyOf(p.root, cur.id) : null;
  const keys = alertKeys({ sessions: [{ ...s, subagents: [] }] });
  const sub = h('div', { class: 'sub' }, STATE_LABEL[s.state] ?? 'Unknown',
    line ? [' · ', `${line.prefix} `, since(line.from, now), line.suffix ?? ''] : null);
  const sl = spendLine(s.spend);
  const spendRow = sl ? h('div', { class: 'spend', data: { dk: keyOf('$', p.root, s.sessionId) }, text: sl.text }) : null;
  const onTask = link
    ? h('div', { class: 'on-task' }, 'Working on ', h('button', { type: 'button', class: 'go', data: { go: link, fk: `go|${s.sessionId}` }, text: cur.title || 'a task' }))
    : h('div', { class: 'on-task none', text: 'Not linked to a task yet' });
  const active = arr(s.subagents).filter((a) => isActiveSub(a) && a.state !== 'stuck');
  const finished = arr(s.subagents).filter((a) => !isActiveSub(a)).length + (s.subagentsHidden ?? 0);
  const subs = active.length || finished
    ? h('div', { class: 'subnodes' },
      active.map((a) => h('div', { class: `node s-${STATE_CLASS[a.state] ?? 'idle'}`, data: { dk: keyOf('a', p.root, s.sessionId, a.agentId) } },
        h('span'),
        h('span', { class: 'name' }, icon('sub'), h('span', { class: 'label', text: a.description || 'Subagent' }), a.model ? h('span', { class: 'size', text: a.model }) : null),
        h('span', { class: 'meta' }, Number.isFinite(a.lastWriteMs) ? [since(a.lastWriteMs, now), ' ago'] : null))),
      finished ? h('div', { class: 'subs', text: `${finished} ${finished === 1 ? 'subagent' : 'subagents'} finished` }) : null)
    : null;
  return h('div', { class: `sess s-${cls}`, data: { dk: keyOf('s', p.root, s.sessionId), link, alerts: keys.join(',') || null } },
    h('div', { class: 'what' }, h('b', { text: sessionLabel(s) }), ' · ', what, sub, spendRow, onTask),
    life(s.life),
    s.evidence ? h('div', { class: 'evidence', text: s.evidence }) : null,
    s.hint ? h('div', { class: 'hint', text: s.hint }) : null,
    subs);
}

function stuckSubBlock(p, s, a, now) {
  return h('div', { class: 'sess s-stuck', data: { dk: keyOf('a', p.root, s.sessionId, a.agentId), alerts: `${s.sessionId}/${a.agentId}|${a.state}|${a.since ?? ''}` } },
    h('div', { class: 'what' }, h('b', { text: 'Subagent' }), ' · ', a.description || 'Subagent',
      h('div', { class: 'sub' }, `Looks stuck · started by session ${shortId(s.sessionId)}`,
        Number.isFinite(a.lastWriteMs) ? [' · last wrote ', since(a.lastWriteMs, now), ' ago'] : null)),
    life(a.life),
    a.evidence ? h('div', { class: 'evidence', text: a.evidence }) : null);
}

// A task's look from its liveness (render.mjs taskLiveness): only a session's current task shows as running.
function taskState(t, s, lv) {
  if (t.status === 'done') return 'done';
  if (lv === 'current') return s && ['stuck', 'waiting', 'gone'].includes(s.state) ? STATE_CLASS[s.state] : 'work';
  if (lv === 'waiting') return 'wait';
  if (lv === 'started' || lv === 'stale') return lv;
  return 'idle';
}

function epicState(e, byId) {
  const now = Date.now();
  const states = arr(e.tasks).map((t) => taskState(t, liveSession(byId, t), taskLiveness(t, byId, now, e.id)));
  for (const st of ['stuck', 'gone', 'wait', 'work', 'started', 'stale']) if (states.includes(st)) return st;
  return epicDone(e) ? 'done' : 'idle';
}

function taskLi(p, e, t, byId) {
  const now = Date.now();
  const lv = taskLiveness(t, byId, now, e.id);
  const current = lv === 'current';
  const s = current ? liveSession(byId, t) : null; // the live line and session chip only under a session's current task
  const st = taskState(t, s, lv);
  const link = s ? keyOf(p.root, t.id) : null;
  const nowTexts = s ? nowLines(s) : [];
  // Started or left open: one short muted note, so the task's name keeps its room; which session is in the hover.
  return h('li', null,
    h('div', { class: `node s-${st}`, data: { dk: keyOf('t', p.root, t.id), link } },
      h('span'),
      h('span', { class: 'name' }, icon(st), h('span', { class: `label${st === 'done' ? ' done-label' : ''}`, text: t.title || 'Untitled task' }),
        t.size ? h('span', { class: 'size', text: t.size }) : null),
      h('span', { class: 'meta' },
        s ? h('span', { class: 'who', text: `session ${shortId(s.sessionId)}` }) : null,
        lv === 'started' && t.sessionId ? h('span', { class: 't', text: 'earlier' }) : null,
        lv === 'stale' ? h('span', { class: 't', text: leftOpenText(t.changedMs, now) }) : null,
        t.spentMin > 0 ? h('span', { class: 't', text: formatDuration(t.spentMin * MIN) }) : null)),
    nowTexts.map((text) => h('div', { class: `now s-${STATE_CLASS[s.state] ?? 'work'}` }, h('span', { text }))));
}

function epicLi(p, e, byId, dflt = false) {
  const key = keyOf('e', p.root, e.id);
  const st = epicState(e, byId);
  const done = epicDone(e);
  const tasks = arr(e.tasks);
  const ndone = tasks.filter((t) => t.status === 'done').length;
  const open = foldOpen(openState, key, dflt);
  const spent = e.spentMin > 0 ? formatDuration(e.spentMin * MIN) : '';
  const meta = done ? `${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}` : `${ndone} of ${tasks.length}`;
  return h('li', null,
    h('div', { class: `node s-${st}`, data: { dk: key } },
      tasks.length ? tw(open, key, e.title, 'epic') : h('span'),
      h('span', { class: 'name' }, icon(st), h('span', { class: 'label' }, h('b', { text: e.title || 'Untitled' }))),
      h('span', { class: 'meta', text: spent ? `${meta} · ${spent}` : meta })),
    tasks.length ? h('ul', { class: 'tree', hidden: !open }, tasks.map((t) => taskLi(p, e, t, byId))) : null);
}

// One history row per epic, shown only with "Show all history" on; `note` (e.g. 'dropped') ends its line.
function histNodes(p, epics, note = '') {
  return epics.map((e) => {
    const spent = e.spentMin > 0 ? formatDuration(e.spentMin * MIN) : '';
    const text = [e.title || 'Untitled', shortDate(epicLastActivity(e)), spent, note].filter(Boolean).join(' · ');
    const st = epicDone(e) ? 'done' : 'idle';
    return h('div', { class: `node s-${st}`, data: { dk: keyOf('e', p.root, e.id) } },
      h('span'), h('span', { class: 'name' }, icon(st), h('span', { class: 'label done-label', text })), h('span'));
  });
}

const HIST_NOTE = { before: 'before the dashboard', dropped: 'dropped' };

// One state group (spec 2026-11-19 wayfinding): a foldable header, then its epics. History groups are always built
// and shown or hidden by "Show all history", with a one-line hint in their place while it is off.
function groupLi(p, g, epics, byId) {
  const key = keyOf('g', p.root, g.id);
  const open = foldOpen(openState, key, g.open);
  const label = `${g.label} (${epics.length})`;
  const items = g.history
    ? histNodes(p, epics, HIST_NOTE[g.id]).map((n) => h('li', null, n))
    : epics.map((e) => epicLi(p, e, byId, g.open));
  return h('li', { class: `group g-${g.id}${g.history ? ' histrow' : ''}`, hidden: g.history ? !showHistory : null },
    h('div', { class: 'node gh' }, tw(open, key, g.label, 'group'), h('span', { class: 'name' }, h('b', { text: label })), h('span')),
    h('ul', { class: 'tree', hidden: !open }, items));
}

const histHint = (text) => h('li', { class: 'histhint', hidden: showHistory },
  h('div', { class: 'node' }, h('span'), h('span', { class: 'name', text }), h('span')));

function treeOf(p, groups, byId) {
  if (GROUPS.every((g) => !groups[g.id].length)) return h('p', { class: 'noplan', text: 'No plan found' });
  const ul = h('ul', { class: 'tree' });
  for (const g of GROUPS) {
    const epics = groups[g.id];
    if (!epics.length) continue;
    ul.append(groupLi(p, g, epics, byId));
    // Plans from before the dashboard (decision 32) fold until they show progress; dropped plans only in history.
    if (g.history && g.id !== 'dropped') ul.append(histHint(`${g.label} (${epics.length})`));
  }
  return ul;
}

const groupsOf = (p, now, byId) => groupEpics(p.tree?.epics, now, liveIds(p), (t, epicId) => taskLiveness(t, byId, now, epicId));

function foldActs(p) {
  const b = (act, text, title) => h('button', { type: 'button', class: 'fold-act', title, data: { act, root: p.root }, text });
  return h('span', { class: 'fold-acts' },
    b('expand', 'Expand all', 'Open every group and plan in this project'),
    b('collapse', 'Collapse all', 'Fold every group and plan in this project'),
    b('focus', 'Focus', 'Back to the default: running and waiting work open, the rest folded'));
}

function panelFor(p, now) {
  const byId = new Map(arr(p.sessions).map((s) => [s.sessionId, s]));
  const groups = groupsOf(p, now, byId);
  const { shown } = groups;
  const keys = alertKeys(p);
  const fresh = unseenOf(keys).length > 0;
  const cls = STATE_CLASS[p.state] ?? 'idle';
  const sessions = arr(p.sessions);
  return h('article', { class: `panel s-${cls}${fresh ? ' changed' : ''}`, data: { state: stateTokens(p, shown), alerts: keys.join(',') || null, root: p.root } },
    h('div', { class: 'ph', data: { dk: keyOf('p', p.root) } },
      tw(true, keyOf('p', p.root), p.name, 'proj'),
      h('h2', { text: p.name, title: p.root }),
      fresh ? h('span', { class: 'newbadge', text: 'New' }) : null,
      p.state !== 'quiet' ? chip(p.state) : null,
      h('span', { class: 'meta' }, h('span', { text: leftText(p, shown, true) }),
        projectSpend(p.spend) ? h('span', { class: 'spend', data: { dk: keyOf('$', p.root) }, text: projectSpend(p.spend).text }) : null,
        p.tree?.spentMin > 0 ? h('span', { class: 't', text: formatDuration(p.tree.spentMin * MIN) }) : null),
      arr(p.tree?.epics).length ? foldActs(p) : null),
    p.error ? h('div', { class: 'err', text: p.error }) : null,
    sessions.flatMap((s) => [sessionBlock(p, s, now),
      ...arr(s.subagents).filter((a) => a.state === 'stuck').map((a) => stuckSubBlock(p, s, a, now))]),
    treeOf(p, groups, byId));
}

function quietRow(p, now) {
  const { shown } = foldEpics(p.tree?.epics, now, liveIds(p));
  const quietish = p.state === 'quiet' || p.state === 'idle';
  return h('div', { class: `qrow s-${STATE_CLASS[p.state] ?? 'idle'}`, data: { dk: keyOf('p', p.root), state: stateTokens(p, shown) } },
    tw(false, keyOf('p', p.root), p.name, 'proj'),
    h('b', { text: p.name, title: p.root }),
    h('span', { class: `qleft ${p.error ? 'err' : 'muted'}`, text: p.error || leftText(p, shown) }),
    quietish
      ? h('span', { class: 't muted', data: { quiet: Number.isFinite(p.quietSince) ? p.quietSince : null }, text: Number.isFinite(p.quietSince) ? `quiet ${agoWords(now - p.quietSince)}` : 'quiet' })
      : chip(p.state));
}

function sigOf(p, now, kind) {
  const ep = [...arr(p.tree?.epics).map((e) => keyOf('e', p.root, e.id)), ...GROUPS.map((g) => keyOf('g', p.root, g.id))]
    .map((k) => openState[k] ?? '-').join('');
  return `${kind}|${showHistory}|${Math.floor(now / HOUR)}|${ep}|${unseenOf(alertKeys(p)).length}|${JSON.stringify(p)}`;
}

function replaceKeepingFocus(old, el) {
  const a = document.activeElement;
  const fk = a && old.contains(a) ? a.dataset?.fk : null;
  old.replaceWith(el);
  if (fk) el.querySelector(`[data-fk="${CSS.escape(fk)}"]`)?.focus({ preventScroll: true });
}

/**
 * Keyed, incremental children: items are [{key, sig, build}] in display order. A child is rebuilt only when its
 * signature changed (focus carried over), removed when its key is gone, and moved only when out of order.
 */
// Panels kept as they were because the pointer was over them (spec rule 10); rebuilt once it leaves.
const heldPanels = new Set();
let userRender = false;
let mouse = null; // last mouse position; `:hover` goes stale in Chrome when the node under a still mouse is swapped
const pointerEl = () => (mouse ? document.elementFromPoint(mouse.x, mouse.y) : null);
const overTree = (el) => { const t = pointerEl(); return !!t && el.contains(t) && !!t.closest('ul.tree'); };
const overGrid = () => { const t = pointerEl(); return !!t && !!t.closest('#v-projects .grid'); };
let orderHeld = false;

function syncKeyed(container, cache, items, hold = null, keepOrder = false) {
  const keep = new Set(items.map((it) => it.key));
  for (const [k, rec] of cache) if (!keep.has(k)) { rec.el.remove(); cache.delete(k); }
  const els = items.map((it) => {
    let rec = cache.get(it.key);
    if (rec && rec.sig !== it.sig && hold && !userRender && rec.el.isConnected && hold(rec.el)) {
      heldPanels.add(rec.el);
      return rec.el;
    }
    if (!rec || rec.sig !== it.sig) {
      if (rec) heldPanels.delete(rec.el);
      const el = it.build();
      if (rec?.el.isConnected) replaceKeepingFocus(rec.el, el);
      rec = { sig: it.sig, el };
      cache.set(it.key, rec);
    }
    return rec.el;
  });
  if (keepOrder && !userRender) { // existing panels stay where they are; new ones go at the end
    orderHeld = true;
    for (const el of els) if (el.parentNode !== container) container.append(el);
    for (const c of [...container.children]) if (!els.includes(c)) c.remove();
    return;
  }
  els.forEach((el, i) => { if (container.children[i] !== el) container.insertBefore(el, container.children[i] ?? null); });
  while (container.children.length > els.length) container.lastElementChild.remove();
}

function sync(container, cache, list, build, now, kind) {
  const hold = kind === 'panel' ? overTree : null;
  syncKeyed(container, cache, list.map((p) => ({ key: p.root, sig: sigOf(p, now, kind), build: () => build(p, now) })), hold, kind === 'panel' && overGrid());
}

function renderByUser() {
  userRender = true;
  try { dirty.projects = true; render(); } finally { userRender = false; }
}

function renderProjects(now) {
  const projects = arr(model?.projects);
  const open = panelOrder(projects.filter(isOpen)); // A-Z: a card keeps its place whatever its state
  const quiet = projects.filter((p) => !isOpen(p));
  sync($('#v-projects .grid'), panels, open, panelFor, now, 'panel');
  const shownQuiet = showAllQuiet ? quiet : quiet.slice(0, QUIET_SHOWN);
  const list = $('#v-projects .qlist');
  $('.qmore', list)?.closest('.qrow')?.remove();
  sync(list, qrows, shownQuiet, quietRow, now, 'quiet');
  if (quiet.length > shownQuiet.length) {
    const n = quiet.length - shownQuiet.length;
    list.append(h('div', { class: 'qrow' }, h('span'), h('button', { type: 'button', class: 'qmore', data: { fk: 'qmore' }, text: `${n} more ${n === 1 ? 'project' : 'projects'}` }), h('span'), h('span')));
  }
  $('#v-projects .quiet').hidden = quiet.length === 0;
  const empty = $('#v-projects .empty');
  empty.hidden = projects.length > 0;
  if (model) empty.textContent = 'No Claude Code session is open, and no project has had one in the last week.';
}

// ---- Sessions view ------------------------------------------------------------------------------------------------

const sessionCache = new Map(); // row key -> {sig, el}

function sessionRow(p, s, fresh, keys, now) {
  const cls = STATE_CLASS[s.state] ?? 'idle';
  const { what, line } = sessionWhat(s);
  return h('div', { class: `srow s-${cls}${fresh ? ' changed' : ''}`, data: { state: filterToken(s.state), dk: keyOf('s', p.root, s.sessionId), alerts: keys.join(',') || null } },
    h('span', { class: 'cell state' }, chip(s.state), fresh ? [' ', h('span', { class: 'newbadge', text: 'New' })] : null),
    h('span', { class: 'cell', text: p.name }),
    h('span', { class: 'cell who-cell' }, h('b', { text: sessionLabel(s) }), ' · ', what,
      line && s.state !== 'idle' ? h('div', { class: 'muted' }, `${line.prefix} `, since(line.from, now), line.suffix ?? '') : null,
      watchedNote(s.pendingTool, now) ? h('div', { class: 'muted', title: watchedHover(s.pendingTool), data: { watched: s.pendingTool.watch.lastGrowthAt }, text: watchedNote(s.pendingTool, now) }) : null,
      s.evidence ? h('div', { class: 'evidence', text: s.evidence }) : null,
      s.hint ? h('div', { class: 'hint', text: s.hint }) : null),
    h('span', { class: `cell${currentTask(s) ? '' : ' muted'}`, text: currentTask(s)?.title || 'Not linked to a task yet' }),
    life(s.life),
    h('span', { class: 'cell ago' }, Number.isFinite(s.lastWriteMs) ? [since(s.lastWriteMs, now), ' ago'] : ''));
}

function subagentRow(p, s, a, akey, fresh, now) {
  const acls = STATE_CLASS[a.state] ?? 'idle';
  return h('div', { class: `srow subrow s-${acls}${fresh ? ' changed' : ''}`, data: { state: filterToken(a.state), dk: keyOf('a', p.root, s.sessionId, a.agentId), alerts: akey } },
    h('span', { class: 'cell state' }, chip(a.state), fresh ? [' ', h('span', { class: 'newbadge', text: 'New' })] : null),
    h('span', { class: 'cell', text: p.name }),
    h('span', { class: 'cell who-cell' }, h('span', { class: 'name' }, icon('sub'), ' ', h('b', { text: 'Subagent' }), ' · ', a.description || 'Subagent'),
      a.model ? [' ', h('span', { class: 'size', text: a.model })] : null,
      a.evidence ? h('div', { class: 'evidence', text: a.evidence }) : null),
    h('span', { class: 'cell muted', text: `Helper of session ${shortId(s.sessionId)}` }),
    life(a.life),
    h('span', { class: 'cell ago' }, Number.isFinite(a.lastWriteMs) ? [since(a.lastWriteMs, now), ' ago'] : ''));
}

function renderSessions(now) {
  const view = $('#v-sessions');
  if (!view.childElementCount) {
    view.append(h('div', { class: 'stable' }), h('p', { class: 'empty muted', text: 'No Claude Code session is open.', hidden: true }));
  }
  const items = [{
    key: 'head', sig: 'head',
    build: () => h('div', { class: 'srow head' }, ...['State', 'Project', 'Session', 'On task', 'Last hour', 'Last activity'].map((t) => h('span', { text: t }))),
  }];
  for (const p of arr(model?.projects)) {
    for (const s of arr(p.sessions)) {
      const keys = alertKeys({ sessions: [{ ...s, subagents: [] }] });
      const fresh = unseenOf(keys).length > 0;
      const row = { ...s, subagents: undefined };
      items.push({ key: keyOf('s', p.root, s.sessionId), sig: JSON.stringify([p.name, row, fresh]), build: () => sessionRow(p, s, fresh, keys, now) });
      for (const a of arr(s.subagents).filter(isActiveSub)) {
        const akey = a.state === 'stuck' ? `${s.sessionId}/${a.agentId}|${a.state}|${a.since ?? ''}` : null;
        const afresh = !!akey && !seen.has(akey);
        items.push({ key: keyOf('a', p.root, s.sessionId, a.agentId), sig: JSON.stringify([p.name, s.sessionId, a, afresh]), build: () => subagentRow(p, s, a, akey, afresh, now) });
      }
    }
  }
  const [table, empty] = view.children;
  syncKeyed(table, sessionCache, items);
  table.hidden = items.length === 1;
  empty.hidden = items.length > 1;
}

// ---- Triage view ----------------------------------------------------------------------------------------------------

const triageCache = { needs: new Map(), moving: new Map(), next: new Map() };

function triageItem(it, akey, fresh, now) {
  const { project: p, session: s, subagent: a } = it;
  const who = a ? a : s;
  const cls = STATE_CLASS[who.state] ?? 'idle';
  const { what, line } = a ? { what: a.description || 'Subagent', line: null } : sessionWhat(s);
  return h('div', { class: `titem s-${cls}${fresh ? ' changed' : ''}`, data: { state: filterToken(who.state), alerts: akey, dk: a ? keyOf('a', p.root, s.sessionId, a.agentId) : keyOf('s', p.root, s.sessionId) } },
    h('div', { class: 'top' }, chip(who.state), fresh ? h('span', { class: 'newbadge', text: 'New' }) : null,
      h('b', { text: a ? 'Subagent' : sessionLabel(s) }), h('span', { class: 'where', text: `in ${p.name}` })),
    h('div', null, what, line ? h('span', { class: 'muted' }, ' · ', `${line.prefix} `, since(line.from, now), line.suffix ?? '') : null),
    who.evidence ? h('div', { class: 'evidence', text: who.evidence }) : null,
    !a ? h('div', { class: `on-task${currentTask(s) ? '' : ' none'}`, text: currentTask(s) ? `Working on ${currentTask(s).title}` : 'Not linked to a task yet' }) : null);
}

function triageItems(list, now) {
  return list.map((it) => {
    const { project: p, session: s, subagent: a } = it;
    const who = a ?? s;
    const akey = (who.state === 'stuck' || who.state === 'waiting') ? `${a ? `${s.sessionId}/${a.agentId}` : s.sessionId}|${who.state}|${who.since ?? ''}` : null;
    const fresh = !!akey && !seen.has(akey);
    const key = a ? keyOf('a', p.root, s.sessionId, a.agentId) : keyOf('s', p.root, s.sessionId);
    return { key, sig: JSON.stringify([p.name, { ...s, subagents: undefined }, a ?? null, fresh]), build: () => triageItem(it, akey, fresh, now) };
  });
}

function upNextItem(p, tasks) {
  return h('div', { class: 'titem', data: { state: 'next' } },
    h('div', { class: 'top' }, h('b', { text: p.name })),
    h('ul', { class: 'tnext' }, tasks.slice(0, 5).map((x) => h('li', { data: { dk: keyOf('t', p.root, x.id) } }, x.title || 'Untitled task', ' ', h('span', { class: 'epic', text: `· ${x.epicTitle}` }))),
      tasks.length > 5 ? h('li', { class: 'muted', text: `and ${tasks.length - 5} more` }) : null));
}

function renderTriage(now) {
  const view = $('#v-triage');
  if (!view.childElementCount) {
    const col = (name, title, emptyText) => h('section', { class: 'tcol', data: { col: name } },
      h('h2', null, title, h('span', { class: 'num', text: '0' })),
      h('div', { class: 'tlist' }),
      h('p', { class: 'muted empty', text: emptyText, hidden: true }));
    view.append(h('div', { class: 'tgrid' },
      col('needs', 'Needs a look', 'Nothing needs a look.'), col('moving', 'Moving', 'Nothing is moving.'), col('next', 'Up next', 'Nothing planned.')));
  }
  const t = triage(model, now);
  const lists = {
    needs: triageItems(t.needs, now),
    moving: triageItems(t.moving, now),
    next: t.next.map(({ project: p, tasks }) => ({ key: p.root, sig: JSON.stringify([p.name, tasks]), build: () => upNextItem(p, tasks) })),
  };
  const counts = { needs: t.needs.length, moving: t.moving.length, next: t.next.reduce((n, x) => n + x.tasks.length, 0) };
  for (const name of Object.keys(lists)) {
    const col = $(`.tcol[data-col="${name}"]`, view);
    syncKeyed($('.tlist', col), triageCache[name], lists[name]);
    $('h2 .num', col).textContent = String(counts[name]);
    $('.empty', col).hidden = counts[name] > 0;
  }
}

// ---- the bar ------------------------------------------------------------------------------------------------------

function renderCounts(now) {
  const c = model?.counts ?? {};
  const next = triage(model, now).next.reduce((n, x) => n + x.tasks.length, 0);
  const vals = { stuck: c.stuck ?? 0, waiting: c.waiting ?? 0, working: c.working ?? 0, next };
  for (const b of $$('.counts b[data-count]')) b.textContent = String(vals[b.dataset.count] ?? 0);
}

let usageSig = null;
function renderUsage(now) {
  const u = usageView(model?.usage, now);
  const sig = JSON.stringify([u, model?.usage]);
  if (sig === usageSig) return;
  usageSig = sig;
  const box = $('.usage');
  if (!u.available) { box.replaceChildren(h('span', { class: 'muted', text: 'Usage not available' })); return; }
  const raw = [model.usage.fiveHour, model.usage.week];
  box.replaceChildren(...u.meters.map((m, i) => {
    if (m.pct === null) {
      return h('div', { class: 'meter' }, h('span', { class: 'lbl' }, m.label, h('b', { text: '–' })), h('span', { class: 'track' }), h('span', { class: 'rs', text: 'not available' }));
    }
    const fill = h('span', { class: 'fill' });
    fill.style.width = `${Math.max(0, Math.min(100, m.pct))}%`;
    return h('div', { class: `meter${m.hot ? ' hot' : ''}`, role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': m.pct, 'aria-label': `${m.label} usage` },
      h('span', { class: 'lbl' }, m.label, h('b', { text: `${m.pct}%` })),
      h('span', { class: 'track' }, fill),
      h('span', { class: 'rs' }, 'resets in ', until(raw[i].resetsAt, now)));
  }));
}

function banner(text, info = false) {
  const b = $('.banner');
  b.hidden = !text;
  b.textContent = text || '';
  b.classList.toggle('info', info);
}

// ---- render loop ----------------------------------------------------------------------------------------------------

function render() {
  if (!model || stopped) return;
  const now = Date.now();
  renderCounts(now);
  renderUsage(now);
  if (dirty[tab]) {
    dirty[tab] = false;
    if (tab === 'projects') renderProjects(now);
    else if (tab === 'sessions') renderSessions(now);
    else renderTriage(now);
  }
  applyFilter();
  setLit(litKey);
  // A rebuilt row keeps its tip: follow the anchor to its replacement, else hide.
  if (tipAnchor && !tipAnchor.isConnected) {
    const dk = tipAnchor.dataset.dk;
    const again = dk ? $(`[data-dk="${CSS.escape(dk)}"]`) : null;
    if (!again) hideTip();
    else {
      tipAnchor = again;
      if (tip.classList.contains('show')) {
        const item = details.get(dk);
        tip.textContent = item ? detailText({ ...item, now }) : tip.textContent;
        placeTip(again);
      }
    }
  }
}

function onModel(m) {
  if (!m || typeof m !== 'object') return;
  model = m;
  heard();
  buildDetails(m);
  banner(m.error || '');
  dirty.projects = dirty.sessions = dirty.triage = true;
  render();
  refreshTimers();
}

/** The server spoke (a model or a heartbeat): "updated Ns ago" counts from here. */
function heard() {
  heardAt = Date.now();
  $('.bar').classList.remove('offline');
  tickUpdated();
}

function applyFilter() {
  for (const el of $$('main [data-state]')) {
    el.classList.toggle('dim', !!filter && !el.dataset.state.split(' ').includes(filter));
  }
}

// "updated Ns ago" = when the server was last heard (model or heartbeat, R19); after 60 s of silence the bar says
// so instead. Rewritten every second.
function tickUpdated() {
  const box = $('.bar .updated');
  const silent = !stopped && heardAt > 0 && Date.now() - heardAt > SILENT_MS;
  $('.bar').classList.toggle('offline', stopped || silent);
  if (stopped) box.replaceChildren('Server stopped');
  else if (silent) box.replaceChildren('Server not responding');
  else box.replaceChildren('updated ', h('time', { text: heardAt ? updatedText(Date.now() - heardAt) : '…' }));
}
// Every 15 s: timers move, and the views re-render so time-based decisions (the waiting escalation in Triage,
// the 7-day fold) happen without waiting for a push. Unchanged rows keep their nodes (signatures).
function tickTimes() {
  if (!model || stopped) return;
  dirty.projects = dirty.sessions = dirty.triage = true;
  render();
  refreshTimers();
}
function refreshTimers() {
  const now = Date.now();
  for (const el of $$('[data-since]')) el.textContent = formatDuration(Math.max(0, now - Number(el.dataset.since)));
  for (const el of $$('[data-until]')) el.textContent = formatDuration(Math.max(0, Number(el.dataset.until) - now));
  for (const el of $$('[data-watched]')) el.textContent = watchedAgo(Number(el.dataset.watched), now);
  for (const el of $$('[data-quiet]')) el.textContent = `quiet ${agoWords(now - Number(el.dataset.quiet))}`;
}
setInterval(tickUpdated, 1000);
setInterval(tickTimes, 15000);

// ---- interactions ---------------------------------------------------------------------------------------------------

// Fold and unfold: epics in place, projects between the panels and the quiet list.
document.addEventListener('click', (e) => {
  const t = e.target.closest?.('.tw');
  if (t) {
    const key = t.dataset.fk;
    if (t.dataset.tw === 'epic' || t.dataset.tw === 'group') {
      const open = t.getAttribute('aria-expanded') !== 'true';
      t.setAttribute('aria-expanded', String(open));
      const list = t.closest('li')?.querySelector(':scope > ul.tree');
      if (list) list.hidden = !open;
      openState[key] = open;
      store.set('dash-open', openState);
    } else if (t.dataset.tw === 'proj') {
      // The time decides whether the project comes back when it next becomes active (render.mjs projectOpen).
      openState[key] = { open: t.getAttribute('aria-expanded') !== 'true', at: Date.now() };
      store.set('dash-open', openState);
      renderByUser();
      $(`[data-fk="${CSS.escape(key)}"]`)?.focus({ preventScroll: false });
    }
    return;
  }
  const act = e.target.closest?.('.fold-act');
  if (act) {
    const root = act.dataset.root;
    if (act.dataset.act === 'focus') {
      for (const k of projectFoldKeys(openState, root)) delete openState[k];
    } else {
      const panel = act.closest('.panel');
      for (const b of panel ? panel.querySelectorAll('.tw[data-tw="epic"], .tw[data-tw="group"]') : []) {
        if (b.closest('.histrow[hidden]')) continue; // history groups only while "Show all history" is on
        openState[b.dataset.fk] = act.dataset.act === 'expand';
      }
    }
    store.set('dash-open', openState);
    renderByUser();
    $(`.fold-act[data-act="${act.dataset.act}"][data-root="${CSS.escape(root)}"]`)?.focus({ preventScroll: true });
    return;
  }
  const go = e.target.closest?.('.go');
  if (go) { goToTask(go.dataset.go); return; }
  if (e.target.closest?.('.qmore')) { showAllQuiet = true; dirty.projects = true; render(); }
});

function goToTask(link) {
  const node = $(`#v-projects .node[data-link="${CSS.escape(link)}"]`);
  if (!node) return;
  for (let i = 0, list = node.closest('ul.tree[hidden]'); list && i < 4; i += 1, list = node.closest('ul.tree[hidden]')) {
    let top = list; // the outermost folded list: open from the outside in
    for (let up = top.parentElement?.closest('ul.tree[hidden]'); up; up = up.parentElement?.closest('ul.tree[hidden]')) top = up;
    const btn = top.closest('li')?.querySelector(':scope > .node .tw');
    if (!btn) break;
    btn.click();
  }
  node.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'center' });
  node.classList.add('flash');
  setTimeout(() => node.classList.remove('flash'), 1400);
}

// Session <-> task: hovering either lights both.
let litKey = null;
function setLit(k) {
  for (const x of $$('.linked')) x.classList.remove('linked');
  litKey = k;
  if (!k) return;
  for (const x of $$(`[data-link="${CSS.escape(k)}"]`)) {
    x.classList.add('linked');
    for (let ul = x.closest('ul.tree[hidden]'); ul; ul = ul.parentElement?.closest('ul.tree[hidden]')) {
      ul.parentElement?.querySelector(':scope > .node')?.classList.add('linked');
    }
  }
}
document.addEventListener('mouseover', (e) => {
  const k = e.target.closest?.('[data-link]')?.dataset.link ?? null;
  if (k !== litKey) setLit(k);
  const al = e.target.closest?.('[data-alerts]');
  if (al) markSeen(al.dataset.alerts.split(','));
});

// Count pills filter every view.
for (const b of $$('.count')) {
  b.addEventListener('click', () => {
    const on = b.getAttribute('aria-pressed') !== 'true';
    for (const x of $$('.count')) x.setAttribute('aria-pressed', 'false');
    b.setAttribute('aria-pressed', String(on));
    filter = on ? b.dataset.f : null;
    applyFilter();
  });
}

// Show all history.
const hist = $('.hist');
hist.checked = showHistory;
hist.addEventListener('change', () => {
  showHistory = hist.checked;
  store.set('dash-history', showHistory);
  for (const r of $$('.histrow')) r.hidden = !showHistory;
  for (const r of $$('.histhint')) r.hidden = showHistory;
});

// Tabs.
function setTab(name, focus = false) {
  tab = TABS.includes(name) ? name : 'projects';
  store.set('dash-tab', tab);
  for (const b of $$('.tabs [role="tab"]')) {
    const on = b.dataset.tab === tab;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
    if (on && focus) b.focus();
  }
  for (const n of TABS) $(`#v-${n}`).hidden = n !== tab;
  hideTip();
  render();
}
for (const b of $$('.tabs [role="tab"]')) {
  b.addEventListener('click', () => setTab(b.dataset.tab));
  b.addEventListener('keydown', (e) => {
    const i = TABS.indexOf(b.dataset.tab);
    if (e.key === 'ArrowRight') setTab(TABS[(i + 1) % TABS.length], true);
    else if (e.key === 'ArrowLeft') setTab(TABS[(i + TABS.length - 1) % TABS.length], true);
    else if (e.key === 'Home') { e.preventDefault(); setTab(TABS[0], true); }
    else if (e.key === 'End') { e.preventDefault(); setTab(TABS[TABS.length - 1], true); }
  });
}

// Light / dark: follows the system until you pick; your pick is remembered on this computer.
const modes = ['System', 'Light', 'Dark'];
const modeBtn = $('.modebtn');
const darkQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
const applyMode = (m) => {
  if (m === 'System') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = m.toLowerCase();
  modeBtn.textContent = themeLabel(m, darkQuery?.matches === true);
};
let mode = 'System';
try { mode = localStorage.getItem('dash-mode') || 'System'; } catch { /* blocked */ }
if (!modes.includes(mode)) mode = 'System';
applyMode(mode);
darkQuery?.addEventListener?.('change', () => applyMode(mode)); // Auto's label follows a system flip
modeBtn.addEventListener('click', () => {
  mode = modes[(modes.indexOf(mode) + 1) % 3];
  applyMode(mode);
  try { localStorage.setItem('dash-mode', mode); } catch { /* blocked */ }
});

// Stop the server.
let events = null;
const stopBtn = $('.stop');
stopBtn.addEventListener('click', async () => {
  stopBtn.disabled = true;
  stopBtn.textContent = 'Stopping…';
  try {
    const r = await fetch('/stop', { method: 'POST', headers: { 'X-Dash-Token': token } });
    if (!r.ok) throw new Error(String(r.status));
    stopped = true;
    events?.close();
    stopBtn.textContent = 'Stopped';
    $('.bar').classList.add('offline');
    tickUpdated();
    banner('The dashboard server has stopped. Start it again with /dashboard or the Start menu shortcut.', true);
  } catch {
    stopBtn.disabled = false;
    stopBtn.textContent = 'Stop';
    banner('Could not stop the dashboard server.');
  }
});

// ---- hover details: one plain paragraph about the item under a still mouse ------------------------------------------

const tip = h('div', { class: 'tip', role: 'tooltip' });
document.body.append(tip);
let tipTimer = null;
let tipAnchor = null;
let x0 = 0;
let y0 = 0;
function hideTip() { clearTimeout(tipTimer); tip.classList.remove('show'); tipAnchor = null; }
function placeTip(el) {
  const box = (el.closest('.panel, .tcol, .stable, .quiet') ?? el).getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const w = Math.min(320, innerWidth - 16);
  tip.style.maxWidth = `${w}px`;
  let left;
  let top = Math.min(Math.max(8, r.top), innerHeight - tip.offsetHeight - 8);
  if (box.right + 12 + w < innerWidth) left = box.right + 12;
  else if (box.left - w - 12 >= 8) left = box.left - w - 12;
  else { // no room beside the panel: just under (or over) the row
    left = Math.min(Math.max(8, r.left), innerWidth - w - 8);
    top = r.bottom + 8 + tip.offsetHeight < innerHeight ? r.bottom + 8 : Math.max(8, r.top - tip.offsetHeight - 8);
  }
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}
document.addEventListener('mousemove', (e) => {
  if (document.querySelector('.tour')) { hideTip(); return; }
  const el = e.target.closest?.('[data-dk]') ?? null;
  if (tip.classList.contains('show') && (Math.hypot(e.clientX - x0, e.clientY - y0) > 8 || el !== tipAnchor)) hideTip();
  if (!el) { clearTimeout(tipTimer); return; }
  if (el !== tipAnchor || !tip.classList.contains('show')) {
    clearTimeout(tipTimer);
    tipAnchor = el;
    x0 = e.clientX;
    y0 = e.clientY;
    tipTimer = setTimeout(() => {
      const at = tipAnchor; // the row under the mouse, or its replacement after an update
      if (!at?.isConnected) return;
      const item = details.get(at.dataset.dk);
      const text = item ? detailText({ ...item, now: Date.now() }) : '';
      if (!text) return;
      const lab = at.querySelector('.label');
      tip.textContent = tipText(lab?.textContent ?? '', !!lab && lab.scrollWidth > lab.clientWidth, text);
      placeTip(at);
      tip.classList.add('show');
    }, 650);
  }
});
document.addEventListener('mouseleave', hideTip);
function releaseHolds() {
  if (!heldPanels.size && !orderHeld) return;
  if ([...heldPanels].some((el) => el.isConnected && overTree(el)) || (orderHeld && overGrid())) return;
  heldPanels.clear();
  orderHeld = false;
  dirty.projects = true;
  render();
}
document.addEventListener('mousemove', (e) => { mouse = { x: e.clientX, y: e.clientY }; if (heldPanels.size || orderHeld) releaseHolds(); }, { passive: true });
document.documentElement.addEventListener('mouseleave', () => {
  mouse = null;
  releaseHolds();
});
document.addEventListener('scroll', hideTip, true);

// ---- symbol key: a small legend of the icons and colours -----------------------------------------------------------

const KEY_ROWS = [
  ['work', 'Working: a session is on it now'],
  ['wait', 'Waiting on you: a question or approval'],
  ['stuck', 'Looks stuck: hover the row for the evidence'],
  ['idle', 'Not started, or nothing running'],
  ['done', 'Done'],
  ['started', 'Started, not active: begun earlier, no session on it now'],
  ['stale', 'Left open: no change for a day and no session on it'],
  ['sub', 'A subagent, under its session'],
];
const keyBtn = $('.keybtn');
const keyPop = h('div', { class: 'keypop', role: 'dialog', 'aria-label': 'What the symbols mean', hidden: true },
  h('b', { text: 'What the symbols mean' }),
  h('ul', null, KEY_ROWS.map(([k, text]) => h('li', { class: `s-${k}` }, icon(k), h('span', { text })))),
  h('p', { class: 'muted', text: 'A coloured left edge on a project means something there needs a look; New until you have seen it.' }));
document.body.append(keyPop);
function setKey(open) {
  keyPop.hidden = !open;
  keyBtn?.setAttribute('aria-expanded', String(open));
  if (open && keyBtn) {
    const r = keyBtn.getBoundingClientRect();
    keyPop.style.top = `${r.bottom + 8}px`;
    keyPop.style.right = `${Math.max(8, innerWidth - r.right)}px`;
  }
}
keyBtn?.addEventListener('click', (e) => { e.stopPropagation(); setKey(keyPop.hidden); });
document.addEventListener('click', (e) => { if (!keyPop.hidden && !keyPop.contains(e.target)) setKey(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !keyPop.hidden) { setKey(false); keyBtn?.focus(); } });

// ---- help tour: spotlight each part in turn ---------------------------------------------------------------------------

const STEPS = [
  [['.counts'], 'The big picture', 'How many sessions look stuck, are waiting on you, or are working, and what is up next. Click one to focus on it.'],
  [['.usage'], 'Your Claude usage', 'Plan limits at a glance: the five-hour window, the week, and when the window resets.'],
  [['.tabs'], 'Three views', 'Projects shows each project and its plan. Sessions lists every open window and helper. Triage sorts what needs a look, what is moving and what is up next.'],
  [['.panel.s-stuck', '.panel.s-wait'], 'A project that needs a look', 'Projects with something wrong get a coloured edge, and a New badge until you have seen them.'],
  [['.panel.s-stuck .sess', '.panel .sess'], 'A session and its life line', 'Each Claude Code window, what it is doing, and its last hour as a line. Flat means it went quiet.'],
  [['.panel.s-stuck .evidence', '.panel .evidence'], 'Why we think it is stuck', 'Always the facts, never just a timer: CPU, output, and how long it has been silent.'],
  [['.panel.s-stuck .on-task', '.panel .on-task'], 'What it is working on', 'The task this session is on. Hover it to light up the task in the tree below.'],
  [['.panel .tree'], 'The plan', 'Each project as epics and tasks, grouped: running (what a session is on now), waiting on you, started but not active, next, done. Hover a task for what it is. Only running and waiting work starts open; Expand all, Collapse all and Focus are at the top of each project.'],
  [['.quiet'], 'Quiet projects', 'Projects with nothing running, folded to one line each so they do not crowd the page.'],
  [['.keybtn'], 'What the symbols mean', 'Each icon and colour, in one place.'],
  [['.helpbtn'], 'Hover for more', 'Hover over almost anything for a short plain-English explanation; a cut-off line shows in full. Key explains the symbols. Click ? to see this tour again.'],
];
const visible = (el) => !!el && el.getClientRects().length > 0;
const findStep = (sels) => { for (const s of sels) { const el = $$(s).find(visible); if (el) return el; } return null; };

const helpBtn = $('.helpbtn');
helpBtn.addEventListener('click', () => {
  if ($('.tour')) return;
  setTab('projects');
  hideTip();
  const steps = STEPS.filter(([sels]) => findStep(sels));
  if (!steps.length) return;
  let i = 0;
  const next = h('button', { type: 'button', class: 'next', text: 'Next' });
  const close = h('button', { type: 'button', class: 'ghost', text: 'Close' });
  const count = h('span');
  const title = h('h4');
  const para = h('p');
  const card = h('div', { class: 'card', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Tour of the dashboard' },
    title, para, h('div', { class: 'nav' }, count, h('span', null, close, ' ', next)));
  const hole = h('div', { class: 'hole' });
  const ov = h('div', { class: 'tour' }, hole, card);
  document.body.append(ov);
  const show = () => {
    const [sels, t, d] = steps[i];
    const el = findStep(sels);
    if (!el) { end(); return; }
    // Tall parts (a big panel) scroll to just under the sticky bar instead of the centre, so their top shows.
    const barH = $('.bar').getBoundingClientRect().height;
    const r0 = el.getBoundingClientRect();
    if (r0.height > (innerHeight - barH) * 0.6 && !el.closest('.bar')) window.scrollBy({ top: r0.top - barH - 16, behavior: 'instant' });
    else el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    const pad = 6;
    Object.assign(hole.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
    title.textContent = t;
    para.textContent = d;
    count.textContent = `${i + 1} of ${steps.length}`;
    next.textContent = i === steps.length - 1 ? 'Done' : 'Next';
    // Below the part, else above, else beside it, else at the bottom of the window: never over its top edge.
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const clampX = (x) => Math.max(10, Math.min(x, innerWidth - cw - 10));
    const clampY = (y) => Math.max(10, Math.min(y, innerHeight - ch - 10));
    let top;
    let left = clampX(r.left);
    if (r.bottom + 14 + ch <= innerHeight - 10) top = r.bottom + 14;
    else if (r.top - 14 - ch >= 10) top = r.top - 14 - ch;
    else if (r.right + 14 + cw <= innerWidth - 10) { left = r.right + 14; top = clampY(r.top); }
    else if (r.left - 14 - cw >= 10) { left = r.left - 14 - cw; top = clampY(r.top); }
    else top = innerHeight - ch - 10;
    card.style.top = `${top}px`;
    card.style.left = `${left}px`;
  };
  const onKey = (e) => {
    if (e.key === 'Escape') end();
    else if (e.key === 'Tab') { // keep focus inside the card
      e.preventDefault();
      (document.activeElement === next ? close : next).focus();
    }
  };
  const onResize = () => show();
  function end() {
    ov.remove();
    document.removeEventListener('keydown', onKey);
    removeEventListener('resize', onResize);
    helpBtn.focus();
  }
  next.addEventListener('click', () => { if (++i >= steps.length) end(); else show(); });
  close.addEventListener('click', end);
  document.addEventListener('keydown', onKey);
  addEventListener('resize', onResize);
  show();
  next.focus();
});

// ---- start --------------------------------------------------------------------------------------------------------

setTab(tab);
function connect() {
  events = new EventSource('/events');
  events.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    onModel(m);
  };
  events.addEventListener('hb', () => heard());
  // A dropped stream reconnects by itself; the bar turns to "Server not responding" only after 60 s of silence.
  events.onerror = () => {};
}
connect();
