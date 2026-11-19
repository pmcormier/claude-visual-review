# Dashboard work log

Applies in every project while the Dashboard component is installed. The live dashboard reads Claude Code's own
files to see what is running; this log tells it what the work is. Each entry is one short command, it prints
nothing, and it never fails a session.

- **Every task, however small, gets an entry.** When you take one on, run
  `node ~/.claude/dashboard/note.mjs start "<task in a few words>"`. If the work has steps, add
  `--steps "first|second|third"`. If it is a task from a plan, add `--plan <plan file> --task <N>`.
- **Keep it current as you go:** `note.mjs step <n> doing`, then `step <n> done` (also `waiting` when it waits
  on the person, `dropped` when a step no longer applies). Finish with `note.mjs done`, or
  `note.mjs drop "<reason>"` when the task is abandoned. Starting a new task closes an unfinished one as
  not done, so log `done` when you finish.
- **Subagents don't write the log.** The session that talks to the person logs the task, including work it
  delegates.
- **An Inbox checklist is mirrored here.** When you keep a `steps` checklist in a Plannotator thread, start a
  work-log entry with the same steps and update both together. The log works without Plannotator; the
  checklist is for the person, the log is for the dashboard.
- **Plans:** when you finish a task from a plan, tick its checkboxes in the plan file. When you commit work for a
  plan task, start the commit's first line with the plan's name and the task, for example
  `live-dashboard Task 3: transcript signals`. The dashboard marks a plan task done from a commit only when
  the first line names both, so other commits are never misread.

This file is installed by claude-visual-review's Dashboard component and removed with it. To change how it
works for you, add a rule file of your own in `~/.claude/rules/`; updates never touch it.
