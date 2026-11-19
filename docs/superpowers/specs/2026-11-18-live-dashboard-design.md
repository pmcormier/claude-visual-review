# Design: the live dashboard (2026-11-18)

Status: approved by the owner, 2026-11-18.

## Intent
The owner runs several Claude Code sessions at once across several projects, with background subagents and long
shell jobs. The Plannotator Inbox already tells him when a session *asks* for something. It cannot see the
sessions that never ask: the ones that went quiet, hung on a tool, stopped after an API error, sit on a
permission prompt in a terminal he isn't watching, or loop. He wants **big-picture visibility**: one live page,
for the whole machine, showing what is moving, what is done, what is next, and what has quietly stopped, with
time spent and effort left. It ships from this repo as an optional component, so others can install it too.

## Goals
- One page per machine, live without reloading, covering every project with Claude Code activity.
- Stalls are caught by **signs of life** (CPU, output, transcript writes, Claude Code's own session status),
  never by elapsed time alone, and every "looks stuck" shows its evidence.
- Each project shows a bounded work tree: **project → epic → task**, plus one live "now" line per active task.
- Time spent is measured from timestamps; effort left is a count of unfinished tasks, with an hours estimate
  once there is past work to calibrate from.
- Claude plan usage (5-hour and weekly, with reset times) is visible at a glance.
- Costs nothing to leave open: no model tokens, negligible CPU.
- Installable from this repo by anyone on Windows with Node.js; removable cleanly.

## Non-goals
- Notifications. Pinging stays the Inbox's job.
- Embedding the page live inside the Inbox (tested 2026-11-18: blocked, see "Measurements"). Later add-on.
- Mac and Linux support in the first version (the process and CPU checks are Windows-first).
- Editing anything from the page beyond its own preferences: it observes, it doesn't drive sessions.

## Anti-goals (a failure even if it works)
- Calling a working multi-hour build "stuck".
- A tree that grows without bound and becomes unreadable.
- Spending model tokens to keep the page current.
- Changing what the user's status line shows, or leaving it broken after removal.
- Writing into the user's project repos as a side effect.

## Approaches considered
1. **Hooks rewrite a static HTML file.** Simplest. Rejected: a stall is the *absence* of events, so nothing
   that only reacts to hooks can notice one.
2. **A small Node server started by a hook (picked).** Node is already required by the Rigor component; one file,
   no npm packages; alive only while Claude Code is in use.
3. **A server started at Windows sign-in.** Always on; needs a scheduled task and runs when Claude isn't used.
4. **Build on the Visualizer plugin.** Session-bound window, extra plugin dependency, can't be installed cleanly
   from this repo.

## What the owner decided
- **Approach 2:** one Node server per machine, started by a hook; fixed port as the single-instance lock.
- **Scope:** live activity *and* the work tree, sizes and time, in the first version.
- **Tree depth:** project → epic → task + live "now" line. Plan steps never appear. Finished epics fold to one
  line and expand on click. Work older than a week folds into "Done earlier", with a **Show all history**
  control back to the first recorded work. Projects with a live session, a task in progress, or a stall stay
  open; others fold to one line. Manual open/close sticks.
- **Tree sources, first version:** the dashboard's own work log, superpowers plans, BMAD ticket stores, and Plannotator Inbox step checklists
  (see "Task status"). Done/doing/next is computed from signals; the dashboard never writes into projects
  (owner, 2026-11-18). Hooks may write outside projects for the dashboard's own use.
- **Effort left:** tasks stay unsized (owner, 2026-11-18, reversing the earlier S/M/L choice). Effort left is a
  count of unfinished tasks, plus "≈ Nh" once the project has enough finished tasks to take a median from.
  A size is still shown when a plan happens to carry one.
- **Stall kinds to detect:** all six the owner has seen (quiet mid-task, hung tool, API error not resumed,
  permission prompt unanswered, subagent never reports, looping).
- **Layout:** project panels (mockup A) as the main view. Two more views as tabs: **Sessions** (a table of every
  live session and subagent) and **Triage** (Needs a look · Moving · Up next).
- **Look:** "Calm" (see "Look"), blues and greys, light mode with a slate-blue page and grey cards.
- **Light/dark:** follows the system by default, with a toggle (Auto → Light → Dark) remembered per browser.
  No theme picker.
- **Help:** a `?` button that runs a short spotlight tour of the page's parts.
- **Hover details:** on the work and the workers only (task, epic, session, subagent, project): one plain
  paragraph about that specific item. Appears after ~650 ms of a still mouse, hides when the mouse moves more
  than ~8 px or leaves; placed beside the panel, not over the row.
- **Session ↔ task link:** a session row says "Working on → <task>" (click jumps to it); the task shows a
  small "session <id>" tag; hovering either highlights both, subtly. Unmatched sessions say
  "Not linked to a task yet".
- **Usage:** the installer wraps the status line with a tap (see "Usage").
- **Start/stop without a command line:** Stop button on the page; auto-stop after no Claude Code session has
  been open for 30 minutes; a Start menu shortcut and a `/dashboard` command to start it and open the page.
- **Embedding later:** external page now; an https/mkcert embed in the Inbox is a later add-on.

## Data sources (all local, read-only)
Formats below are Claude Code internals, not documented interfaces; read on 2026-11-18 from version 2.1.327.
Every reader must tolerate missing fields and unknown values and show "unknown" rather than fail.

| What | Where | Used for |
|---|---|---|
| Open sessions | `~/.claude/sessions/<pid>.json`: `pid`, `procStart`, `sessionId`, `cwd`, `name`, `status` (`busy`/`idle`/`waiting`), `statusUpdatedAt` | Which sessions exist, their project, their state; process liveness via `pid` + `procStart` |
| Transcripts | `~/.claude/projects/<encoded cwd>/<sessionId>.jsonl` | Last activity time, tool calls (pending `tool_use` without `tool_result`), API errors (`"isApiErrorMessage":true`), token usage per message (`message.usage`), repeated commands (looping), plan files read or edited |
| Subagents | `~/.claude/projects/<encoded cwd>/<sessionId>/subagents/agent-<id>.jsonl` and `.meta.json`: `description`, `model`, `effort`, `finished` | Nesting under the parent session, running vs finished, last write |
| Background shells | `<scratchpad>/../tasks/<id>.output` (path found from the transcript's background-command result) | Output still growing = sign of life for long jobs |
| Processes | Windows process list with CPU time, sampled by one long-lived helper | Child process of a session alive and using CPU |
| Plans and tickets | `docs/superpowers/plans/*.md` (`### Task N:` headings); BMAD ticket stores | The tree |
| Inbox checklists | `~/.plannotator/inbox/projects/<project>/steps.jsonl`, `messages.jsonl` | The tree (fallback), session ↔ task link |
| Dashboard events | `~/.claude/dashboard/events.jsonl`, written by its `PostToolUse` hook | Session ↔ plan link |
| Git | `git log` per project | Commits that cite a task (`Task N`, ticket key) → task done; time spent |
| Usage | the status-line tap's file (below) | 5-hour and weekly %, reset times |

## Session states and stall rules
Each session (and subagent) is one of: **Working · Waiting on you · Idle (your turn) · Looks stuck · Gone**.
"Gone" = the process died while a tool call was pending. Thresholds start at the values below and live in a
config file; the builder may tune defaults.

| Stall | Working looks like | Looks stuck when |
|---|---|---|
| Quiet mid-task | `busy`, transcript growing | `busy`, no transcript write, no running tool and no CPU for 20 min |
| Hung tool | The tool's process uses CPU, or its output grows | Tool pending, 0% CPU and no new output for 20 min |
| API error not resumed | — | Last transcript entry is an API error and nothing follows for 5 min |
| Permission prompt | — | `waiting` for 5 min (shown as Waiting on you, escalated in Triage after 15) |
| Subagent never reports | Its transcript grows | Not `finished`, transcript unchanged 20 min, parent not waiting on it actively |
| Looping | — | The same command or edit repeated 6+ times in 10 min: shown as a softer hint, not "stuck" |

Every "Looks stuck" shows its evidence line (for example `pytest running 52 min · 0% CPU · no output for 31 min`).
A state change into Looks stuck or Waiting on you stays highlighted ("New") until the owner hovers it.

## Task status (the tree)
Four sources. The dashboard writes only its own work log; the rest are read-only. A project can have several,
and each epic says where it came from. When two sources describe the same work, the work log wins.
- **The dashboard's work log (primary, owner 2026-11-18):** every task a session takes on, however small, is
  recorded in `~/.claude/dashboard/worklog/<project>.jsonl`. That covers the task name when it starts, its steps
  if any, each status change, and done at the end. It is written through a one-line helper
  (`node ~/.claude/dashboard/note.mjs …`) so each entry costs a few tokens. It works with or without Plannotator. A
  session that keeps an Inbox checklist mirrors it here through the same helper. A session that works from a
  plan or ticket logs the plan task it is on, which gives the strongest session ↔ task link. It relies on the
  model remembering, so it adds names and structure; the activity signals stay the source of truth for whether a
  session is alive.
- **Superpowers plans:** one plan file = one epic; its `### Task N` headings are tasks.
- **BMAD ticket stores:** epics and stories from the store (`repo-ticketing` layout; closed = done). The builder
  reads the installed `bmad-ticket` skill for the exact layout.
- **Plannotator Inbox step checklists:** one Inbox thread with a checklist = one epic (thread subject as its
  name); each step is a task with its own status (`todo`/`doing`/`done`/`waiting`/`dropped`), timestamps, and the
  session that keeps it. Stored per project in `~/.plannotator/inbox/projects/<project>/steps.jsonl`, with thread
  subjects in `messages.jsonl` (Plannotator internals, read 2026-11-18; same tolerance rules as above). This is
  the fallback that gives projects without plans or tickets a tree, since the owner's rules already keep these
  checklists current.
- **Projects with none of the three** still show their live sessions, stalls, subagents and time; their tree
  reads "No plan found".

Status:
- **Done** when any of: a commit message cites the task unambiguously (see "Calls made"); every step checkbox under
  a plan task is ticked; a BMAD ticket is closed; an Inbox step is `done`.
- **Doing** when a live session is linked to it (below), it has some ticked steps, or an Inbox step is `doing`.
- **Next** otherwise. Dropped Inbox steps are hidden; `waiting` shows as Waiting on you.
- **The dashboard never writes plan files or repos.** Its computed status lives in its own state file under
  `~/.claude/dashboard/`. Sessions are asked by the component's rule file to tick plan tasks they finish, as a
  backstop.

Session ↔ task link, best first:
0. The session's own work-log entry for the task it is on.
1. An Inbox checklist names its session; its `doing` step is that session's task.
2. A small `PostToolUse` hook (matched to Read, Edit and Write only) records when a session reads or edits a plan
   or ticket file. It appends `{session, file, time}` to `~/.claude/dashboard/events.jsonl`, outside any project.
   Node launch costs 34–60 ms per matched call (measured), so the matcher stays narrow.
3. The most recent `Task N` the session referenced in its messages or tool inputs (from its transcript).
4. Otherwise "Not linked to a task yet".

Finding (2026-11-18): sessions on this machine don't use Claude Code's session task list (no TaskCreate or
TodoWrite calls in any transcript), so that list is not a usable source.

- **Time spent:** from the first to the last activity linked to the task, excluding idle gaps over 15 minutes.
  Inbox steps use their own timestamps. Epics and projects sum their tasks.
- **Effort left:** a count of unfinished tasks. Once a project has at least three finished tasks with measured
  time, it also shows "≈ Nh" from their median.

## Usage
- **Source:** the status line's documented stdin JSON is the only documented source of plan limits
  (`rate_limits.five_hour.used_percentage`, `rate_limits.five_hour.resets_at`, and the same for `seven_day`).
  Checked 2026-11-18 against code.claude.com docs: no hook, CLI flag, telemetry metric or documented API carries
  them, and only one status line command can be configured.
- **The tap:** the installer replaces the `statusLine` command with `node ~/.claude/dashboard/statusline-tap.mjs`,
  storing the original command in its manifest. The tap reads stdin, writes `rate_limits` (when present) with a
  timestamp to `~/.claude/dashboard/usage.json`, then runs the original command with the same stdin and prints
  its output unchanged. With no original command it prints nothing. Removal restores the original command.
- **Limits:** the numbers exist only for Pro, Max and Ultra subscribers, after a session's first reply. Otherwise
  the meters read "Usage not available". Team/Enterprise behaviour is not documented.
- **Tokens:** per session and per day, summed from transcripts' `message.usage`, shown in session hover details.

## The server
- One file, `~/.claude/dashboard/server.mjs`, Node built-ins only. Binds `127.0.0.1` on a fixed port (default
  47800, configurable). The port is the single-instance lock: a second start sees it taken and exits.
- **Start:** a `SessionStart` hook runs a tiny launcher that checks the port and, if free, spawns the server
  detached. Measured launch cost on this PC: Node starts in 34–60 ms (pwsh 211–282 ms), so the launcher is Node.
- **Reading:** watches the sources above (file watching plus a 5-second poll for process CPU via one long-lived
  helper), keeps an in-memory model, and pushes changes to the page over Server-Sent Events.
- **Stop:** the page's Stop button (POST with a per-start secret token embedded in the page; requests without it
  or from another origin are refused); auto-stop after 30 minutes with no open session.
- **Page:** served from the same process; all rendering of transcript-derived text uses `textContent`, never
  `innerHTML`, since transcripts contain arbitrary text.
- **Logs:** `~/.claude/dashboard/server.log`, size-capped.

## Look
- "Calm": Instrument Sans for text, Geist Mono for numbers only; 16px body; sentence case.
- Light: slate-blue page (`#c5d2e3`), grey cards (`#e8ecf1`), near-black text. Dark: blue-black (`#0d1117`)
  with dark slate cards. Working blue, Waiting violet, Done teal, Looks stuck red.
- Signature: the **life line**, a ridge per session over the last 60 minutes, one slot per minute of activity;
  flat and red when stuck.
- Fonts are self-hosted with the component (no network needed); the mockup loads them from Google Fonts.
- Reference mockup: `docs/superpowers/specs/live-dashboard/mockup.html` (invented data).

## Installer component
- New component **Dashboard**: `dashboard/server.mjs`, `dashboard/launcher.mjs`, `dashboard/statusline-tap.mjs`,
  the page assets, `commands/dashboard.md`, a `SessionStart` hook entry, the status-line wrap, and a Start menu
  shortcut. Needs Node.js (shared check with Rigor).
- `-Remove Dashboard` removes the hook, restores the original status line, deletes the shortcut, and retires the
  files as `*.retired`, matching how Rigor is removed.
- Docs move with it: `README.md`, `docs/setup-guide.html`, `docs/setup-prompt.md`, and a `docs/decisions.md`
  entry, in the same change.

## Measurements (2026-11-18, this PC)
- Inbox embedding: inline `fetch` and iframe of `http://127.0.0.1` blocked by the Inbox's CSP
  (`connect-src https:`, `frame-src https:`); an attached HTML file is a snapshot and does not update.
- Startup: Node 34–60 ms, pwsh 211–282 ms.
- Usage over the last 7 days: 7 projects, 30 sessions, 341 subagent runs; 84 project folders in total.
- Session registry: three open sessions showed `busy`, `idle` and `waiting`.
- API-error markers found in 4 transcripts.

## Calls made after the builder check (Claude's, the owner can override)
- **Status line wrap:** only the user-level `statusLine` in `~/.claude/settings.json` is wrapped. The whole
  original object (`type`, `command`, `padding`, `refreshInterval`, …) is saved in the manifest, and the tap
  runs its `command`. No status line set: the tap is installed alone and prints nothing. A project-level
  `statusLine` overrides the user one, so usage is unavailable there; the dashboard says so instead of handling it.
  If something rewrites the setting after install, the dashboard shows "usage unavailable" and the installer
  reports it on the next run. On removal the original is restored only if the current value is still the tap;
  otherwise it is left alone and reported.
- **Hook and command:** same mechanism as Rigor. One entry merged into the `SessionStart` array, found again by
  its `launcher.mjs` path, with other hooks untouched. Node is resolved from PATH, as Rigor's is. The launcher
  checks the port, spawns the server detached and exits at once; any failure is swallowed and logged, so session
  start is never delayed or broken. `/dashboard` installs to `~/.claude/commands/dashboard.md`. The Start menu
  shortcut stores Node's absolute path, resolved at install time.
- **Component default:** opt-in like the others, offered in the installer's list; `-Owner` includes it.
- **Session ↔ project:** a session's project is the git top-level of its `cwd` (worktrees resolve to their own
  top-level), or the `cwd` itself outside git.
- **Commit ↔ task matching is conservative:** a commit marks a task done only when its message names the task
  and the plan is unambiguous. That means the commit names the plan, or the session that made the commit had
  linked to that plan, or the repo has only one unfinished plan. When it's ambiguous, nothing is marked: a
  missed tick is better than a wrong one.
- **Fonts:** Instrument Sans and Geist Mono (both SIL OFL) are bundled as woff2 files with their licence texts.
- **Stop token:** it guards against other websites in the browser, not against local programs, which could end
  the process anyway. Host must be `127.0.0.1`/`localhost`, Origin must match, and the token must match.

## Left to the builder
- Exact thresholds' defaults, polling intervals, and the config file's shape.
- How the CPU helper samples processes on Windows.
- Folding and paging for very large trees and many subagents (finished subagents collapse to a count).
- Responsive behaviour below desktop width.
- Test strategy, within `tests/run.ps1` conventions; never touching the real `~/.claude`.

## Rule file
The component installs `rules/dashboard.md`, which comes and goes with it and leaves `methods.md` alone (owner,
2026-11-18). Its habits: record every task in the work log through the helper (start, steps, status changes,
done), mirroring any Inbox checklist there; and when you finish a task from a plan, tick it in the plan. Rule text gets the owner's
sign-off before install, as all rule changes do.

## Answered by the owner (2026-11-18)
- The tree reads superpowers plans, BMAD ticket stores, **and** Inbox checklists from the first version.
- The dashboard computes status and never writes into projects. Hooks may write outside projects for its own use.
  Calling a remote web service was considered and not needed: everything stays on this machine.
- Tasks stay unsized.
- The habit lives in the component's own rule file.
- Every task, however small, leaves a work-log entry the dashboard owns, so the dashboard stands on its own
  without Plannotator. Plans and tickets stay as sources: they hold work not yet started and survive sessions
  that forgot to log.
