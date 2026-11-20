# Dashboard clarity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Running shows only what each session is doing now, every task says in one plain line what it is, stale
checklist steps stop reading as waits, sessions show their title, and a folded project comes back when it works.

**Architecture:** The server supplies facts (`about`, `changedMs`, `leftOpen` on tasks; `title` on sessions;
`activeSinceMs` on projects). The page decides what they mean through pure functions in `page/render.mjs`
(`taskLiveness`, `groupEpics`, `projectOpen`), which `app.js` only draws.

**Tech Stack:** Node built-ins only, `node:test`; the page is ES modules and plain DOM.

**Spec:** `docs/superpowers/specs/2026-11-19-dashboard-clarity-design.md`

## Global Constraints

- No network or model calls in the dashboard; no summaries written by a model.
- Tests never touch the real `~/.claude` (use the existing `CVR_DASH_CLAUDE_HOME` / tmpdir fixtures).
- The repo is public: `tools/check-personal.ps1` passes before every commit (pre-commit hook). No drive paths in tests.
- Docs move with installed files: README, `docs/setup-guide.html`, `docs/setup-prompt.md` in the same change.
- Old work-log lines without `about` / `stepsAbout` still read.
- Copy: `Started, not current`; `left open N days ago`; `No description yet`.
- Stale = doing or waiting, session not alive (or none), and `changedMs` more than 24 hours old.
- No change to the headline counts or Triage.
- Commit messages start `dashboard-clarity Task N: …` and end with the Co-Authored-By line.
- Full suite: `pwsh -NoProfile -File tests/run.ps1`; dashboard only: `node --test tests/dashboard/`.

## Calls in this plan (where it departs from the spec's "How")

- Inbox steps are paired with their work-log mirror in `tree.mjs`, not `inbox.mjs`: the tree already holds both,
  and `readInbox` is cached on the Inbox files alone, so pairing there would go stale when only the log changed.
- Today a work-log `doing` task under a closed session already reads `next` (`tree.mjs`). That stays, with a new
  `leftOpen` flag the page reads as `doing`. This keeps the counts and Triage unchanged, as the spec requires.
- "Became active after the fold" uses a server-side `activeSinceMs`, because a session's `since` is only set while
  it waits.

## Review Focus

1. A task with no `changedMs` (BMAD, an old line): never stale; it reads `started` or `waiting`.
2. A live session waiting on the owner whose waiting step is not its linked task: still `waiting`, not stale.
3. `--steps-about` with fewer or more lines than `--steps`: extras ignored, missing ones have no about line.
4. A project fold key stored as an old boolean `false`: reads as folded long ago, so the project resurfaces when active.
5. A plan task whose first paragraph is a `**Files:**` label or a list: no about line from the plan (never a label).

---

### Task 1: Work log carries about lines and change times

**Files:**
- Modify: `global/dashboard/note.mjs`, `global/dashboard/lib/worklog.mjs`, `global/dashboard/lib/types.mjs`
- Modify: `global/rules/dashboard.md`
- Test: `tests/dashboard/worklog.test.mjs`

**Interfaces:**
- Produces: work-log record fields `about: string`, `stepsAbout: string[]`. Task fields
  `about: string|null`, `changedMs: number|null` (time of the last record that touched the task: its `start`, a
  `step` naming it, or `done`). Typedef `Task` gains both.

- [ ] **Step 1: Write the failing tests** in `worklog.test.mjs`, using the existing `run(...)` helper:
  - `note start --about writes about`: `start "Fix login" --about "Users get logged out after 5 min"` → record has
    `about: 'Users get logged out after 5 min'`; `readWorklog` task `about` equals it.
  - `--steps-about pairs lines with steps`: `--steps "a|b|c" --steps-about "why a|why b"` → tasks' `about` are
    `['why a', 'why b', null]`; with `"x|y|z|w"` the fourth is ignored.
  - `changedMs follows the last record touching a task`: start at T0, `step 2 doing` at T1 → task 1 `changedMs`
    T0, task 2 T1; `done` at T2 → all T2. (Write records directly with `appendFileSync` to control `at`.)
  - `old lines without about still read`: a v1 `start` without `about` → task `about === null`.
- [ ] **Step 2: Run** `node --test tests/dashboard/worklog.test.mjs` — Expected: the 4 new tests FAIL.
- [ ] **Step 3: Implement.** `note.mjs`: `--about` (trimmed, kept if non-empty) and `--steps-about` (split on `|`,
  trimmed, empty entries kept as `''` so positions line up) on `start`; update the usage comment. `worklog.mjs`:
  `mkTask` takes `about`; a single-task start uses `about`, a stepped start uses `stepsAbout[i]` (`''`/missing →
  `null`); set `changedMs` on start, step and done.
- [ ] **Step 4: Rule text.** In `global/rules/dashboard.md`, change the first bullet's command to
  `node ~/.claude/dashboard/note.mjs start "<task in a few words>" --about "<one plain-English line: what this is and why>"`
  and add after `--steps`: "With steps, add `--steps-about "line|line|line"`: one plain-English line per step, in
  order (no `|` inside a line)." Add a bullet: "**Close what you open.** When work ends, set every step of your
  Inbox checklist to done or dropped (or resolve the thread), and run `note.mjs done`." In the Inbox bullet, add:
  "use the same step names, so the dashboard can pair them."
- [ ] **Step 5: Run** `node --test tests/dashboard/worklog.test.mjs` — Expected: PASS.
- [ ] **Step 6: Commit** `dashboard-clarity Task 1: work log about lines and change times`.

### Task 2: Plans and Inbox supply about lines and change times

**Files:**
- Modify: `global/dashboard/lib/sources/plans.mjs`, `global/dashboard/lib/sources/inbox.mjs`
- Test: `tests/dashboard/sources.test.mjs`

**Interfaces:**
- Produces: plan tasks `about: string|null`. Inbox tasks `changedMs` (the step's own `at`); Inbox epics `subject`
  (the thread's root message subject, else first subject, else null).

- [ ] **Step 1: Write the failing tests:**
  - `plan task about is the first sentence of its first paragraph`: under `### Task 2: Thing` the lines
    `Adds the cache. Then more.` → `about === 'Adds the cache.'`.
  - `plan task about skips labels and lists`: a task whose first lines are `**Files:**` and `- Modify: x` → `null`.
  - `plan about is capped`: a 300-character sentence → 200 characters ending in `…`.
  - `inbox step keeps its at as changedMs` and `inbox epic carries the thread subject`.
- [ ] **Step 2: Run** `node --test tests/dashboard/sources.test.mjs` — Expected: new tests FAIL.
- [ ] **Step 3: Implement.** `plans.mjs` `parsePlan`: per task, the first non-empty line after the heading that is
  not a heading, list item, fence, table row, or a line that starts with `**` and ends with `:**`/`**:`; join
  following non-empty lines of that paragraph; take up to the first `. `, `! `, `? ` or end; strip `**`/`` ` ``;
  cap 200 characters with `…`. A tick line ends the search. `inbox.mjs`: `changedMs: at` on each task; epic
  `subject` from the `titles` pass (return `{titleOf, subjectOf}`).
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `dashboard-clarity Task 2: plans and Inbox about lines and change times`.

### Task 3: The tree keeps the facts and pairs Inbox steps with their mirror

**Files:**
- Modify: `global/dashboard/lib/tree.mjs`
- Test: `tests/dashboard/tree.test.mjs`

**Interfaces:**
- Consumes: Task 1 and Task 2 fields.
- Produces: every tree task has `about: string|null`, `changedMs: number|null`, `leftOpen: boolean`.
  `leftOpen` is true when a work-log `doing` task was read as `next` because its session is not live (statuses and
  counts stay as today). Plan tasks without their own `changedMs` take the plan's `mtimeMs`.

- [ ] **Step 1: Write the failing tests:**
  - Extend `a work-log task left doing by a session that is no longer live reads next`: also assert
    `leftOpen` is `[true, false, false]`.
  - `a plan task takes the work log's about over the plan's own`: plan task `about: 'plan line'`, work-log task naming
    it with `about: 'log line'` → `'log line'`; without one → `'plan line'`. The overriding work-log task's
    `changedMs` and `leftOpen` carry over too.
  - `an Inbox step takes its about from the same session's work-log mirror`: Inbox step `' Build It '` session
    `s1`; work-log task `build it` session `s1` about `'why'` → `'why'`; a session `s2` mirror is ignored; no match →
    the epic's `subject`; no subject → `null`.
  - `plan tasks take the plan mtime as changedMs`.
- [ ] **Step 2: Run** `node --test tests/dashboard/tree.test.mjs` — Expected: new tests FAIL.
- [ ] **Step 3: Implement** in `cleanEpics` (keep `about` if a non-empty string, `changedMs` via `toMs`, else the
  epic's `mtimeMs`; keep epic `subject`), the liveness loop (set `leftOpen`), `applyPlanStatus` (copy `about`,
  `changedMs`, `leftOpen` from `w`; `about` only when `w.about`), and a mirror pass over `inbox` before epics are
  listed (match on `sessionId` and `title.trim().toLowerCase()`, first work-log match in log order wins).
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `dashboard-clarity Task 3: tree keeps about, change times and left-open tasks`.

### Task 4: Sessions carry their title; projects know when they became active

**Files:**
- Modify: `global/dashboard/lib/transcripts.mjs`, `global/dashboard/lib/model.mjs`
- Test: `tests/dashboard/transcripts.test.mjs`, `tests/dashboard/model.test.mjs`

**Interfaces:**
- Produces: `scanTranscript(...).title: string|null` — the newest `{"type":"custom-title","customTitle"}` record,
  else the newest `{"type":"ai-title","aiTitle"}` (shapes checked in real transcripts 2026-11-19). Session view
  `title`. Exported `trackActive(map: Map, key: string, active: boolean, now: number) -> number|null` (sets `now` on
  the first active sight, deletes when not active, returns the stored time). Project `activeSinceMs`; active =
  `state` in `stuck`, `waiting`, `working`.

- [ ] **Step 1: Write the failing tests:**
  - transcripts: `title prefers the newest custom title over ai titles` (ai, custom, ai → the custom one);
    `title falls back to the newest ai title`; across two incremental scans the title survives.
  - model: `trackActive` sequence: (k, true, 100) → 100; (k, true, 200) → 100; (k, false, 300) → null;
    (k, true, 400) → 400. `buildModel` session carries `title` from its transcript (existing fixture pattern).
- [ ] **Step 2: Run** `node --test tests/dashboard/transcripts.test.mjs tests/dashboard/model.test.mjs` — Expected:
  new tests FAIL.
- [ ] **Step 3: Implement.** In `ingest`, record `customTitle` / `aiTitle` on the state; return
  `title: customTitle ?? aiTitle ?? null`. In `sessionView`, `title: signals.title`. In `buildModel`'s final loop,
  `p.activeSinceMs = trackActive(ACTIVE, keyOf(p.root), p.state in RANK, now)` with a module-level `ACTIVE` map.
  Update the model header comment.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `dashboard-clarity Task 4: session titles and project active-since`.

### Task 5: The page's meaning: liveness, groups, hover text, project fold

**Files:**
- Modify: `global/dashboard/page/render.mjs`
- Test: `tests/dashboard/page.test.mjs`

**Interfaces:**
- Consumes: task `about`, `changedMs`, `leftOpen`; session `title`, `linkedTask`, `alive`; project `activeSinceMs`.
- Produces:
  - `STALE_AFTER_MS = 24 * HOUR`.
  - `taskLiveness(task, sessionsById: Map, now) -> 'current'|'stale'|'started'|'waiting'|'other'`. Status read as
    `doing` when `status === 'next' && leftOpen`. `current`: `s = sessionsById.get(task.sessionId)`, `s.alive` and
    `s.linkedTask?.id === task.id` and status not done. Else doing/waiting with (no live session) and
    `changedMs` known and `now - changedMs > STALE_AFTER_MS` → `stale`; else doing → `started`; waiting → `waiting`;
    else `other`.
  - `GROUPS` gains `{ id: 'started', label: 'Started, not current', history: false, open: false }` between
    `waiting` and `next`.
  - `groupEpics(epics, now, liveSessionIds, livenessOf)`: precedence any `current` → running; any `waiting` →
    waiting; any `started`/`stale` → started; unfinished → next; else done. `shown` includes `started`.
    `foldEpics` treats `leftOpen` tasks as touched.
  - `leftOpenText(changedMs, now) -> 'left open N days ago'` (`agoWords`-style: hours under a day, else days).
  - `detailText({kind:'task', task, session, liveness, now})`: first line `task.about` or `No description yet`,
    a blank line, then the details: `current` → "Session X is on it now" (+ reason, time so far); `started` →
    "Started by session X, which has moved on" / "…, which has closed" / "Started"; `stale` → "Left open N days
    ago" (+ "by session X"); `waiting` → "Waiting on you"; done/next as today.
  - `sessionLabel(s) -> s.title || 'Session ' + shortId(s.sessionId)`.
  - `projectOpen(p, stored) -> boolean`: `true` or `{open:true}` → true; `false` → as `{open:false, at:0}`;
    `{open:false, at}` → `p.state` in stuck/waiting/working and `activeSinceMs > at`; missing → `!!p.open`.

- [ ] **Step 1: Write the failing tests** (rewrite `groupEpics: exclusive groups, running wins over waiting` for
  the new signature):
  - `taskLiveness`: current; doing linked to a live session that moved on → `started`; doing, dead session, changed
    25 h ago → `stale`, 23 h ago → `started`; waiting, dead session, 2 days → `stale`; waiting, live session not
    current → `waiting`; doing with `changedMs: null`, no session → `started`; `next`+`leftOpen` 2 days → `stale`;
    `next` → `other`; done linked to a live session → `other`.
  - `groupEpics`: one epic per precedence row lands in running, waiting, started, next, done; `GROUPS` ids in order
    `running, waiting, started, next, done, quiet, doneEarlier, before, dropped`.
  - `detailText task`: about first then blank line; `No description yet` without one; stale shows
    `Left open 2 days ago`.
  - `leftOpenText`: 3 h → `left open 3 hours ago`; 50 h → `left open 2 days ago`.
  - `sessionLabel` with and without a title.
  - `projectOpen`: each row of the rule, including boolean `false` + active → true, and a fold set after
    `activeSinceMs` → false.
- [ ] **Step 2: Run** `node --test tests/dashboard/page.test.mjs` — Expected: new tests FAIL.
- [ ] **Step 3: Implement** the functions above in `render.mjs`; `taskText` takes `liveness` and `now`.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `dashboard-clarity Task 5: task liveness, started group, about-first hover`.

### Task 6: The page draws it

**Files:**
- Modify: `global/dashboard/page/app.js`, `global/dashboard/page/app.css`
- Test: `tests/dashboard/page.test.mjs` (import check only), live check in Task 7

**Interfaces:**
- Consumes: everything Task 5 produces.

- [ ] **Step 1: Wire it.**
  - `taskState(t, s, liveness)`: `current` → `work` or the session's stuck/waiting/gone class; `waiting` → `wait`;
    `started` → `started`; `stale` → `stale`; done → `done`; else `idle`. Add `.s-started` and `.s-stale` styles and
    icons within the existing style (muted; stale dimmer), and rows for both in `KEY_ROWS`.
  - `taskLi`: the `.now` line and the `session xxxx` chip only when `current`. `started`/`stale` with a session →
    meta `session xxxx, earlier`; `stale` → also `left open N days ago`.
  - `groupsOf` passes `(t) => taskLiveness(t, byId, now)`; task tooltips pass `liveness` and `now` to `detailText`.
  - `sessionBlock` and the Sessions/Triage rows show `sessionLabel(s)` in bold; when there is a title, the short id
    moves into the session's tooltip text.
  - `isOpen(p)` becomes `projectOpen(p, openState[keyOf('p', p.root)])`; the project fold click stores
    `{ open, at: Date.now() }`. A project shown because it resurfaced, folded again, stores a new `at`.
  - `STEPS` help text for the plan names the Started, not current group.
- [ ] **Step 2: Run** `node --test tests/dashboard/` — Expected: PASS (the page test imports render.mjs and the
  app module list).
- [ ] **Step 3: Commit** `dashboard-clarity Task 6: the page draws liveness, titles and resurfacing projects`.

### Task 7: Docs, install and live check

**Files:**
- Modify: `docs/decisions.md` (new 35), `README.md`, `docs/setup-guide.html`, `docs/setup-prompt.md` if it
  describes the work log, the spec's Status line.

- [ ] **Step 1: Decision 35**: Running means a live session's current task; Started, not current; stale after 24 h;
  about lines from agents (no model in the dashboard); Inbox pairing by session and step name; `leftOpen` kept so
  counts and Triage don't change; `activeSinceMs` is server memory, so a server restart makes a folded active
  project resurface once (accepted).
- [ ] **Step 2: README / setup guide**: the work-log description mentions `--about` / `--steps-about` and the
  Started, not current group.
- [ ] **Step 3: Run** `pwsh -NoProfile -File tests/run.ps1` — Expected: 0 failed (the launcher timing flake is
  known; rerun it alone if it trips). `pwsh -NoProfile -File tools/check-personal.ps1` passes.
- [ ] **Step 4: Commit** `dashboard-clarity Task 7: decision 35 and docs`.
- [ ] **Step 5: Install and live check** (the owner approved the rule text with the design): `./install.ps1`,
  restart the dashboard server, then check on the page: Running holds one task per live session; a long-lived session's
  older tasks sit under Started, not current; a two-day-old waiting step from a closed session reads `left open N days ago`;
  a task hover starts with its about line or `No description yet`; a session card shows its title; a
  hand-folded project with a working session shows as a panel.
