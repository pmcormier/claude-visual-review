# Dashboard heartbeat: sessions watch their own long jobs and close what they open

Status: approved by the owner 2026-11-20, including the rule text.

## Intent

Sessions stay open for hours or days. Two things go wrong on the dashboard:

1. **Hung jobs nobody notices.** A session starts a long background job, such as a CI watch, a build or a
   download, and then waits. If the job hangs, nothing ever wakes the session. The dashboard eventually says
   "looks stuck", and the owner has to go and find out why.
2. **Checklists that go stale.** A session ends its turn with a step still marked "doing", or with work finished
   but not closed. The dashboard then shows work that isn't happening.

The owner wants the session to check itself, like a heartbeat, so that the status stays true and the agent stays
on top of the processes it launched, at little cost. In his words: "It should check itself. Sort like a heartbeat
check. Keeps our status up to date, and keeps the agent on top of processes it launched with little cost." Also:
"I do like that it is low cost, and fast."

## Goals

- A session that starts a long background job notices by itself when that job stops making progress. It then
  acts (retry, work around it) or asks the owner, before the dashboard's 20-minute "looks stuck" rule fires.
- No fixed deadline on any job. A job that takes 30 minutes or 2 hours is never cut off while it keeps
  producing output.
- A healthy job costs no model tokens to watch.
- A session that ends a turn with its work log out of date is reminded once, and only when it really is out of
  date.

## Non-goals

- Watching sessions from outside. A session that dies takes its watcher with it. The dashboard already shows that
  as "Gone".
- Waking an idle session that has no job running. Nothing launched means nothing to watch.
- Changing when the dashboard calls something stuck. The stall rules stay as they are (decision 31).

## Anti-goals (a failure even if it works)

- **A paid wake-up loop.** A dead job must not wake its session over and over. Each wake costs about $0.15 at a
  155k-token conversation, measured 2026-11-20 (see Costs).
- **A timeout in disguise.** The quiet window measures silence, not run time.
- **Nagging.** The end-of-turn reminder fires once per stale state, never on every turn.

## Constraints

- No network or model calls from the dashboard's own scripts. They write only under `~/.claude/dashboard/`, and
  never into projects (existing rule).
- Scripts print nothing unexpected and never fail a session. The watcher's one output line is its message.
- Tests never touch the real `~/.claude` (`CVR_DASH_CLAUDE_HOME`, as today).
- The repo is public: `tools/check-personal.ps1` passes.
- Rule changes go through the owner's sign-off (this document).
- Docs move with the installed files: README Dashboard row, `docs/setup-guide.html`, `docs/setup-prompt.md`, and
  a decision entry (37).

## Facts this rests on (verified 2026-11-20 unless marked)

- A session acts only when something wakes it: the owner's message, a background command exiting, a timer, or a
  monitor event. A hung job never exits, so it never wakes anyone.
- A background command (`Bash`/`PowerShell` with `run_in_background`) gets an output file at
  `<temp>/claude/<…>/<session>/tasks/<id>.output`. The session is told the path when the job starts. This
  machine has 713 such files across 64 sessions. The dashboard already measures their growth
  (`procs.mjs outputGrowth`).
- A background command's exit wakes the session with a notification.
- **Unverified:** whether a background command is ever killed for running too long. `Monitor` is capped at 30
  minutes; background commands state no cap. **The build checks this first** (Task 1). If a cap exists, the
  watcher exits just before it with a "still fine, re-arm me" line, at the cost of one wake per cap period.
- When a background command ends, Claude Code appends a last line `[exited with code N]` to its output file
  (seen on this machine 2026-11-20).
- Background commands inherit `CLAUDE_CODE_SESSION_ID` (checked 2026-11-20). The output path also contains the
  session id (`…/<session>/tasks/<id>.output`), which serves as a fallback.
- `note.mjs` records the session id on every work-log line, so the hook can find the session's current entry.
- Foreground commands have no output file, and Claude Code stops them after 2 minutes by default, 10 at most
  (the tool's own description). They are out of scope.
- The dashboard's stuck threshold for a tool is `hungTool: 20` minutes (`lib/config.mjs`).

## Costs (measured 2026-11-20 on this session)

One model call at a 155,558-token conversation, served from the 1-hour cache: about $0.05 at Opus 5.5 list
prices. That is $0.031 for re-reading the cache, $0.006 for new cache writes and $0.015 for output. A wake takes
about 3 calls (check the job, update the log, update the checklist), so **about $0.15**. At this session's
largest size (525k tokens), it is about $0.40. After more than an hour of quiet, the cache has expired, and the
first call writes the whole conversation again: about $1.25 at 155k tokens. On a Claude plan, the same
proportions come out of usage limits instead of dollars.

## Approaches considered

- **A · Quiet-spell watcher** (chosen). A small script, started beside the job, exits only when the job's output
  has been silent (or repeating) for the quiet window. Its exit wakes the session. It costs nothing while output
  flows.
- **B · Timed heartbeat.** A timer wakes the session every ~20 minutes while a job runs. It is simple, but it
  pays for a turn on every tick even when all is well: about $0.90 for a two-hour job at today's size.
- **C · End-of-turn tidy-up** (chosen, as an add-on to A). A Stop hook reminds the session once when its work log
  says "doing" but nothing is being done or watched.

The owner picked **A + C** on 2026-11-20, liking that it is "low cost, and fast". B was rejected on cost.

## The design

### Part A: the watcher (`global/dashboard/watch.mjs`)

**How a session uses it.** Right after starting a long background job, in the same turn, the session starts the
watcher as a second background command. The job's output path comes back in the first command's result, so the
watcher is the next call, not a parallel one:

```
node ~/.claude/dashboard/watch.mjs --file "<job output file>" --what "<job description>"
```

It costs one extra tool call in a turn that is happening anyway.

**What it does:**
- **Polls the file every 15 seconds.** It ignores growth from the watcher's own writes; it writes nothing into
  the job's file.
- **Quiet:** the file has not grown for the quiet window. The default is **15 minutes**, under the dashboard's
  20, so the session acts before the page calls it stuck.
  - It exits, printing one line, for example:
    `Quiet 15 min: "<what>". Last line: <last non-empty line, clipped to 200>.`
- **Repeating:** the file keeps growing, but every new line in the last quiet window is identical to a line
  already seen in that window, such as a retry loop printing the same error.
  - It exits with `Repeating for 15 min: "<what>". Line: <the repeated line>.`
- **Job ended:** the file's last line is `[exited with code N]`. The job's own exit has already woken the
  session, which should stop the watcher (rule). The watcher waits 2 minutes for that, then exits with
  `Job ended (code N): "<what>". Stop watching it.`, a cheap reminder if the session forgot.
- **Gone:** the file was deleted or can't be read for 2 consecutive polls.
  - It exits with `Output file gone: "<what>".`
- **No new output since the last wake.** Each watcher keeps a marker (below) that records the file size when it
  exited. A new watcher on the same file reads it. If it then goes quiet without the file having grown since the
  previous quiet exit, it adds ` No new output since the last check.` to its line. That is the rule's cue to stop
  re-arming.
- **Flags:**
  - `--quiet <minutes>` overrides the window, between 5 and 120. A session uses it for a job it knows prints
    rarely, such as a long download without progress output.
- **Never fails.** Bad flags or a missing file exit at once with a one-line explanation. It writes errors to
  `<dashHome>/watch.log`.

**The marker: the zero-cost heartbeat.** While running, the watcher keeps
`<dashHome>/watch/<session>-<hash of file path>.json`:

```
{ session, file, what, startedAt, beatAt, lastGrowthAt, size, quietMin, exited: null | {at, reason, size} }
```

- `session` comes from `CLAUDE_CODE_SESSION_ID`.
- `beatAt` is refreshed every minute, so a watcher that died shows a stale beat.
- On exit, the watcher writes `exited` and leaves the file, so the next watcher can compare sizes.
- Markers older than 7 days are pruned when the dashboard server starts, and once a day while it runs.
- **Live** means `exited` is null and `beatAt` is within 3 minutes. The dashboard and the hook use the same
  test (one helper in `lib/`).

**What the dashboard shows.** For a session with a live marker (`beatAt` within 3 minutes), the job's line gets
a short note: `Watched · last output 2 min ago`. Its hover says: "The session is watching this job and will check
on it after 15 minutes of silence." No stall rule changes. If the watcher fires and the session still doesn't act,
the dashboard says "looks stuck" at 20 minutes, as today.

**The job ends normally.** The job's own exit wakes the session. In that turn, the rule tells it to stop the
watcher (TaskStop). If it forgets, the watcher exits at its next quiet window, costing one wasted wake. The
`Job ended` exit catches that within 2 minutes instead.

### Part C: the end-of-turn tidy-up (`global/dashboard/tidy-hook.mjs`, Stop hook)

It runs every time a session ends a turn. It is fast and reads only small files.

**When it reminds the session:**
1. The session's current work-log entry (latest `start` for this `session_id`, not yet `done`/`drop`) has at
   least one step `doing`. An open entry with no steps does not count: ordinary conversation turns end with one
   open all the time.
2. The session has no live watcher marker.
3. The turn is not ending on a question to the owner. "Asking" means the last assistant text ends in `?`, or an
   `AskUserQuestion` is pending. That reuses `lastAsk` from `transcripts.mjs`, or a small copy of its rule, so the
   hook stays light.
4. `stop_hook_active` is false. That flag means this turn is already the result of a Stop-hook reminder, so the
   hook never chains.
5. The same state hasn't been reminded before. The state is the entry, the doing steps and their statuses, and it
   is kept in `<dashHome>/tidy/<session>.json`. A state that was reminded once is never reminded again, so if the
   session decides "doing" is right, it stays.

**What it does:** returns `{"decision": "block", "reason": "<text>"}`, which makes Claude take one more turn with
this text:

> Work-log check: "<entry title>" still has step <n> "<name>" marked doing, and nothing is running or watched.
> If it's finished, mark it done (and your Inbox checklist). If it waits on the owner, mark it waiting. If a job
> is running, start a watcher for it. If it's right as it is, say nothing and end the turn.

The cost is one extra call (about $0.05) only when the log looks wrong. Otherwise it is zero.

**Installed** through the installer's hook table, as a fourth row:
`@{ Component = 'Dashboard'; Event = 'Stop'; Script = 'dashboard/tidy-hook.mjs'; Find = (& $dashFind 'tidy-hook.mjs') }`.
Uninstall removes it like the others.

### The rule text (added to `global/rules/dashboard.md`)

A new bullet after "Close what you open":

> - **Watch what you launch.** When you start a background job that may run more than a few minutes (a CI watch,
>   a build, a long test run, a download), start a watcher for it in the same turn:
>   `node ~/.claude/dashboard/watch.mjs --file "<the job's output file>" --what "<what the job is>"`, also in
>   the background. It costs nothing while the job keeps printing, and wakes you after 15 minutes of silence or
>   of the same lines repeating (`--quiet <min>` for a job that prints rarely). When it wakes you, look at the
>   job: if it's moving, start the watcher again; if it's stuck, retry it, work around it, or mark the step
>   `waiting` and tell the person. When the line says "No new output since the last check", don't re-arm: act or
>   ask. When the job finishes on its own, stop its watcher. At the end of a turn a check may remind you once
>   that a step is still `doing`; fix the log, or end the turn if it's right.

## Left to the builder

- Internals of the repeat check, as long as a retry loop printing one error is caught and a normal build log is
  not. Test both.
- Where the hook's `lastAsk` logic lives: shared with `transcripts.mjs`, or a small copy. The hook must stay
  quick, a few hundred milliseconds on a large transcript (read only its tail).
- Exact page placement of the `Watched` note, following the existing session-line style.
- How the dashboard joins a marker to a job: by output file path, which `pendingTool.outputFile` already carries.

## Build order

Task 1 is a gate. A 25-minute background command was started on 2026-11-20 to check whether background
commands are ever cut off; its result goes into this document before the plan is written. If a cap exists, the
watcher exits 1 minute before it with `Still running fine after N min: "<what>". Start the watcher again.`

## Builder's calls made in this document

- **The 15-minute default window.** It is under the dashboard's 20-minute stuck rule, so the session moves first.
- **Repeat and gone exits.** These came from the owner's question "does this cover a shell that has gone bad".
- **The "no new output since the last check" cue in place of a counted wake limit.** It needs no counter, and it
  stops the loop at the second wake.
- **The reminder fires once per state, not per turn.** That follows the anti-goal of nagging.
- **No `--pid` flag.** A background job's process ID isn't readily known on Windows, and the exit line covers the
  same need.
- **Repeat check:** a line counts as repeated only when it is identical after trimming. Progress lines that
  change (percentages, counters) are new lines. A job printing only "Waiting..." for 15 minutes does wake the
  session, by design: that is 15 minutes without progress.
- **The reminder only counts steps marked `doing`**, not an open entry without steps.
