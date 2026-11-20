# Dashboard review fixes: plain words, honest numbers

Status: approved by the owner, 2026-11-19.

A short design: the owner's review of the page on 2026-11-19 raised six points. Each has a cause found in the code
or on the machine. This covers how each is fixed.

## Why
The page should be readable at a glance. A raw shell command, the same popup repeated down a checklist, a token
count that jumps from 1B to 2B, and a red "stuck" on a job that is only waiting for CI all work against that.

## Goals, one per point
1. **Theme.** The Auto button says what it follows: "Auto (dark)" or "Auto (light)", from the browser's
   `prefers-color-scheme`, and it updates when that changes.
   - Cause: the light page came from the builder's test browser, not the owner's. Their Windows and Edge are
     set to dark.
2. **Inbox steps without a description.**
   - A step's hover says "No description yet" rather than repeating the thread's subject.
   - The subject moves to the hover of the step's epic.
   - A step whose same-session work-log mirror has an about line still uses it.
   - Cause: every step fell back to the subject, so a whole checklist showed the same text.
3. **Plain English for commands.**
   - Claude Code's tools carry a `description` (1,025 of 1,131 shell calls in one session, checked).
   - The session card, the task's live line and the "what" in the Sessions view show that description.
   - The full command moves to the hover.
   - With no description, the page says "Running a command" for shell calls, or the tool's name otherwise.
4. **Tokens to three significant figures:** `1.04B`, `12.3M`, `523M`, `51.2k`, `3.4k`, `820`.
5. **Rename** the group "Started, not current" to **"Started, not active"**, everywhere the page and docs say it.
6. **A quiet background job.** It stays "Looks stuck" (the owner's choice). The wording becomes gentler and more
   useful, for example:
   "Background job quiet for 30 min, still running: Watch the fix PR's CI run to the end. It may be waiting on
   something outside, such as a CI run or a download."
   - The job is named by its description, not by the first word of its command ("sleep running 30 min" today).
   - The same naming applies to every stuck or gone evidence line.

## Non-goals
- No change to when a session counts as stuck. Only the words change.
- No summary written by a model inside the dashboard.

## Approaches
- **Point 3:** reading the tool's own `description` (chosen) against guessing from the command (`gh run watch`
  means "watching CI"). Guessing needs a growing list of patterns and is wrong for anything unusual. The
  description is what Claude already wrote for the person.
- **Point 6:** the owner chose to keep the verdict and soften the words. The builder recommended a background job
  never mark a session stuck, because it doesn't block the session; noted, not built.

## How (for the builder)
- `lib/transcripts.mjs`: pending tools keep `description` (a string, clipped like `command`).
- `lib/model.mjs`: `toolView` passes `description` on.
- `lib/stall.mjs`: `label(tool)` uses `tool.description` when present.
  - A background job's stuck evidence uses the wording above.
  - `classify`'s inputs gain nothing new: the tool already rides on `signals.pendingTool`.
- `page/render.mjs`:
  - `sessionWhat` and `nowLine` show the description;
  - `formatTokens` uses three significant figures;
  - the `GROUPS` label changes;
  - the epic hover gains the subject;
  - a theme helper names the followed scheme.
- `lib/tree.mjs`: drop the subject fallback for steps; keep `subject` on the epic.
- `page/app.js`: the Auto label, and command hovers.
- Docs: decision 35 gets the rename and the step-description change; a short note goes on decision 31's stall
  wording.

## Left to the builder
- Exact wording of the "Running a command" fallbacks and the epic hover's subject line.
