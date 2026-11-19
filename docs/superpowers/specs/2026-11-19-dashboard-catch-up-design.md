# Dashboard catch-up for older projects: design

Approved by the owner on 2026-11-19 (Inbox thread "Live task tree"). A small change to the Dashboard component.

## Why
Projects older than the dashboard have plans whose finished tasks were never ticked. On the page they read as
work left: this PC had 82 plans with 2,086 unticked boxes in one project alone. The owner leaves projects idle for
months and comes back to them, so old plans must not vanish for good. And task status belongs in each repo, not in
the dashboard: from now on the rule file has Claude tick plan boxes and name the plan and task in commit subjects.

## Goals
- Plans that existed before the install stop reading as work left, without reading any old code.
- An optional per-project catch-up records, in the repo, which old plans are done or dropped.
- A plan that shows progress or is worked on again comes back as current work by itself.
- Safe in repos shared with other people (the owner's work machine has several).

## Non-goals
- Working out from git history which old tasks were done, box by box. (The owner can already ask Claude in a
  project to "tick what's done in these plans"; the rule file covers it.)
- Showing teammates' live work. That's a later build, probably reading GitHub Issues assigned to people.
- A per-repo record of small tasks that aren't in a plan. The owner chose: the work log is live activity, and the
  commit is the lasting record.
- BMAD tickets and Inbox checklists: they keep their own status.

## Anti-goals
- The dashboard writing task status outside the repo. The install date is a display setting and never marks
  anything done.
- Any commit without the owner's yes, or any push.

## Approaches considered
1. **Tick the boxes in every old plan from git history.** The most accurate result, but Claude has to read each
   plan's code (82 plans in one project), and the repo gets large diffs. Rejected as the default; it stays possible
   by hand.
2. **Record "still open" picks in a dashboard-side file.** Cheap and touches no repo, but that is task status kept
   outside the repo. Rejected by the owner.
3. **Starting line at install, plus a `Status:` line written into old plans by an optional catch-up.**
   **Chosen:** no code reading, and status stays in the repo, one line per plan.

## The design

**Starting line.** The installer records the install date once, at the first install of the Dashboard component;
a later install keeps it. A superpowers plan whose file was added to the repo before that date is "from before the
dashboard". Such a plan folds under **"Before the dashboard (N)"** in its project (opened by "Show all history")
unless one of these holds, in which case it reads as current work:
- some of its boxes are ticked but not all (it was in progress, like a plan at 5 of 6);
- a task from it is started in the work log, or named by a live session, after the install date;
- the file changed after the install date (a commit touching it, or an uncommitted edit).

A plan added after the install date works as today. Plans folded this way don't count toward work left or
"Up next". The 7-day fold ("Done earlier") still applies to every plan.

**The `Status:` line.** One line near the top of a plan, after its title: `Status: done` or `Status: dropped`,
optionally followed by a dash and a short note (for example a date). A plan marked done reads as finished: all its
tasks done, whatever its boxes say. A plan marked dropped leaves the page's work, shown only under
"Show all history" as dropped. Any plan may carry the line, old or new.

**`/dashboard catch-up`** (an argument of the existing `/dashboard` command), run in a project:
1. List the project's plans from before the dashboard that have no `Status:` line, with each plan's title, its
   ticked count and when it last changed.
2. Ask the person which are still open. With more than a few plans, ask where choosing has room (the Inbox when it
   is available, otherwise a numbered list in the terminal), not a four-option menu.
3. For every other plan, add `Status: done` (or `dropped`, where the person says so) and show the change.
4. Commit only after the person says yes, in one commit, never pushing. If the repo's CLAUDE.md or AGENTS.md sets a
   commit-message format, follow it.
Plans left open stay as they are and read as current work from then on.

**Rule text.** `rules/dashboard.md` gains one clause: a repo's own commit-message convention (in its CLAUDE.md or
AGENTS.md) wins over the "plan name + Task N" subject. This is a rule change, so it goes to the owner for sign-off
before it is installed.

## Constraints
- The global constraints of the live-dashboard plan still bind: Node built-ins only, never write inside a project
  from the dashboard itself (the catch-up writes through Claude, with the person's yes), readers never throw, tests
  never touch the real `~/.claude`, the repo is public.
- Docs move with the change: README, setup guide, setup prompt, and decision 31 or a new decision entry.

## Left to the builder
- Where the install date lives under `~/.claude/dashboard/` and its exact name.
- How "added before the install date" is read: the git add date where the tree code already has it; for an
  untracked plan, the file's creation time.
- The page wording of the fold, beyond "Before the dashboard (N)", and how a dropped plan looks in history.
- How the catch-up lists plans: a small helper script the command runs, or reading the files directly.
