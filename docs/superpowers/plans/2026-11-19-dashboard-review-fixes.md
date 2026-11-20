# Dashboard review fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the six points from the owner's review: the theme label, step popups, plain-English commands, token
precision, the group's name, and gentler stuck wording.

**Architecture:** The server keeps each pending tool's `description`. The stall classifier and the page name a tool
by it. Everything else is a wording or format change in `page/render.mjs` and `page/app.js`.

**Tech Stack:** Node built-ins, `node:test`, plain DOM.

**Spec:** `docs/superpowers/specs/2026-11-19-dashboard-review-fixes-design.md`

## Global Constraints
- No change to when anything counts as stuck. Only words change.
- No network or model calls; tests never touch the real `~/.claude`; `tools/check-personal.ps1` passes.
- Copy: `Started, not active`; `No description yet`; `Running a command`.
- Commits start `dashboard-review-fixes Task N: …`.

## Review Focus
1. A tool with an empty or whitespace `description`: treated as missing, so the command or the name shows.
2. A very long description: clipped like a command (200 characters, `…`).
3. `formatTokens` at its boundaries: 999, 1000, 999,499, 999,500, 1e9 and 1.005e9. No "1000k" and no "1000M".
4. An Inbox step with a work-log mirror line still shows that line; only the subject fallback goes.
5. The theme label when the system flips from light to dark while the page is open.

---

### Task 1: Tools carry their description; stall evidence names it

**Files:**
- Modify: `global/dashboard/lib/transcripts.mjs` (`toolUse`), `global/dashboard/lib/model.mjs` (`toolView`),
  `global/dashboard/lib/stall.mjs` (`label`, the stuck and gone evidence)
- Test: `tests/dashboard/transcripts.test.mjs`, `tests/dashboard/stall.test.mjs`

**Interfaces:**
- Produces: `pendingTool.description: string|null` (trimmed; empty → null) from the scan, and passed through
  `toolView` (clipped with the same `clip`).
- Stall evidence when the tool has a description:
  - foreground stuck: `"<description>" running N min · <cpu> · no output for M min`;
  - background stuck: `Background job quiet for M min, still running: <description>. It may be waiting on something outside, such as a CI run or a download.`;
  - gone: `"<description>" was still running when the process ended`.
- Without a description, every string stays exactly as today.

- [ ] **Step 1: Failing tests.**
  - transcripts: a Bash `tool_use` with `description: ' Watch CI '` → `pendingTool.description === 'Watch CI'`;
    with no description, or `'  '`, it is `null`.
  - stall: the three wordings above, using description `Watch the fix PR's CI run to the end`. An existing case
    without a description is unchanged.
- [ ] **Step 2: Run** `node --test tests/dashboard/transcripts.test.mjs tests/dashboard/stall.test.mjs`.
  Expected: the new tests fail.
- [ ] **Step 3: Implement.** Also update the judgment-call comment at the top of `stall.mjs`.
- [ ] **Step 4: Run** the same command. Expected: pass.
- [ ] **Step 5: Commit** `dashboard-review-fixes Task 1: tools carry their description; gentler stuck wording`.

### Task 2: The page in plain words

**Files:**
- Modify: `global/dashboard/page/render.mjs`, `global/dashboard/page/app.js`, `global/dashboard/lib/tree.mjs`
- Test: `tests/dashboard/page.test.mjs`, `tests/dashboard/tree.test.mjs`

**Interfaces:**
- Consumes: `pendingTool.description` (Task 1).
- Produces:
  - `sessionWhat(s).what`: the session name, as today; else `Running <description>`; else `Running a command`
    for Bash; else `Running <tool name>`.
  - `nowLine(s)`: the description first; then the command's first line, then the tool name, as today.
  - `toolHover(tool) -> string`: the full command, or `''`. It goes in the session's hover (`sessionText` appends
    `Command: <command>`).
  - `formatTokens(n)`, three significant figures:
    - under 1000 → the whole number;
    - then `k`, `M`, `B`, rounded to 3 significant figures with trailing `.0`/`0` dropped:
      `3.4k`, `51.2k`, `523k`, `1.2M`, `12.3M`, `523M`, `1.04B`, `12.3B`;
    - rounding that reaches 1000 moves up a unit (`999,999` → `1M`).
  - `GROUPS` label `Started, not active`; key row and help text say the same.
  - `epicText({epic})` starts with `epic.subject` when present (a sentence), then today's text.
  - `themeLabel(mode, prefersDark) -> 'Auto (dark)' | 'Auto (light)' | 'Light' | 'Dark'`.
  - `tree.mjs` `mirrorAbout`: no subject fallback; `about` stays null without a mirror line.
- `app.js`: the mode button uses `themeLabel` and re-labels on a `matchMedia('(prefers-color-scheme: dark)')`
  change.

- [ ] **Step 1: Failing tests:**
  - `formatTokens` table: 820→`820`, 3400→`3.4k`, 51234→`51.2k`, 523000→`523k`, 999999→`1M`, 1.2e6→`1.2M`,
    12.34e6→`12.3M`, 523e6→`523M`, 1.04e9→`1.04B`, 1.005e9→`1.01B` (or `1B`: assert what `toPrecision(3)` gives),
    12.3e9→`12.3B`.
  - `sessionWhat` with a description, without one (Bash → `Running a command`; Read → `Running Read`).
  - `nowLine` prefers the description.
  - `themeLabel` covers all four labels.
  - The epic hover starts with the subject.
  - The group label is `Started, not active`.
  - tree: an Inbox step with no mirror has `about === null`; one with a mirror keeps its line. Replaces the earlier
    subject assertion.
- [ ] **Step 2: Run** `node --test tests/dashboard/page.test.mjs tests/dashboard/tree.test.mjs`. Expected: the new
  tests fail.
- [ ] **Step 3: Implement**, then wire `app.js` (`node --check`).
- [ ] **Step 4: Run** `node --test tests/dashboard/`. Expected: pass.
- [ ] **Step 5: Commit** `dashboard-review-fixes Task 2: plain words, three-figure tokens, Started, not active`.

### Task 3: Docs, install, live check
- [ ] Decision 35: the rename and the step-description change. Decision 31: one line on the stall wording.
  README/setup guide where they say "Started, not current".
- [ ] `pwsh -NoProfile -File tests/run.ps1`. Expected: 0 failed. `tools/check-personal.ps1` passes.
- [ ] Commit `dashboard-review-fixes Task 3: docs`.
- [ ] Install, restart the server, then check the page:
  - the anatomy card shows the CI watch in words;
  - tokens show three figures;
  - Settings steps no longer repeat one line;
  - the mode button reads `Auto (dark)` in a dark-scheme browser.
