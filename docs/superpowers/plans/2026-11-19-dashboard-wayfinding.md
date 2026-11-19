# Dashboard Wayfinding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each project's tree on the Projects view is grouped by state (Running, Waiting on you, Next, Done, then
history groups), opens only running and waiting work by default, and gets Expand all / Collapse all / Focus, lit
folded parents, a symbol key, full labels in the hover pop-up and corrected help text.

**Architecture:** Page only. A pure `groupEpics` in `render.mjs` splits `foldEpics`' result into state groups,
sorted newest first, and a pure `foldOpen` resolves fold state from hand-set keys or the group's default.
`app.js` renders group headers, buttons, lighting, the key and the pop-up from those. No server or model change.

**Tech Stack:** Node built-ins, `node:test`, plain browser JS (ES modules), CSS.

**Spec:** `docs/superpowers/specs/2026-11-19-dashboard-wayfinding-design.md`

## Global Constraints

- No change to the server, the model, the Sessions view or the Triage view.
- Fold state stays in `localStorage` key `dash-open`; a present key means "the person set this". Focus deletes the
  project's keys.
- Work left is unchanged: "shown" = Running + Waiting + Next + Done; "Quiet for a week" stays out.
- Group order and names, exactly: `Running`, `Waiting on you`, `Next`, `Done`; history: `Quiet for a week`,
  `Done earlier`, `Before the dashboard`, `dropped`.
- The 7-day cutoff is the existing `EARLIER_AFTER_MS`.
- The repo is public: nothing personal in tracked files; `tools/check-personal.ps1` passes before every commit.
- Docs move with installed files (README, `docs/setup-guide.html`, `docs/setup-prompt.md` when what is installed
  or how changes); a "why" choice gets a `docs/decisions.md` entry.
- Commit subjects start `dashboard-wayfinding Task N: ...`.
- Tests: `node --test tests/dashboard/` and `pwsh -NoProfile -File tests/run.ps1`; they never touch the real
  `~/.claude`.

## Review Focus

1. An epic with one `work` task and one `wait` task lands in Running, not Waiting (spec rule 1).
2. A re-render while the pointer is over a project's tree doesn't reorder or regroup that tree (rule 10).
3. Going to a task inside a folded group opens the group and the epic, and both become hand-set (rule 7).
4. After Expand all, an epic that arrives later follows its group's default, not "expanded" (rule 5).
5. Epics with no known activity sort last in their group, in source order (rule 9).

---

### Task 1: `groupEpics` and `foldOpen` in render.mjs

**Files:**
- Modify: `global/dashboard/page/render.mjs` (after `foldEpics`)
- Test: `tests/dashboard/page.test.mjs`

**Interfaces:**
- Consumes: `foldEpics(epics, now, liveSessionIds)`, `epicDone`, `epicLastActivity`.
- Produces:
  - `GROUPS`: a frozen array of `{ id, label, history, open }`, in the order `running`, `waiting`, `next`,
    `done`, `quiet`, `doneEarlier`, `before`, `dropped`. The labels are as in Global Constraints. `history` is
    true for the last four. `open` (the default) is true only for `running` and `waiting`.
  - `groupEpics(epics, now, liveSessionIds, stateOf) -> { running, waiting, next, done, quiet, doneEarlier, before, dropped, shown }`.
    Each value is an array of epics. `stateOf(task)` returns `'work'|'stuck'|'gone'|'wait'|'idle'|'done'`.
    `shown` is running, then waiting, then next, then done.
  - `foldOpen(openState, key, dflt) -> boolean`: the stored boolean if there is one, else `dflt`.
  - `projectFoldKeys(openState, root) -> string[]`: every key in `openState` for that project, used by Focus.
    Keys are `keyOf` strings joined with `|` whose second part is `root`: `e|root|id`, `g|root|groupId`.

- [ ] **Step 1: Write the failing tests**

```js
test('groupEpics: exclusive groups, running wins over waiting', () => {
  const st = { a: 'work', b: 'wait', c: 'idle', d: 'done', s: 'stuck', g: 'gone' };
  const stateOf = (t) => st[t.id];
  const ep = (id, ids, extra = {}) => ({ id, title: id, tasks: ids.map((i) => ({ id: i, status: i === 'd' ? 'done' : i === 'a' ? 'doing' : 'next', startedMs: NOW - HOUR })), ...extra });
  const r = groupEpics([ep('mix', ['a', 'b']), ep('w', ['b', 'c']), ep('n', ['c']), ep('fin', ['d']), ep('stk', ['s']), ep('gon', ['g'])], NOW, new Set(), stateOf);
  assert.deepEqual(r.running.map((e) => e.id).sort(), ['gon', 'mix', 'stk']);
  assert.deepEqual(r.waiting.map((e) => e.id), ['w']);
  assert.deepEqual(r.next.map((e) => e.id), ['n']);
  assert.deepEqual(r.done.map((e) => e.id), ['fin']);
  assert.deepEqual(r.shown.map((e) => e.id).slice(-3), ['w', 'n', 'fin']);
});

test('groupEpics splits the week-old fold into quiet and done earlier', () => {
  const old = NOW - 8 * DAY;
  const r = groupEpics([
    { id: 'q', tasks: [{ id: '1', status: 'next', startedMs: old }] },
    { id: 'de', tasks: [{ id: '2', status: 'done', doneMs: old }] },
  ], NOW, new Set(), (t) => (t.status === 'done' ? 'done' : 'idle'));
  assert.deepEqual(r.quiet.map((e) => e.id), ['q']);
  assert.deepEqual(r.doneEarlier.map((e) => e.id), ['de']);
  assert.equal(r.shown.length, 0);
});

test('groupEpics sorts newest first, unknown activity last in source order', () => {
  const t = (ms) => [{ id: 'x', status: 'next', ...(ms ? { startedMs: ms } : {}) }];
  const r = groupEpics([{ id: 'u1', tasks: t() }, { id: 'old', tasks: t(NOW - 2 * DAY) }, { id: 'u2', tasks: t() }, { id: 'new', tasks: t(NOW - HOUR) }],
    NOW, new Set(), () => 'idle');
  assert.deepEqual(r.next.map((e) => e.id), ['new', 'old', 'u1', 'u2']);
});

test('groupEpics keeps before and dropped, and handles null', () => {
  const r = groupEpics([{ id: 'b', before: true, tasks: [] }, { id: 'x', dropped: true, tasks: [] }], NOW, new Set(), () => 'idle');
  assert.deepEqual([r.before.length, r.dropped.length], [1, 1]);
  assert.equal(groupEpics(null, NOW, null, () => 'idle').shown.length, 0);
});

test('foldOpen and projectFoldKeys', () => {
  assert.equal(foldOpen({ k: false }, 'k', true), false);
  assert.equal(foldOpen({}, 'k', true), true);
  assert.deepEqual(projectFoldKeys({ 'e|r1|a': true, 'g|r1|next': false, 'e|r2|a': true, 'p|r1': true }, 'r1').sort(), ['e|r1|a', 'g|r1|next']);
  assert.deepEqual(GROUPS.filter((g) => g.open).map((g) => g.id), ['running', 'waiting']);
});
```

- [ ] **Step 2: Run them and check they fail**
  Run `node --test tests/dashboard/page.test.mjs`. Expected: FAIL, because `groupEpics` is not exported.
- [ ] **Step 3: Implement**
  - Build on `foldEpics`: split its `shown` by state, and its `earlier` by `epicDone`.
  - For each epic, the state precedence is any `work`/`stuck`/`gone` → running; else any `wait` → waiting; else
    unfinished → next; else done.
  - Sort with `epicLastActivity` descending, nulls last. The sort is stable.
  - `projectFoldKeys` keeps only `e|` and `g|` keys. The project's own `p|` key is its panel fold, which Focus
    leaves alone.
- [ ] **Step 4: Run the tests and check they pass**
  Run `node --test tests/dashboard/`. Expected: all pass, including the existing `foldEpics` tests.
- [ ] **Step 5: Commit** `dashboard-wayfinding Task 1: groupEpics and foldOpen`.

### Task 2: Grouped tree, default folds, Expand all / Collapse all / Focus

**Files:**
- Modify: `global/dashboard/page/app.js` (`epicLi`, `histRows`, `histHint`, `treeOf`, `panelFor`, the fold click
  handler, `sigOf`)
- Modify: `global/dashboard/page/app.css`
- Test: `tests/dashboard/page.test.mjs` (pure parts only), plus a browser check

**Interfaces:**
- Consumes: `GROUPS`, `groupEpics`, `foldOpen` and `projectFoldKeys` from Task 1, and `taskState` and
  `liveSession` in app.js.
- Produces:
  - Group header rows: `li.group > .node` with a `.tw` that has `data-tw="group"` and `data-fk="g|<root>|<groupId>"`,
    a label `"<label> (<n>)"`, then `ul.tree` with the group's epics.
  - Panel buttons: `button.fold-act[data-act="expand"|"collapse"|"focus"][data-root]`.

- [ ] **Step 1: Render the groups**
  - `treeOf` renders the non-history groups that aren't empty, in `GROUPS` order.
  - A group is open when `foldOpen(openState, 'g|root|id', group.open)` is true.
  - An epic's default is its group's `open`, so `epicLi` takes the group's default.
  - With "Show all history" off, each non-empty history group keeps a one-line hint (`"<label> (<n>)"`), as
    `histHint` does today. `dropped` keeps no hint, as today.
  - With "Show all history" on, history groups render like the main groups, folded by default, with their
    epics as today's history rows.
- [ ] **Step 2: Handle clicks**
  - The click handler treats `data-tw="group"` like `epic`: it toggles its list, then writes and stores the key.
  - `fold-act` buttons:
    - `expand` and `collapse` write `true` or `false` for every rendered main group and epic of that project,
      and for history groups when `showHistory` is on.
    - `focus` deletes `projectFoldKeys(openState, root)`.
    - Then store and re-render.
  - `sigOf` includes the group keys and the epic keys, so a fold change re-renders.
- [ ] **Step 3: Panel header buttons**
  - In `panelFor`'s `.ph`, after the meta, add three small text buttons: "Expand all", "Collapse all", "Focus".
    Each has a `title` explaining it ("Focus: back to the default: running and waiting work open, the rest
    folded").
  - Style them as quiet links in `app.css`. They wrap on narrow panels.
- [ ] **Step 4: Run the tests**
  Run `node --test tests/dashboard/`. Expected: all pass.
- [ ] **Step 5: Browser check**
  - Run `./install.ps1`, restart the server (stop the pid in `~/.claude/dashboard/server.json`, then run
    `node ~/.claude/dashboard/launcher.mjs` from `~`), and open the page with Playwright.
  - Check that:
    - a project with many plans shows Running and Waiting open, and every other group as a one-line folded
      header;
    - Expand all opens every epic, Collapse all folds them, and Focus restores the default view;
    - the state survives a reload.
  - Take light and dark screenshots.
- [ ] **Step 6: Commit** `dashboard-wayfinding Task 2: grouped tree and fold buttons`.

### Task 3: Lit parents, going to a task, no reorder under the mouse

**Files:**
- Modify: `global/dashboard/page/app.js` (`setLit`, `goToTask`, `syncKeyed`/`sync`)
- Modify: `global/dashboard/page/app.css` (`.linked` on group headers)

**Interfaces:**
- Consumes: the group markup from Task 2.

- [ ] **Step 1: Light the folded parents.** In `setLit`, for each lit node inside a `ul.tree[hidden]`, also add
  `linked` to the `.node` of every enclosing `li` whose list is hidden (the epic row and the group header).
- [ ] **Step 2: Open the parents when going to a task.** In `goToTask`, while the node is inside a `ul.tree[hidden]`,
  click the `.tw` of the nearest hidden ancestor (group first, then epic). Each click writes its hand-set key
  through the normal handler.
- [ ] **Step 3: No reordering under the mouse**
  - In `syncKeyed`, when an existing element for a key matches `:hover` and its signature changed, keep the old
    element and mark it stale.
  - Add one `mouseleave` listener on the projects grid that re-renders when a stale element was kept.
  - This applies to the Projects view only (`kind === 'panel'`).
- [ ] **Step 4: Browser check**
  - Hovering a session lights its task's folded epic and group.
  - Clicking the session's task link opens both and scrolls to the task.
  - With the mouse held over a panel, a forced update (the epic state changes) leaves the order as it was until
    the mouse leaves.
- [ ] **Step 5: Run the tests and commit**
  Run `node --test tests/dashboard/`. Expected: pass. Commit `dashboard-wayfinding Task 3: lit parents and steady
  order`.

### Task 4: Symbol key, full label in the pop-up, help text

**Files:**
- Modify: `global/dashboard/page/index.html` (header), `global/dashboard/page/app.js` (`STEPS`, the hover
  handler), `global/dashboard/page/app.css`
- Modify: `global/dashboard/page/render.mjs` and the test file, for `tipText`

**Interfaces:**
- Produces: `tipText(fullLabel, cutOff, text) -> string` in `render.mjs`. It returns `fullLabel + '\n\n' + text`
  when `cutOff` is true and `fullLabel` is not empty, and `text` otherwise.

- [ ] **Step 1: Write the failing test** for `tipText`, with the case `('Long title', true, 'Explains')` returning
  `'Long title\n\nExplains'`, and `('Long title', false, 'Explains')` returning `'Explains'`. Run it and see it
  fail.
- [ ] **Step 2: Implement `tipText`.** In the hover handler, compute `cutOff` from the row's `.label`
  (`scrollWidth > clientWidth`). Show the tip with `white-space: pre-line`.
- [ ] **Step 3: Key**
  - Add a `Key` button next to the `?` in the header.
  - It toggles a small popover listing the six icons (working, idle, done, looks stuck, waiting on you,
    subagent), each drawn with the page's own `icon()`, and the coloured left edge of a project that needs a
    look.
  - Escape and clicking outside close it.
- [ ] **Step 4: Help text in `STEPS`**
  - "The plan": `'Each project as epics and tasks, grouped: running, waiting on you, next, done. Only running and
    waiting work starts open; Expand all, Collapse all and Focus are at the top of each project.'`
  - "Hover for more": `'Hover over almost anything for a short plain-English explanation; a cut-off line shows in
    full. Key explains the symbols. Click ? to see this tour again.'`
  - Add a step for `.keybtn`: `'What the symbols mean'`, `'Each icon and colour, in one place.'`
- [ ] **Step 5: Run the tests and do a browser check**
  - Run `node --test tests/dashboard/`. Expected: pass.
  - Check the key, the full label on a cut-off row, and the tour. Take screenshots in light and dark.
- [ ] **Step 6: Commit** `dashboard-wayfinding Task 4: key, full labels, help text`.

### Task 5: Docs, decision, install and live check

**Files:**
- Modify: `docs/decisions.md` (new entry 33), and `README.md` if its Dashboard row describes the tree
- Modify: this plan (tick the boxes)

- [ ] **Step 1: Decision 33**
  - Record why the grouping lives in the page, the group precedence, "Quiet for a week", and no reordering
    under the mouse.
  - Record what was ruled out: sorting on the server, a flat list, and a sort menu for now.
- [ ] **Step 2: Run the checks.** Run `pwsh -NoProfile -File tests/run.ps1` (expected: `0 failed`) and
  `tools/check-personal.ps1` (expected: exit 0).
- [ ] **Step 3: Install and check live**
  - Run `./install.ps1`, restart the server, and check the owner's largest project.
  - Record the result in decision 33: how many groups and epics are visible on first load, before and after.
- [ ] **Step 4: Commit** `dashboard-wayfinding Task 5: decision 33 and live check`.
