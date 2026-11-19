# Dashboard Catch-up Implementation Plan

Status: open — catch-up 2026-11-19

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plans older than the dashboard stop reading as work left, and an optional `/dashboard catch-up` records
in each repo which old plans are done or dropped.

**Architecture:** The installer records an install date once. The plans reader parses a `Status:` line. The tree
marks each plan as "before the dashboard" from its git add date, its last change and live activity, and leaves
such plans and dropped ones out of work left. The page folds them under "Before the dashboard (N)". A small helper
lists the candidates for the catch-up command, and Claude writes the `Status:` lines with the person's yes.

**Tech Stack:** Node 20+ built-ins (`node:test`), PowerShell 7 installer, plain JS page.

**Spec:** `docs/superpowers/specs/2026-11-19-dashboard-catch-up-design.md`

## Global Constraints
- Node built-ins only; readers tolerate missing files and fields and never throw.
- The dashboard itself never writes inside a project. Only Claude writes the `Status:` line, during the catch-up,
  after the person's yes; it never pushes.
- Tests never touch the real `~/.claude` (`CVR_DASH_CLAUDE_HOME`); Node tests live in `tests/dashboard/`.
- The install date never marks anything done; it only folds.
- Copy: "Before the dashboard (N)"; a plan status line is exactly `Status: done` or `Status: dropped`, optionally
  followed by ` - ` or ` — ` and a note.
- Repo is public: fixtures use invented names; `tools/check-personal.ps1` passes before every commit.
- Docs move with installed files (README, `docs/setup-guide.html`, `docs/setup-prompt.md`), and the change gets a
  `docs/decisions.md` entry.
- Commit subjects start with `dashboard-catch-up Task N:`.

## Review Focus
1. A plan with no git history (untracked, or the repo has no commits): it falls back to the file's creation time
   and never throws. Pinned in Task 3.
2. No install date (dashboard installed before this change, file missing or broken): nothing folds as "before";
   the page behaves exactly as today. Pinned in Tasks 2 and 3.
3. A `Status:` look-alike inside a code fence or below the first `##` heading, or `Status: approved`, has no
   effect. Pinned in Task 1.
4. A re-install keeps the first install date. Pinned in Task 2.
5. A plan from before the dashboard whose task a live session is working on shows in the tree, not folded. Pinned
   in Task 3.

---

### Task 1: The `Status:` line and file creation time in the plans reader

**Files:**
- Modify: `global/dashboard/lib/sources/plans.mjs`
- Test: `tests/dashboard/sources.test.mjs`

**Interfaces:**
- Produces: each plan epic gains `planStatus: 'done'|'dropped'|null` and `birthtimeMs: number|null`.

- [x] **Step 1: Write the failing tests**
  - `plan Status line: done and dropped are read, case-insensitive, with an optional note`: files with
    `Status: done`, `**Status:** Dropped — 2026-11-19`, `> Status: done - shipped` before the first `## ` heading
    give `planStatus` `'done'`, `'dropped'`, `'done'`.
  - `plan Status look-alikes are ignored`: `Status: approved`; `Status: done` inside a ``` fence; `Status: done`
    after the first `## ` heading; each gives `planStatus === null`.
  - `plan epics carry birthtimeMs`: a number for a real file.
- [x] **Step 2:** Run `node --test tests/dashboard/sources.test.mjs`. Expected: the new tests fail.
- [x] **Step 3:** In `parsePlan`, before the first `##` heading and outside fences, match
  `/^\s*(?:>\s*)?(?:\*\*)?Status:?(?:\*\*)?:?\s*(done|dropped)\b/i`; the first match wins. In `readPlans`, take
  `birthtimeMs` from the same `statSync` (null when it fails or is 0).
- [x] **Step 4:** Run the same command. Expected: pass, with no other test changed.
- [x] **Step 5:** Commit: `dashboard-catch-up Task 1: plan Status line and creation time`.

### Task 2: The install date

**Files:**
- Modify: `global/dashboard/lib/config.mjs`, `install.ps1`
- Test: `tests/dashboard/config.test.mjs` (or the file that tests `loadConfig`), `tests/install.tests.ps1`

**Interfaces:**
- Produces: `readInstalledAt(): number|null` in `config.mjs`, reading `<dashHome>/installed.json`
  `{"installedAt": "<ISO 8601>"}`; null when missing, broken or unparsable.

- [x] **Step 1: Write the failing tests**
  - Node: `readInstalledAt reads installed.json`, `readInstalledAt is null when missing or broken`.
  - Installer: `DashboardInstallRecordsInstallDateOnce`: install Dashboard into a temp home, and
    `dashboard/installed.json` exists with a parsable `installedAt`. Overwrite it with `2020-01-01T00:00:00Z`,
    install again, and it still says `2020-01-01T00:00:00Z`. An install without Dashboard writes no file.
- [x] **Step 2:** Run `node --test tests/dashboard/` and `pwsh -NoProfile -File tests/run.ps1`. Expected: the new
  tests fail.
- [x] **Step 3:** Implement `readInstalledAt`. In `install.ps1`, when Dashboard is installed and
  `dashboard/installed.json` is missing, write it with the current UTC time (ISO 8601). `-Remove Dashboard` leaves
  it, like the other runtime files.
- [x] **Step 4:** Run both. Expected: pass.
- [x] **Step 5:** Commit: `dashboard-catch-up Task 2: record the install date once`.

### Task 3: The tree: done, dropped and "before the dashboard"

**Files:**
- Modify: `global/dashboard/lib/tree-match.mjs`, `global/dashboard/lib/tree.mjs`, `global/dashboard/lib/model.mjs`
- Test: `tests/dashboard/tree.test.mjs`, `tests/dashboard/model.test.mjs`

**Interfaces:**
- Consumes: `planStatus`, `birthtimeMs` (Task 1); `readInstalledAt()` (Task 2).
- Produces:
  - `planDates(root, plans, commits) -> Map<plan, {addedMs: number|null, changedMs: number|null}>` in
    `tree-match.mjs`. `addedMs` is the newest add commit, else `birthtimeMs`. `changedMs` is the newest of: the
    latest commit touching the file, and the file's `mtimeMs`.
  - `buildTree` input `installedAtMs` (number|null). Each plan epic gains `before: boolean` and
    `dropped: boolean`. `left.count`, `left.hours` and the model's `counts.next` leave out tasks of epics with
    `before` or `dropped`.

- [x] **Step 1: Write the failing tests** (in `tree.test.mjs` unless noted; `installedAtMs` = a fixed date, and the
  plan files and commits are dated around it):
  - `Status done makes every task done`: a plan with `planStatus: 'done'` and no ticks; every task is `done`, and
    `left.count` is 0.
  - `Status dropped leaves work left`: `dropped: true`, and its tasks are not counted.
  - `a plan added before the install with no ticks and no later change is before the dashboard`: `before: true`,
    not counted.
  - `before the dashboard is undone by progress`: in four variants, each separately, the plan shows with
    `before: false`: (a) some ticked, not all; (b) a work-log task from it started after the install; (c) a live
    session linked to one of its tasks; (d) a commit touching it after the install.
  - `a plan added after the install is never before`.
  - `no install date folds nothing`: `installedAtMs: null`, and every plan has `before: false`.
  - `an untracked plan dates from its creation time`: no commits; `birthtimeMs` before the install, so
    `before: true`; and no throw when `birthtimeMs` is null (then `before: false`).
  - model.test.mjs: `counts.next leaves out before-dashboard and dropped plans`.
- [x] **Step 2:** Run `node --test tests/dashboard/`. Expected: the new tests fail.
- [x] **Step 3:** Implement `planDates`. In `buildTree`, after sessions are linked:
  - a plan is `before` when `installedAtMs` is known, `addedMs < installedAtMs`, `changedMs` is null or `<=`
    `installedAtMs`, it is not part-ticked, and no task is doing or waiting, linked to a live session, or has
    `startedMs > installedAtMs`;
  - `planStatus: 'done'` sets every task done with `doneMs = changedMs`;
  - `dropped` comes from `planStatus`.

  Note on `changedMs`: the file's mtime counts because an uncommitted edit after the install is a change. A
  checkout after the install also counts; that is accepted.

  Count left and next without `before` or `dropped` epics. In `model.mjs`, pass
  `installedAtMs: readInstalledAt()`.
- [x] **Step 4:** Run `node --test tests/dashboard/`. Expected: all pass.
- [x] **Step 5:** Commit: `dashboard-catch-up Task 3: before-the-dashboard and Status in the tree`.

### Task 4: The page

**Files:**
- Modify: `global/dashboard/page/render.mjs`, `global/dashboard/page/app.js`, `global/dashboard/page/app.css` (only
  if needed)
- Test: `tests/dashboard/render.test.mjs` (or the file that tests `foldEpics`)

**Interfaces:**
- Consumes: epic `before`, `dropped` (Task 3).
- Produces: `foldEpics(epics, now, liveSessionIds) -> {shown, earlier, before, dropped}`. `before` epics and
  `dropped` epics leave `shown` and `earlier`; the 7-day rule is unchanged for the rest.

- [x] **Step 1: Write the failing tests:**
  - `foldEpics puts before-dashboard and dropped epics in their own groups`.
  - `effortLeft ignores them`.
  - `Up next and triage leave them out`.
- [x] **Step 2:** Run the render tests. Expected: fail.
- [x] **Step 3:** Implement. In `app.js`, render a hint row `Before the dashboard (N)` (hidden while "Show all
  history" is on), next to `Done earlier (N)`, and with history on, list those epics like the history rows.
  Dropped epics appear only with history on, labelled `dropped`. Text goes through textContent only.
- [x] **Step 4:** Run the tests, then load the page against a temp home with a fixture plan before the install
  and check both groups at 1400 px and 390 px in light and dark. Expected: tests pass, no sideways scroll.
- [x] **Step 5:** Commit: `dashboard-catch-up Task 4: page groups for older and dropped plans`.

### Task 5: `/dashboard catch-up`

**Files:**
- Create: `global/dashboard/catchup.mjs`
- Modify: `global/commands/dashboard.md`
- Test: `tests/dashboard/catchup.test.mjs`

**Interfaces:**
- Consumes: `readPlans`, `readCommits`, `planDates`, `readInstalledAt`, `projectRoot` (sessions.mjs).
- Produces: `node ~/.claude/dashboard/catchup.mjs [<dir>]` prints JSON
  `{root, installedAt, plans: [{file, title, ticked: {done, total}, addedMs, changedMs}]}`: the project's plans
  with no `Status:` line that were added before the install, oldest first. If there is no install date, `plans`
  is every plan without a `Status:` line, and the output says `installedAt: null`. It always exits 0, and an
  error prints `{error}`. Child processes follow R9 (absolute `process.execPath`, cwd = its own folder).

- [x] **Step 1: Write the failing tests:**
  - `catchup lists plans from before the install without a Status line`.
  - `catchup skips plans with Status`.
  - `catchup with no install date lists every unmarked plan`.
  - `catchup in a folder that is not a repo prints an empty list`.
- [x] **Step 2:** Run. Expected: fail.
- [x] **Step 3:** Implement `catchup.mjs`. In `dashboard.md`, when `$ARGUMENTS` is `catch-up`, give Claude these
  steps:
  1. Run the helper.
  2. If the list is empty, say so in one line and stop.
  3. Otherwise ask which plans are still open. With more than four plans, use the Inbox (`:::question-multi`,
     one choice per plan: its title, `ticked done/total` and last change), else a numbered list in the terminal.
     A plan the person names as abandoned gets `dropped`.
  4. Insert `Status: done` or `Status: dropped` on the line after each plan's title, plus ` — catch-up
     YYYY-MM-DD`.
  5. Show the diff and commit only after a yes, in one commit, following the repo's own commit-message format
     when its CLAUDE.md or AGENTS.md sets one. Never push.

  With no argument the command behaves as today.
- [x] **Step 4:** Run the tests. Expected: pass.
- [x] **Step 5:** Commit: `dashboard-catch-up Task 5: catch-up helper and command`.

### Task 6: Rule text, docs and decision

**Files:**
- Modify: `global/rules/dashboard.md`, `README.md`, `docs/setup-guide.html`, `docs/setup-prompt.md`,
  `docs/decisions.md`

- [x] **Step 1:** In the rule's Plans bullet, add: when the repo's CLAUDE.md or AGENTS.md sets a commit-message
  format, that wins over the plan-and-task subject. Mention `Status: done` / `Status: dropped` as the way to
  close a whole plan.
- [x] **Step 2:** Docs: `/dashboard catch-up`, the install date and the "Before the dashboard" fold. Add decision
  32 with the approaches from the spec, the owner's choices (status stays in the repo; no record of small tasks
  in the repo; collaboration later) and why.
- [x] **Step 3:** Run `pwsh -NoProfile -File tests/run.ps1` and `pwsh -NoProfile -File tools/check-personal.ps1`.
  Expected: 0 failed; check passes.
- [x] **Step 4:** Commit: `dashboard-catch-up Task 6: rule text, docs, decision 32`.
- [x] **Step 5:** Send the rule-text change to the owner for sign-off (Inbox: Approve or Change) before installing.

### Task 7: Install and check live (after the rule sign-off)

- [x] **Step 1:** Run `./install.ps1 -Owner`. On this machine the dashboard was installed before this change, so
  `installed.json` is written now: plans already in repos fold from today.
- [x] **Step 2:** Restart the server. On the page, check that older plans in the owner's other projects fold under
  "Before the dashboard", that a part-ticked older plan stays shown, and
  that work left and Up next drop accordingly. Record the before/after numbers in decision 32.
- [x] **Step 3:** Run `/dashboard catch-up` in this repo. The "Shareable Repo" plan is the candidate. Show the
  owner the result and commit only on their yes.
- [x] **Step 4:** Commit the decision numbers: `dashboard-catch-up Task 7: live check`.
