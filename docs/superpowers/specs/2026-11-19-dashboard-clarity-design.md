# Dashboard clarity: what is really running, and what each task is

Status: approved by the owner, 2026-11-19 (including the rule text).

## Why
The owner wants the dashboard to be "truly useful at a glance, and dig deeper if you want": a picture of all the
work they are doing with Claude. Using it on 2026-11-19, they couldn't tell what was actually active:

- **Live lines repeat.** One session was linked to 262 tasks over its life, 7 still "doing" and 11
  "waiting". The page draws the session's live line ("— working", "— cd …") under every task linked to it, so a
  session doing one thing looks like it is doing many. "Running (5)" counted all of those.
- **Hover text is thin.** It explains the tool that is running, but not what the task is. Short step names
  such as "Second sitting" or "Doc fixes, then merge" say nothing to someone who hasn't
  followed the thread.
- **A session was hard to recognise.** A session with a clear title showed only under its project's
  folder name, and sat folded in the quiet list while working.
- **A stale checklist showed as waiting on the owner.** A step ("roll back at the next restart") was marked
  "waiting" by a session on Nov 17 that never updated or closed its Inbox thread.

## Goals
1. **Running means now.**
   - A task is in Running only when it is the current task (`linkedTask`) of a live session.
   - Tasks a session started earlier and left open go to a new group, **Started, not current**. It sits between
     Waiting on you and Next and is folded by default.
2. **One live line per session.**
   - The "— working" / "— cd …" line and the session chip appear only under that session's current task.
   - Other tasks linked to the session show who worked on them ("session ab12, earlier") without the live line.
3. **Stale waits are not waits.**
   - A "waiting" task goes to Started, not current, marked **"left open N days ago"**, when two things are both
     true: its session is not alive, and it hasn't changed for 24 hours.
   - The same rule covers "doing". Otherwise it stays in Waiting on you.
4. **Each task says what it is.** The hover pop-up for a task starts with one plain-English line about it:
   - **Plan tasks:** the first sentence of the task's own text in the plan file (the paragraph under its
     `### Task N` heading, before the steps).
   - **Work-log tasks and steps:** an `about` line the agent writes (below).
   - **Inbox steps:** the `about` line of the matching step in the session's work-log mirror, matched by step
     name; otherwise the thread's subject.
   - After that line come today's details: state, session, time, the tool running. Where there is no about line,
     the text says "No description yet", rather than guessing.
5. **Sessions show their title.**
   - Each session card shows Claude Code's title for the session ("Login bug"): the newest `custom-title`,
     else the newest `ai-title` record in its transcript. The folder-based name moves to the tooltip.
6. **A working project comes back up.**
   - A project folded into the quiet list moves back to the panels when one of its sessions becomes working,
     waiting or stuck.
   - Its folded state is kept, so it folds again when it goes quiet. A hand-fold made while it was active still
     wins.

## The rule change (needs the owner's sign-off before install)
`rules/dashboard.md`:

- **About lines.** `note.mjs start "<task>" --about "<one plain-English line: what this is and why>"`. With
  steps, `--steps-about "line|line|line"` pairs one line with each step, in order. Mirrors of Inbox checklists use
  the same step names, so the dashboard can pair them.
- **Close what you open.** When work ends, set every step of your Inbox checklist to done or dropped (or resolve
  the thread). Run `note.mjs done`.

`note.mjs` gains `--about` and `--steps-about`. Old entries without them still read.

## Non-goals
- No summaries written by a model inside the dashboard: no API calls, no network (the owner ruled this out).
- No change to Triage or the counts. They already work from sessions, not tasks.
- No rewrite of old plans or old Inbox threads.

## Anti-goals
- A task shown as Running when no session is doing it now.
- A made-up description. "No description yet" is better than a guess.

## How
- **Server (facts):**
  - `lib/worklog.mjs` reads `about` and `stepsAbout` onto tasks.
  - `lib/sources/plans.mjs` reads each task's first sentence into `about`.
  - `lib/sources/inbox.mjs` keeps each step's `at` as `changedMs`, and takes `about` from the work-log mirror (the
    model passes the work-log epics in).
  - `lib/transcripts.mjs` keeps the newest title.
  - `lib/model.mjs` passes `title` on sessions.
- **Page (meaning):**
  - `render.mjs` gains a pure `taskLiveness(task, session, now)` returning `current | started | stale | other`,
    tested.
  - `groupEpics` gains the `started` group, and its Running test uses `current`.
  - `app.js` draws the live line only for `current`, shows titles, brings working projects back, and puts
    `about` first in task hover text.
- **Docs:** decision 35; README and setup guide wherever they describe the work log.

## Rules settled after the builder check
1. **An epic's group**, first that applies:
   - any task current → Running;
   - else any task waiting and not stale → Waiting on you;
   - else any task doing or waiting (started, or stale) → Started, not current;
   - else unfinished → Next;
   - else Done.

   History groups are unchanged. Work left still counts Running, Waiting, Started, Next and Done.
2. **`taskLiveness(task, sessionsById, now)`** returns one of:
   - `current`: the task's id is the `linkedTask` of a live session.
   - `stale`: the task is doing or waiting, its session is not alive (or it has no session), and `changedMs` is
     more than 24 hours old.
   - `started`: the task is doing but not current.
   - `waiting`: the task is waiting and not stale. That includes a live session's waiting step in the epic it
     is working on now. (Owner's ruling after the build: a live session whose current task is in another epic counts
     as gone for the older epic, so those waits go stale after a day. See decision 35.)
   - `other`: anything else.
3. **`changedMs` for every task:**
   - work log: the time of the last record touching the task (`worklog.mjs` tracks it);
   - Inbox: the step's own `at` (present in `steps.jsonl`, checked 2026-11-19);
   - plans, BMAD, commits: the file's or source's last change (plan `mtimeMs`). A part-ticked plan task with no
     session is `started`, and becomes `stale` after 24 hours like the rest.
4. **"Left open N days ago"** counts from `changedMs`.
5. **Subagents** don't map to tasks in the model. Running is decided by sessions' current tasks only; subagents
   keep showing under their session.
6. **Inbox step about lines:**
   - The mirror is the work-log entries written by the same session as the checklist. That's the checklist
     record's `agent.session`.
   - Names match after trimming, ignoring case; the first match wins.
   - Otherwise the step falls back to the thread's subject.
7. **About line precedence:**
   - for a plan task: a work-log `--about` for the same plan task, then the plan's first sentence;
   - otherwise: "No description yet".
8. **`--steps-about`:**
   - extra lines are ignored, and missing ones mean no about line;
   - `|` separates lines, as in `--steps`, so an about line can't contain `|`.
9. **Bringing a project back:**
   - A project fold key stores when it was set (`{ open: false, at }`). Old boolean keys read as set long ago.
   - A folded project shows as a panel while it is working, waiting or stuck, if it became active after the fold
     was set. Folding it again while it is active sets a new time, so the fold wins.
   - When the project goes quiet, it folds back by itself.
10. **Install order.** `note.mjs` and the page can ship together. The rule file waits for the owner's sign-off, so
    nothing is installed until then.

## Calls I made (the owner can overrule)
- "Stale" is 24 hours with no change and no live session. That's long enough for a lunch break or an overnight
  pause, short enough that a two-day-old step no longer reads as waiting.
- "Started, not current" is folded by default, so it doesn't add scroll.
- The plan description is the first sentence only, kept short on purpose.

## Left to the builder
- The icon and wording for "started, not current" and "left open N days ago", within the existing style.
- Where the session title and folder name sit on the card.
