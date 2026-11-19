---
description: Open the live dashboard of Claude Code work on this computer, or catch up a project's older plans
argument-hint: "[catch-up]"
---

The argument is: `$ARGUMENTS`

**With no argument, open the dashboard:**

1. Run `node ~/.claude/dashboard/launcher.mjs --open`. It starts the dashboard server if it isn't running and
   opens the page; it prints nothing and always succeeds.
2. Read the port from `~/.claude/dashboard/config.json` (its `port` field). If the file or the field is
   missing, the port is 47800.
3. Reply with one line: the URL `http://127.0.0.1:<port>/`, saying the page was opened there.

**With `catch-up`, mark this project's older plans as done or dropped.** Plans that existed before the dashboard
was installed fold under "Before the dashboard" until they show progress. This records, in the repo, which of
them are finished:

1. Run `node ~/.claude/dashboard/catchup.mjs`. It prints JSON: the project `root`, the install date and `plans`:
   the plans from before the dashboard with no `Status:` line, each with `file`, `title`, `ticked`
   (`{done, total}`), `addedMs` and `changedMs`. On `{error}`, say so in one line and stop.
2. If `plans` is empty, say in one line that there is nothing to catch up, and stop.
3. Ask the person which plans are still open. Show each plan's title, its ticked count and when it last changed.
   With more than four plans, ask where there is room to choose (the Plannotator Inbox as a `:::question-multi`
   with one choice per plan, when it is available), otherwise as a numbered list in the terminal. A plan the
   person says was abandoned gets `dropped`; every other plan not picked as open gets `done`.
4. In every listed plan, insert one line after the title (the first `# ` line), with today's date:
   `Status: done — catch-up YYYY-MM-DD`, `Status: dropped — catch-up YYYY-MM-DD`, or, for the plans picked as
   still open, `Status: open — catch-up YYYY-MM-DD` (it keeps them showing as current work). Change nothing else.
5. Show the change (`git diff` of those plan files) and ask for a yes. On a yes, stage only those plan files
   (`git add <each file>`, never `-A` or `commit -a`) and commit them in one commit. If the repo's CLAUDE.md or
   AGENTS.md sets a commit-message format, follow it. On a no, remove the lines you inserted. Never push.
