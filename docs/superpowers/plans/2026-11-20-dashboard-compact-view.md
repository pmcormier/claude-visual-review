# Dashboard compact view Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/compact` view of the dashboard: one same-size square per active project, verbose like the Running
group, with a slim bar, a switch to and from the full page, and one project's full card on a click.

**Architecture:** The same page (`index.html`, `app.js`) serves both views; `app.js` picks the view from
`location.pathname`. What a square shows is decided by pure functions in `page/render.mjs`, tested in Node; `app.js`
only draws them. The server serves `index.html` at `/compact` too. No new data: the compact view reads the same
`/events` model.

**Tech Stack:** Node ESM, vanilla browser JS and CSS, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-20-dashboard-compact-view-design.md`

## Global Constraints

- No network or model calls; the dashboard never writes into projects.
- The repo is public: no personal paths or names in tracked files; `tools/check-personal.ps1` must pass.
- Tests never touch the real `~/.claude`.
- Docs move with installed files: `README.md` and `docs/setup-guide.html` mention the compact view and its address.
- The compact view never calls `markSeen`.
- Squares are A-Z by project name (decision 38); same size, about 320 × 300 px.
- Spend, tokens, fold controls and history never appear in a square.

## Review Focus

1. A project whose state changes between active and quiet while the view is open: it moves between the squares and
   the quiet line without the page jumping elsewhere.
2. `/compact#<project>` naming a project that is not in the model (renamed, gone): the view shows all squares,
   never a blank page.
3. A square whose content is far longer than 300 px: the headline stays visible and the body scrolls inside the
   square, never the square growing.
4. The server goes quiet while the compact view is open: the slim bar says "Server not responding", as the full
   page does.
5. A project with an `error` and no sessions: it gets a square showing the error, not a crash.

Tests for 2 and 5 are in Task 1; 1, 3 and 4 are checked live in Task 3.

---

### Task 1: What goes in the compact view (pure functions)

**Files:**
- Modify: `global/dashboard/page/render.mjs`
- Test: `tests/dashboard/page.test.mjs`

**Interfaces:**
- Produces, all exported from `page/render.mjs`:
  - `compactSplit(projects) -> { squares: Project[], quiet: Project[] }`. `squares` are projects whose state is
    `working`, `waiting`, `stuck` or `gone`, or that carry an `error`; `quiet` is the rest. Both are A-Z by name,
    ignoring case (reuse `panelOrder`).
  - `busiestSession(p) -> Session|null`: the alive session with the latest `lastWriteMs`, else null.
  - `squareSteps(epic, currentTaskId) -> { done: number, items: Task[], more: number }`. A work-log epic
    (`source === 'worklog'`) lists every task in `items` (`done: 0, more: 0`). Any other epic: `done` counts done
    tasks, `items` is the current task then up to the next three not-done tasks after it, `more` is the rest.
  - `viewFromLocation(pathname, hash, projects) -> { view: 'compact'|'full', project: Project|null }`. `view` is
    `compact` only for `pathname === '/compact'`. `project` is the project whose name matches the decoded hash,
    else null.

- [x] **Step 1: Write the failing tests**

```js
test('compactSplit: active, gone and unreadable projects get squares, A-Z; the rest are quiet', () => {
  const p = (name, state, error = null) => ({ name, state, error });
  const { squares, quiet } = compactSplit([p('zeta', 'working'), p('Alpha', 'quiet'), p('beta', 'gone'),
    p('gamma', 'idle'), p('delta', 'waiting'), p('eps', 'quiet', 'Could not read this project'), p('Kappa', 'stuck')]);
  assert.deepEqual(squares.map((x) => x.name), ['beta', 'delta', 'eps', 'Kappa', 'zeta']);
  assert.deepEqual(quiet.map((x) => x.name), ['Alpha', 'gamma']);
  assert.deepEqual(compactSplit(null), { squares: [], quiet: [] });
});

test('busiestSession: the live session heard from last', () => {
  const s = (id, alive, lastWriteMs) => ({ sessionId: id, alive, lastWriteMs });
  assert.equal(busiestSession({ sessions: [s('a', true, 5), s('b', true, 9), s('c', false, 20)] }).sessionId, 'b');
  assert.equal(busiestSession({ sessions: [s('c', false, 20)] }), null);
  assert.equal(busiestSession({}), null);
});

test('squareSteps: a checklist shows every step; a plan folds done work and shows three ahead', () => {
  const t = (id, status) => ({ id, status });
  const wl = { source: 'worklog', tasks: [t('1', 'done'), t('2', 'doing'), t('3', 'next')] };
  assert.deepEqual(squareSteps(wl, '2'), { done: 0, items: wl.tasks, more: 0 });
  const plan = { source: 'plan', tasks: [t('1', 'done'), t('2', 'done'), t('3', 'doing'), t('4', 'next'),
    t('5', 'next'), t('6', 'next'), t('7', 'next'), t('8', 'next')] };
  const r = squareSteps(plan, '3');
  assert.equal(r.done, 2);
  assert.deepEqual(r.items.map((x) => x.id), ['3', '4', '5', '6']);
  assert.equal(r.more, 2);
});

test('viewFromLocation: /compact picks the compact view; an unknown project in the hash opens nothing', () => {
  const ps = [{ name: 'anatomy to scale' }, { name: 'nimbus' }];
  assert.deepEqual(viewFromLocation('/compact', '#nimbus', ps), { view: 'compact', project: ps[1] });
  assert.deepEqual(viewFromLocation('/compact', '#anatomy%20to%20scale', ps), { view: 'compact', project: ps[0] });
  assert.deepEqual(viewFromLocation('/compact', '#gone-project', ps), { view: 'compact', project: null });
  assert.deepEqual(viewFromLocation('/compact', '#%E0%A4%A', ps), { view: 'compact', project: null });
  assert.deepEqual(viewFromLocation('/', '', ps), { view: 'full', project: null });
});
```

Add the four names to the test file's import from `render.mjs`.

- [x] **Step 2: Run to verify they fail**

Run: `node --test tests/dashboard/page.test.mjs`
Expected: FAIL, "does not provide an export named 'compactSplit'".

- [x] **Step 3: Implement the four functions in `page/render.mjs`**

`squareSteps` with no current task in a plan epic (`currentTaskId` not found) starts `items` at the first not-done
task. `viewFromLocation` must not throw on a malformed hash (`decodeURIComponent` in a try).

- [x] **Step 4: Run to verify they pass**

Run: `node --test tests/dashboard/`
Expected: PASS, 0 fail.

- [x] **Step 5: Commit**

```bash
git add global/dashboard/page/render.mjs tests/dashboard/page.test.mjs
git commit -m "dashboard-compact-view Task 1: what goes in the compact view"
```

### Task 2: The server serves the page at /compact

**Files:**
- Modify: `global/dashboard/server.mjs` (the `path === '/'` branch, and the header comment listing routes)
- Test: `tests/dashboard/server.test.mjs`

**Interfaces:**
- Produces: `GET /compact` returns the same HTML as `GET /`, token meta included.

- [ ] **Step 1: Write the failing test**

```js
test('/compact serves the page with its token, like /', async () => {
  // start a server the way the other tests in this file do
  const a = await get(port, '/');
  const b = await get(port, '/compact');
  assert.equal(b.status, 200);
  assert.match(b.headers['content-type'], /text\/html/);
  assert.equal(tokenOf(b.body), tokenOf(a.body));
  assert.equal((await get(port, '/compact/x')).status, 404);
});
```

Use the file's existing helpers for starting a server and fetching (names as they are in the file).

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/dashboard/server.test.mjs`
Expected: FAIL, 404 for `/compact`.

- [ ] **Step 3: Serve `index.html` for `path === '/compact'`** with the same token replacement as `/`.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/dashboard/`
Expected: PASS, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add global/dashboard/server.mjs tests/dashboard/server.test.mjs
git commit -m "dashboard-compact-view Task 2: the page at /compact"
```

### Task 3: The compact view on the page

**Files:**
- Modify: `global/dashboard/page/index.html` (a `<section id="v-compact" hidden>` with `.cgrid`, `.cquiet` and
  `.cone`; a view switch in `.bar .right`)
- Modify: `global/dashboard/page/app.js`
- Modify: `global/dashboard/page/app.css`

**Interfaces:**
- Consumes (Task 1): `compactSplit`, `busiestSession`, `squareSteps`, `viewFromLocation`; existing `panelFor`,
  `chip`, `life`, `nowLines`, `watchedNote`, `tickUpdated`.

What to build, in the page's existing style:
- **Mode.** At start, `viewFromLocation(location.pathname, location.hash, …)` sets `document.body.classList`
  `compact` for the compact view. In compact mode CSS hides `.counts`, `.usage`, the history label, `.stop`,
  `.keybtn`, `.helpbtn` and `.tabs`; the bar keeps the brand, `.updated` and the switch. `render()` draws
  `#v-compact` instead of the tab views. `hashchange` re-renders.
- **The switch.** In the bar: a link "Compact" (on the full page) or "Full page" (on the compact view) with
  `href` `/compact` or `/`, so a plain click navigates and Ctrl-click or middle-click opens a tab natively; next to
  it a ↗ button that calls `window.open(href, '_blank', 'width=700,height=900')` from the full page and
  `window.open(href, '_blank')` from the compact view. Title texts: "Open the compact view in a new window" and
  "Open the full page in a new window".
- **A square** (`<article class="square s-<state>" tabindex="0" role="button">`, keyed by project root, rebuilt
  only when its project's JSON changes, like `sync`):
  - `.sqhead` (does not scroll): the name, `chip(p.state)`, and `life(busiestSession(p)?.life)` when there is one.
  - `.sqbody` (`overflow: auto`): for each live session with a current task, the task's title, then its steps
    from `squareSteps` (a "✓ N done" line when `done > 0`, each item with its state icon, "+N more" when
    `more > 0`), then `nowLines(s)` as lines and `watchedNote` per running tool when it has one. The project's
    `error` shows here when set. Stuck subagents show their evidence line, as on the full card.
  - `.sqnext`: "Next: <title>" from the first task of the project's Next group (`groupEpics`), when there is one.
  - Size: `width: 320px; height: 300px`, grid `repeat(auto-fill, 320px)`, gap as `.grid`; at phone width one
    column of full width.
- **The quiet line** (`.cquiet`): "Quiet:" then each quiet project's name as a link to `/compact#<name>`, separated
  by " · "; hidden when there are none.
- **One project** (`/compact#<name>` and the project exists): hide `.cgrid` and `.cquiet`; `.cone` holds a bar with
  a "Back to all" button (clears the hash) and a "Show history" checkbox (the page's existing `showHistory` and its
  stored value), then `panelFor(p, now)` without the project fold arrow (add a `{ compact: true }` option to
  `panelFor` that leaves out `tw(...)` in `.ph`). A click or Enter on a square, or a quiet name, sets the hash;
  Escape clears it.
- **No "New" marks in compact mode:** the handler that calls `markSeen` returns early when the body has `compact`.
  A square whose state changed since the last render gets the `changed` class the full page uses.

- [ ] **Step 1: Build the mode, switch, squares, quiet line and one-project view as above.**

- [ ] **Step 2: Syntax check and unit tests**

Run: `node --check global/dashboard/page/app.js; node --test tests/dashboard/`
Expected: no output from the check; PASS, 0 fail.

- [ ] **Step 3: Live check** (install with `./install.ps1 -Owner -OnConflict Skip`, restart the server, open
  `http://127.0.0.1:47800/compact` in Playwright at 700 × 900 and at 1600 × 500):
  - squares A-Z, same size, several columns at 1600 wide, one column at 700;
  - a square with a long body scrolls inside, its head stays (Review Focus 3);
  - `/compact#no-such-project` shows all squares (Review Focus 2);
  - clicking a square opens the full card with "Back to all"; Escape returns;
  - the full page shows "Compact" and ↗; the compact view shows "Full page" and ↗;
  - stop the server: within 60 s the compact bar reads "Server not responding" (Review Focus 4); restart it.
  Save screenshots to the scratchpad for the end report.

- [ ] **Step 4: Commit**

```bash
git add global/dashboard/page/index.html global/dashboard/page/app.js global/dashboard/page/app.css
git commit -m "dashboard-compact-view Task 3: the compact view on the page"
```

### Task 4: Docs and decision

**Files:**
- Modify: `README.md` (Dashboard row), `docs/setup-guide.html` (where the dashboard page is described),
  `docs/decisions.md` (decision 40)

- [ ] **Step 1: Write the docs.** README and the setup guide: one sentence each, "a compact view at
  `127.0.0.1:<port>/compact` shows one square per active project, for a side pane or a second screen; switch
  between the views from the bar". Decision 40: the owner's goal in his words, approach A over B and C and why,
  the picks (active projects plus a quiet line, its own address with a switch, A-Z), and the builder's calls.

- [ ] **Step 2: Full suite and personal check**

Run: `pwsh -NoProfile -File tests/run.ps1; pwsh -NoProfile -File tools/check-personal.ps1`
Expected: "0 failed"; the personal check exits 0.

- [ ] **Step 3: Commit**

```bash
git add README.md docs/setup-guide.html docs/decisions.md
git commit -m "dashboard-compact-view Task 4: docs and decision"
```
