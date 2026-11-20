# Decisions

Newest last. A reversal is a new entry that names the one it replaces.

## 1. Personal overrides, not team ones (2026-11-06)
BMAD overrides go in `bmad-<skill>.user.toml` (gitignored), not the committed `bmad-<skill>.toml`.
Plannotator and Visualizer are tools on the owner's machines; some BMAD repos are or will be public, and
collaborators shouldn't inherit a dependency they don't have.

## 2. One global policy file, referenced by path (2026-11-06)
BMAD's resolver reads only the skill's defaults, the project's `.toml` and the project's `.user.toml`, with no
home-folder layer. Each override points (`persistent_facts = ["file:~/.claude/bmad/interactive-review.md"]`,
absolute path) at one shared file, so a policy edit reaches every project without touching the 102 overrides.

## 3. Real decision points only (2026-11-06)
Reviews open for sign-offs, code and findings, choices between alternatives, and diagrams. Quick
confirmations, progress and debugging stay in the terminal, to avoid a browser tab for every "continue?".

## 4. Plannotator is the gate; Visualizer is for visual options (2026-11-06)
One tool handles annotate, approve and reject, and its `:::question` blocks handle picking between options.
Visualizer is kept for picking between visual options (layouts, themes, mockups), where click-to-pick fits.

## 5. Visuals welcome, not required (2026-11-06)
The owner's review note: "Expected is a bit heavy … Desired when they would be helpful is more accurate."

## 6. A `.cmd` opener for VS Code tabs (2026-11-06)
The Plannotator WebView extension sets `PLANNOTATOR_BROWSER` to an extensionless shell script. Windows can't
run it and shows an "open with" dialog instead. `bin/open-in-vscode.cmd` makes the same call to the
extension's local port, and `PLANNOTATOR_BROWSER` is set to it in Claude Code's settings so it overrides the
extension's value.

## 7. A global rule plus a thin BMAD layer (2026-11-06)
The general behaviour lives in `rules/visual-review.md` and applies everywhere. The BMAD file keeps only what is
specific to BMAD (decision points, where visuals live, approval boundaries, memlog, Fable review), so the two
can't drift apart.

## 8. Every review names its session (2026-11-06)
With several Claude windows open, a review tab must say which session is waiting on it. The title is
`<project> · <subject> · <first 8 of CLAUDE_CODE_SESSION_ID>`, set through Plannotator's `--title`, Visualizer's
`title`, or the page's `<title>`.

## 9. The installer requires `plannotator` on PATH, not just on disk (2026-11-06)
The rules call a bare `plannotator`. On one machine the binary was installed while VS Code was running,
so every terminal VS Code opened kept the old PATH, and the rule's command failed even though the installer
said "ok" (it fell back to `%LOCALAPPDATA%\plannotator`). The installer now reports that case as a miss and
says to close every VS Code window and reopen VS Code; a new terminal isn't enough. Adding a full-path
fallback to the rule was the alternative: it would hide a broken environment that other tools calling
Plannotator also hit, and lengthen a rule loaded into every session.

## 10. The opener closes the console `start` gives it (2026-11-06)
On Windows Plannotator launches `PLANNOTATOR_BROWSER` as `cmd.exe /c start "" <opener> <url>`, and `start`
runs a batch file in a new console under `cmd /K`, so `exit /b` left one terminal window open per review. The
opener now ends with `exit` when its own name is in `%CMDCMDLINE%`, which is only true in the console `start`
made for it (or a `cmd /c` call, where exiting is harmless); a direct call from someone's shell keeps the shell
open. It copies `CMDCMDLINE` into a variable before the substitution: substituting on `CMDCMDLINE` itself edits
the process's real command line, which made the first version of this check always fail. A console still
flashes briefly for each review: avoiding it needs a windowless launcher (WSH or a small compiled exe), which is
more to install and maintain than a sub-second flash is worth for now.

## 11. Code review only when it's due (2026-11-06)
The owner's note: "I would only review code if I ask to or if the agent thinks it is prudent. It could offer
though when regular feedback points occur." The rule had listed code changes as review material, so every
edit opened a gated diff review. Now a diff opens only on request, or when Claude judges it prudent (a risky,
wide or hard-to-undo change) and says why; otherwise Claude offers it in one line at a natural feedback point.
Review findings stay a decision point (a list to tick), once per BMAD story: choosing what to fix is a choice,
not a code review (the owner's answer).

## 12. Workflow config lives here (2026-11-06)
The Fable final-review rule and its overrides lived only as untracked files in another project, and
`rules/bmad.md` existed only in `~/.claude`. The owner moved them here: this repo is about how we work. It uses
a layout a planned config-sync tool could take unchanged (`global/` mirrors `~/.claude`).
The installer now copies all of `global/` rather than a list, so a new file there needs no installer change.


## 13. Say it in one place (2026-11-06)
The owner's note: "there is also a lot of crossover text or repeated text here in the session window. I end up
reading both… If it is totally redundant, keep it out of here in the session and let me review in one place
(plannotator)." When a review opens, the terminal gives only its title, what the owner needs to do, and anything
not in the review under **Not in the review**. Review content is never restated in the terminal; the review
files and this record keep the history.

## 14. Menus count when choosing needs context (2026-11-06)
Two sessions that had the rules loaded never opened a review. At their decision points they asked with
Claude Code's `AskUserQuestion` menu instead: a `bmad-build` plan approval (where the owner had to ask to see the
plan first) and a three-way choice whose costs were explained in the terminal. Neither rule file named
`AskUserQuestion`, and "not as markdown in the terminal" didn't cover a menu. Now a choice that needs context
goes in a review even where a skill would show a menu, and a pick whose options speak for themselves stays a
menu. The owner chose this over "every choice": "This is a heavier tool and we only want to utilize it when it
is efficient to do so."

## 15. Only the session the owner talks to opens reviews (2026-11-06)
The owner asked whether background agents could open reviews or ask questions. None of 442 subagent and
teammate transcripts the owner had on hand had done so, but nothing prevented it: teammates load the rules, and
subagents run BMAD skills whose overrides say to open reviews. Such a review would block the agent, and the
answer would go to the agent rather than the main session. Subagents, teammates and background agents now hand
decisions back to the session that started them.

## 16. Review or Inbox (2026-11-11)
The owner often runs work unattended and wants the end-of-run report in Plannotator, not the terminal, and found
the Inbox hard to read because information and requests were mixed. A gated review still handles anything
work can't go on without; the Plannotator Inbox takes what can wait. Unattended or long runs end with one Inbox
report: what changed (with a chart of lines changed by area), what went right and wrong, what is blocked, steps
done, next steps, and questions as `:::question` blocks. A guided diff walkthrough is optional: sent when the
change is important, otherwise offered ("I should always have the option"). Board cards and thread checklists
carry running updates without notifying. Agents mark `Stopped:` and `Holds up:` only when true, so the Inbox's
sections separate requests from information. Unattended runs skip blocking reviews but still report. The Inbox
can't load in the WebView extension (it sends `X-Frame-Options: DENY`), so its link opens in VS Code's built-in
browser.

## 17. Next steps live in the thread (2026-11-11)
In another project the owner asked, "Why am I not seeing these next steps in tator?": the session had given next
steps and waiting items only in the chat. That session proposed a global line. It went into `visual-review.md`
rather than `plannotator-inbox.md`, which Plannotator rewrites itself. Two changes from the proposal: the chat
gives a one-line pointer instead of a second copy, which keeps decision 13; and one-off answers don't open a
thread, only work that has a thread or outlasts the reply.

## 18. A windowless opener (2026-11-11)
Replaces the `.cmd` in decision 6 and the console-closing in decision 10. Every review still flashed a console,
because Windows gives a batch file its own console, and Plannotator 0.28.61 still runs whatever
`PLANNOTATOR_BROWSER` names, with no built-in VS Code tab support. The opener is now `open-in-vscode.exe`, a
Windows program with no console, built by the installer from `global/visual-review/bin/open-in-vscode.cs` with
the C# compiler that ships with Windows (`csc.exe`, .NET Framework 4). It behaves the same: extension port first,
browser otherwise. Tested launched as Plannotator launches it: 0 console windows against 2 for the `.cmd`, link
intact. A `.vbs` script was the simpler alternative, but Microsoft is phasing VBScript out of Windows. The old
`.cmd` stays on disk, unused, because sessions started before the change still call it.

## 19. The Inbox by default (2026-11-11)
Replaces decision 16's "gated review for sign-offs". The owner chose "The Inbox, for everything; a review tab
only when I ask for one." A sign-off is now an Inbox message with the files attached and an Approve / Change
question marked `Stopped:`; the session ends its turn and the reply comes back by itself. Code reviews go out
as guided walkthroughs, choices and findings as `:::question` blocks, visual options as picture choices
(Visualizer only on request). Plan mode's own review tab stays, since changing it means turning off
Plannotator's hook. The BMAD override lines that still name `plannotator review` were left; the policy file
decides how things are shown. Fallback: the Inbox tool, else `plannotator inbox call`, else the terminal. The
owner approved this in the Inbox, the first sign-off done that way.

## 20. Files changed, so the owner can explore (2026-11-13)
The owner wants reports to make exploring the codebase easy, to stay familiar with it. Every Inbox report on
changed files opens with a **Files changed** list grouped by area (two or three files worth opening each, with
why they changed), `vscode://` links, the diff attached as a `.patch`, and an opt-in guided walkthrough. Tested
live in the Inbox: `vscode://` links in plain Markdown open VS Code (the
owner allowed the dialog once); plain paths do nothing; a `.patch` attachment shows as a coloured diff; folding
trees fold, but their links are blocked (raw HTML is cleaned, and `html` blocks run in a sandbox that cannot
launch VS Code), so the list is plain for now and a feature request to Plannotator asks for clickable folding
trees. A Sonnet agent at medium effort writes it, given the main session's note of intent, since a fresh agent
lacks the why and a fork would run at the parent's cost; the report waits for it rather than following up.
Lines in Markdown files may not land, because the owner's Markdown plugin opens them.

## 21. The Fable final review is personal (2026-11-16)
The owner: "Any repo can be shared." The Fable review was enforced by 8 team overrides plus
`fable-final-review.md`, committed into each project's `_bmad/custom/`, so committing them would switch it on
for every teammate who runs BMAD there, and one without Fable would be told to stop. It now loads from the
personal layer: `fable-final-review.md` lives in `~/.claude/bmad/`, and `write_overrides.py` adds it to the
`.user.toml` of the 8 planning skills, next to the review policy. BMAD appends `persistent_facts` across layers,
so a project that still commits the team overrides (as older installs did) loads it
twice, which is harmless; the owner removes those in their own commits when wanted. Recovery is rerunning
`write_overrides.py`. `bmad-templates/` is removed. Considered keeping team files in repos only the owner uses;
dropped because any repo may be shared later.
Follow-up: overrides written before this decision were skipped as existing, so the Fable line
never reached them. `write_overrides.py` now adds that one line to an existing planning-skill override that
lacks it, and the installer's check requires the personal path, so a committed team copy no longer passes it.
Added to every existing override on the owner's machines; all resolve.

## 22. Reports adapt to where the session runs (2026-11-16)
Claude may run in a plain terminal rather than VS Code (to save memory, for example). Outside VS Code a `vscode://` link still works but starts VS Code, so reports also
attach the two or three highlighted files, which the Inbox opens as code with line comments; the links stay for
when the owner wants to explore. Detection is `TERM_PROGRAM=vscode`, which VS Code's terminal sets (confirmed)
and a plain terminal doesn't. Plannotator covers reading files and diffs, not navigating a codebase, so VS Code
stays the place to explore.

## 23. One methods rule for every machine (2026-11-16)
One of the owner's machines had its own `~/.claude/rules/methods.md` and skipped `rules/bmad.md`; another had
only `bmad.md`. They contradicted each other on two points, and the next install would have put both on the
first. The owner chose to merge them into `global/rules/methods.md`, installed everywhere: the method is
picked per task, from a section moved here from that machine's `~/.claude/CLAUDE.md` (so every machine
chooses the same way); Claude closes a ticket when the final commit is in and its `Verify:` check passed, and
brings anything doubtful to the owner (replacing "only the user marks a ticket done"; `bmad-build` still stops
at `built`). Kept from `bmad.md`: the Fable review steps, the default workflow preset, accepting `bmad-spec`'s
handoff. Kept from `methods.md`: work tracking, `Refs <KEY>` commits, openness to new frameworks. The installer
renames a leftover `~/.claude/rules/bmad.md` to `bmad.md.retired` so it stops loading.

## 24. A generic, shareable repo (2026-11-16)
The owner wanted to share this setup and keep others current without maintaining a second repo. Considered:
giving people access to the repo as it was (exposed the owner's journal: other projects, machines, session
notes); a generated prompt carrying the files (a second copy that goes stale); a script-published public copy
(nothing personal leaves, but two repos and a publish step); restructuring this repo to be generic. The owner
picked the restructure: one repo, `git pull` for updates. The journal moved out to the maintainer's notes;
`tools/check-personal.ps1` (a pre-commit hook via `install.ps1 -Owner`) keeps it out, with its term list
outside the repo so the terms are never published. The installer gained opt-in components, a manifest of what
it wrote, and never replaces a file you changed without asking; an agent running it gets the command to
rerun instead of a prompt. The rules ship unchanged ("the owner" is whoever installed them); preferences go in
a rule file of your own. The old history was removed by deleting and recreating the GitHub repo, since
force-pushed commits can still be fetched by ID; a bundle of it is kept privately. License: MIT. Design and
plan: `docs/superpowers/`.

## 25. The Fable final review is its own component (2026-11-16)
`methods.md` held the Fable review steps, including "if Fable is unavailable, stop". Installed without the
Fable component, that would stop someone's BMAD planning at every final doc. The steps moved, unchanged, into
`rules/fable.md`, installed only with the Fable component, and `write_overrides.py` adds the Fable line to BMAD
overrides only when `~/.claude/bmad/fable-final-review.md` is installed.

## 26. The installer is run by agents (2026-11-16)
The owner: "this will be agent driven ... Nobody is going to just run it." So the installer's output is for an
agent to read and relay. Every problem it can meet (invalid `settings.json`, a missing `claude`, `code` or C#
compiler, a skipped file) is a one-line `MISS` with its fix, and the run continues instead of aborting. It ends
with a Summary of what's left to do and exits 0 when done, 3 when installed but something needs attention, so an
agent can tell them apart without parsing every line; the setup prompt tells the agent to relay the Summary.
Backups are timestamped (`.bak-yyyyMMdd-HHmmss`) so a rerun never overwrites an earlier one. In the same change,
end-of-run reports chart lines changed as horizontal stacked bars in an `html` block (by area, split by kind,
removed lines in a lighter shade, totals at the end): the owner found that clearer than a Mermaid bar chart.

## 27. Rigor: a pushback check sent with every message (2026-11-16)
The owner noticed sessions leaning toward whatever they said when they pushed back, and wanted them to seek the
right answer instead, on every machine. Measured before writing anything (headless `claude -p`, read-only
tools): fresh short sessions held correct answers under wrong pushback, but forks of a long working session
(a 39 MB transcript) did not. Pushed twice with a wrong claim the session had already measured as false, today's
setup gave in fully in 1 of 3 runs and softened in the other 2; the same rule loaded once at session start gave
in (1 of 1); the sharper check in `rigor/pushback.md`, sent with every message by a `UserPromptSubmit` hook, held
3 of 3 while still doing what was asked. How the rule arrives mattered more than its wording. Small numbers, one
scenario: a strong hint, not proof. The opposite risk, a session digging in when the owner is right but has no proof
to show, was tested too: told truthfully, without proof, that a PR it thought was pending had merged, all 3 runs
(with and without the hook) took it at once, marked it unverified, and planned to check. The same tests caught sessions with no tools claiming "verified" for checks
they never ran, so both files now say a claim is verified only when a tool call in this session produced it.

Considered: a line in `CLAUDE.md` (loaded once, the delivery that failed); the whole rigor contract in the hook
(about six times longer on every message, and untested); a private second repo (can hold personal lines, but
a second update step). Picked an opt-in component here, with only the short, tested check in the hook. The
check keeps "I'll do it" apart from "you're right", so the owner can still overrule; it only stops the session
pretending to be persuaded. The hook is merged into `settings.json` by the script's file name, so a rerun never
adds it twice and other hooks are kept.

## 28. Rigor: claims that matter, where measurements go, and how to turn it off (2026-11-16)
Three follow-ups to decision 27, picked by the owner after review. Section 1 now labels only claims that a
decision, action or recommendation rests on: labelling every sentence pulled against a concise output style
and made replies longer without making them safer. Section 6 now says where a measurement is recorded: where
the work keeps its decisions, else the project's memory. And leaving Rigor out of `-Components` now turns it
off: the hook is removed from `settings.json` and Rigor's unchanged files are retired as `*.retired`, because a
hook that runs on every message should not outlive the choice to drop it. Only Rigor does this; leaving out
another component still leaves its files, since none of them acts on every message and an explicit partial
`-Components` run shouldn't quietly switch off rules someone still relies on.

## 29. Rigor is removed only on request; tests don't build the opener (2026-11-16)
Decision 28 made leaving Rigor out of `-Components` turn it off. But this repo's own examples list fewer
components (`-Components Review,Methods,Bmad -BmadProject ...` in the setup guide, the `-Replace` examples in
the installer), and that run printed "retired" and still exited 0, so an agent running it had no reason to say
anything: copying an example quietly switched off the pushback check. Turning it off now takes
`-Remove Rigor`; a run that leaves Rigor out of `-Components` keeps it and says how to remove it. Decision 28's
reason stands for the explicit case: `-Remove Rigor` takes the hook out and retires the files. Considered making
the silent removal exit 3 so an agent relays it; rejected because it still removes first and asks after.

In the same change the tests stopped compiling the opener (installer `-SkipBuild`, used by the tests unless
`CVR_TEST_BUILD=1`), and `tests/run.ps1` deletes the temp folders it made: each run had built about 30 copies of
`open-in-vscode.exe` in `%TEMP%`, which a security tool on the maintainer's machine quarantined one by one.

Follow-ups picked by the owner: naming Rigor in both `-Components` and `-Remove` now stops with an error
instead of letting `-Remove` win silently (a bare `-Remove Rigor` on an update, which reuses last time's
components, is not a conflict). Each test file now deletes its own temp folders (`Complete-Tests` in
`tests/lib.ps1`), so running one file alone leaves nothing behind; `tests/run.ps1` still sweeps folders its
run made, as a backstop for a file that crashes.

## 30. A live dashboard, designed (2026-11-18)
The owner wanted one live view of all Claude Code work on the machine: what is moving, done, next, and what has
quietly stopped. The Plannotator Inbox hears from sessions that ask; it can't see the ones that stall without
asking. Design: `docs/superpowers/specs/2026-11-18-live-dashboard-design.md`. The main choices and why:
- **A local Node server started by a `SessionStart` hook, one per machine.** A stall is the absence of events, so
  hooks alone rewriting a page can't notice one; something has to keep watching. Node is already required by
  Rigor, and it starts in 34–60 ms here against 211–282 ms for pwsh.
- **An external page, not embedded in the Inbox.** Tested: the Inbox's CSP allows only `https:` for fetch and
  frames, and an attached HTML file is a snapshot. An https/mkcert embed is a possible add-on.
- **Stalls judged by signs of life, never by time alone,** and each one shows its evidence: a multi-hour build
  that still uses CPU or prints output is working.
- **The dashboard never writes into projects.** It computes status itself; a hook writing ticks into repos would
  leave uncommitted changes in projects the user wasn't touching. It writes only under `~/.claude/dashboard/`.
- **Its own work log as the primary tree source,** so it works without Plannotator; plans, BMAD tickets and Inbox
  checklists fill in work not yet started and work a session forgot to log.
- **Usage through a status-line tap,** because the status line's input is the only documented source of the
  5-hour and weekly limits (checked against the docs on 2026-11-18).
- **Its own look, not the setup guide's:** a tool kept open all day; chosen over several rounds of mockups.

## 31. The live dashboard, as built (2026-11-19)
Decision 30's design shipped as the opt-in Dashboard component: `global/dashboard/` (server, sampler, page,
work-log tool), `commands/dashboard.md`, `rules/dashboard.md`, a `SessionStart` and a `PostToolUse` hook, the
status-line wrap and a Start menu shortcut. `-Remove Dashboard` undoes the hooks, the wrap and the shortcut, and
like Rigor it is never removed by leaving it out of `-Components`. Where the build differs from the design, and why:
- **Commit-to-task matching is narrower.** The "only one unfinished plan" clause applies only when the repo has
  exactly one plan file, and a plan's add date comes from the commit that really added it. Only a commit's
  subject line is matched. Reviews kept reproducing wrong ticks from the broader history reconstruction, and the
  design's own priority is that a missed tick beats a wrong one. A repo with several plans ticks only when the
  subject names the plan or the session linked the plan; the rule text asks for that.
- **The original status line is saved in `~/.claude/dashboard/statusline-original.json`**, not in the manifest
  (the design said manifest). The whole object is kept, so removal restores it exactly.
- **Process sampling every 15 s, not 5 s, with a property-restricted query.** Stall thresholds are minutes, so a
  15 s CPU window is enough.
- **Project discovery:** live sessions plus projects with transcript activity in the last 7 days, because the
  folder names under `~/.claude/projects` can't be turned back into paths.
- **Stuck subagents count in the headline,** not only stuck sessions.
- **A heartbeat event every 5 s,** so "updated Ns ago" means "the server was last heard from", and the page says
  "Server not responding" after 60 s of silence.
- **Light-mode stuck red darkened.** The approved colour fell short of WCAG AA's text contrast.
- **A new `start` in the work log closes the session's unfinished task as not done** (doing goes back to next),
  rather than claiming it finished. A session running two tasks in parallel on purpose sees the first demoted.
- **A background job's end is read from Claude Code's own note that it finished,** or it looked stuck forever.
- **Child processes never run with a project as their working directory** (Windows searches it for executables
  first, so a planted binary would run), and git runs so that a repo's own settings can't start another program
  or point it at another repo.
- **BMAD status runs the project's own `_bmad/scripts/config_utils.py`** (through the bmad-ticket skill's
  script), the same trust the user's BMAD skills already give that project. Its result is reused for 5 minutes
  while the project's BMAD files are unchanged, because each run costs about a tenth of a second of CPU.
- **Stall CPU counts only what the pending tool started** (R22). Claude Code and its MCP servers keep a session's
  process tree busy even when nothing happens (measured 5% to 102% for idle sessions), so the whole tree could
  never read as quiet. With no tool pending, CPU isn't consulted: a busy session whose transcript has been quiet
  long enough looks stuck on that alone.
- **The status-line wrap runs the original command in the shell Claude Code used** (R23), bash under Git Bash,
  so a status line written for bash keeps working.
- **Subagents don't write the work log** (R24). They share their parent's session id, so a subagent starting an
  entry would close the parent's task, and parallel subagents would overwrite each other.
- **Plans are dated by their file when nothing else dates them, and commits are read over the whole history**
  (R25). Without a date a finished plan nobody ticked never folded away, and a 30-day window let commit-marked
  tasks fall back to "next". A plan file's date is when it last changed on this disk, so a fresh clone dates every
  plan to the clone. A work-log task left in progress by a session that has ended reads as next.
- **"Show all history" shows everything loaded** (R26): projects active in the last 7 days, with all their plans
  and commits. The design meant all history; projects quiet for longer than 7 days are not reachable from the
  page, because finding them means reading every old transcript. The control's tooltip says so.
- **A subagent quiet since before its parent's current Agent call reads idle** (R28, found in the live check). Its
  parent waits on a newer subagent, and every process the parent started since the old tool began would count as
  its CPU: one with a Bash call pending 4 days read Working.
- **The status-line wrap never takes Windows' `System32ash.exe` for Git Bash.** It is the WSL launcher, which
  fails without a Linux distribution.
- **A background job is recognised only from the start of a `run_in_background` call's result** (found in the live
  check). A command whose output quoted Claude Code's background message read as a job running for 12 hours.
  A job ended with `TaskStop` (or the older `KillShell`) gets no completion note, so a successful stop ends it;
  one stopped that way read as running for a day and a half.

Measurements, this PC, 2026-11-18/19 (one core = 100%):
- Process sampler: 2.32% at 5 s with the full query, 1.17% with the restricted query, 0.56% at 15 s.
- Server with four live sessions: 28.5% before throttling, 2.6% after a 2 s minimum gap between rebuilds and
  caches (a warm rebuild went from 385 ms to 19 ms). With the sampler, about 3.2% (summed, not measured together).
- The status-line tap adds a median 42.5 ms per refresh (20 runs).
- Reading a project's BMAD status takes 0.3 to 0.9 s.
- One API reply is often several transcript entries repeating the same usage (239 distinct requests over 505
  entries), so tokens are summed once per request.
- Live check after installing (2026-11-19): the server's first build took 3.4 to 3.8 s for 6 to 7 projects and 3 to
  4 live sessions. Started by the `SessionStart` hook of a headless `claude -p` session, it still answered after that
  session exited. The status line printed the same text through the tap, and plan usage was captured on its first
  refresh.

The owner approved the rule text and chose both ways for finished plans nobody marked: commits name the plan and
task, and a plan untouched for 7 days with no live session folds into "Done earlier". Folding is worked out on
every refresh, so a plan comes back when one of its tasks starts again. A one-off catch-up for projects older than
the dashboard is a follow-up.

Known limits: removal leaves the runtime files (`config.json`, `usage.json`, the work log) and doesn't stop a
running server (it stops itself after 30 minutes with no live session, or from the page's Stop). The shortcut stores the Node path
found at install time, so rerun the installer after switching Node versions. Usage numbers need a Pro, Max or
Ultra plan and appear after a session's first reply.

## 32. Older projects: a starting line at install, and `Status:` lines in the repo (2026-11-19)
Projects older than the dashboard had plans whose finished tasks were never ticked, so the page showed them as
work left: one project here had 82 plans with 2,086 unticked boxes. The owner leaves projects idle for months and
comes back, so old plans must not disappear for good. Task status also belongs in each repo, not in the
dashboard.

Considered:
- **Ticking every old box from git history.** Accurate, but Claude would have to read each plan's code, and the
  repo would get large diffs. Not built; ticking a project's plans by hand is still possible, and the rule covers it.
- **Keeping "still open" picks in a dashboard file.** Cheap, but that is task status stored outside the repo. The
  owner rejected it.
- **Chosen:** a starting line at install, plus an optional catch-up that writes `Status: done` or
  `Status: dropped` into old plans in the repo.

How it works:
- The installer writes `~/.claude/dashboard/installed.json` once, the first time Dashboard is installed. A
  reinstall keeps it.
- A plan added to its repo before that date (its git add date, or its file's creation time when it has no
  history), with no change since, folds under "Before the dashboard (N)" and leaves work left and Up next. The
  date only folds plans; it never marks anything done.
- The plan comes back by itself when any of these happens: some of its boxes are ticked but not all, one of its
  tasks starts or is linked to a live session, or the file changes. A checkout after the install also counts as a
  change; that is accepted.
- A `Status: done` line marks the whole plan finished. `Status: dropped` hides it outside "Show all history".
- `/dashboard catch-up` lists the candidates, and the person picks the plans still open. Claude writes
  `Status: open` into those and `Status: done` or `Status: dropped` into the rest. It stages only those plan
  files, commits them only after the person's yes, and never pushes.
- Before asking, Claude checks each plan against the repo (files, commits, ticked boxes) and shows one line of
  evidence per task, in batches of about ten. The owner asked for this after the first live run: tick counts and
  dates alone don't show whether a plan was done. It runs once per project, when asked; a plan with a `Status:`
  line is never listed again.
- A plan closed by the catch-up dates from its last change before the install, not from the catch-up commit.
  Otherwise every old plan would show as just finished for a week. The whole-branch review found this, along with
  the open plans staying folded. `Status:` must be followed by the word and then the end of the line, a dash or a
  full stop, so `Status: done (Tasks 1-3), Task 4 open` closes nothing.

The owner also settled:
- **Small tasks outside any plan get no record in the repo.** The work log is live activity, and the commit is
  the lasting record.
- **A repo's own commit-message format wins** over the rule's "plan name + Task N" subject, because the owner's
  work machine has repos shared with other people.
- **Seeing teammates' live work** (for example, GitHub Issues assigned to people) is a later build.

Live check on the owner's machine (2026-11-19, the install that wrote `installed.json`): Up next went from 503 to
82. In the project with 82 plans, 79 folded under "Before the dashboard" and work left went from 432 to 18; its 3
part-ticked plans stayed shown. In a project with 3 plans, 2 folded and work left went from 15 to 8. Projects
without superpowers plans were unchanged.

## 33. The Projects view groups each tree by state and opens only running work (2026-11-19)
On a large project the page scrolled on and on: every unfinished epic started open, and epics came in file-name
order (oldest plan first), so the running work could sit halfway down. The owner asked for the running work first
and everything else one click away.

Considered:
- **Sorting on the server.** The Sessions and Triage views read the same model and don't want project grouping,
  and the server would have to know how each person has the page folded. Not built.
- **A flat list with running work first.** Loses the plan → task structure that shows what is left. Not built.
- **A sort menu.** The owner floated it; the fixed order comes first, and a menu waits to see if it is missed.
- **Chosen:** grouping in the page (`groupEpics` in `render.mjs`), from the task states the page already shows.

How it works:
- Groups, in order: Running, Waiting on you, Next, Done; under "Show all history": Quiet for a week, Done earlier,
  Before the dashboard, dropped. An epic goes to the first that applies: any task working, stuck or gone →
  Running; any waiting → Waiting on you; unfinished → Next; else Done. Running wins over Waiting because both open
  by default and running work is the one that gets missed. Inside a group, the most recently touched comes first.
- "Done earlier" used to hold unfinished epics quiet for a week too, which called unfinished work done. Those now
  have their own row, "Quiet for a week". Work left is unchanged.
- Fold state stays in this browser (`dash-open`). A stored key means "the person set this"; anything else follows
  the default (Running and Waiting open, the rest folded). Expand all and Collapse all set keys for the project;
  Focus deletes them. Going to a task opens its group and epic.
- A project's tree is not rebuilt while the mouse is over it, so rows never move while being read; it catches up
  when the mouse leaves. Only the tree is held: the session blocks above it stay live (the whole-branch review
  found that holding the whole panel froze them). Projects keep their order while the mouse is over the grid,
  after the owner saw busy projects swapping places, and projects in the same state sort by name, not by
  latest activity (the owner's pick), so two busy projects never trade places. A change of state still moves one. The mouse is tracked by its last position, not `:hover`,
  which goes stale in Chrome once the node under a still mouse is swapped (measured: 9 rebuilds while "hovered").
  Renders the person causes (the fold buttons) apply at once.
- A task that is done is never shown as a session's current work, even if the session's last link points to it
  (the owner saw a finished catch-up task as "Working on").
- Hovering a session lights its task and every folded parent. A Key in the header explains the symbols; the hover
  pop-up starts with a cut-off label in full when its text doesn't already.

Live check on the owner's machine (2026-11-19): in the largest active project, the default view shows 79 rows
and Expand all shows 361. Collapse all leaves 6 group headers.

## 34. Session spend comes from the status line and is kept for a year (2026-11-19)
The owner wanted each session's spend, in dollars and tokens, on its card all the time, and kept after the
session ends ("a nice to know over time"). Tokens were only in the hover text and only for live sessions; dollars
were nowhere. Claude Code deletes transcripts after 30 days by default (`cleanupPeriodDays`).

Considered:
- **Dollars from tokens times a price table.** Works for any transcript, but the table goes stale and gives a
  second number that disagrees with Claude Code's own. Not built.
- **Chosen:** the status-line tap, which already reads Claude Code's status-line input for the usage limits, also
  records `cost.total_cost_usd` and the context-window token totals, one file per session under
  `~/.claude/dashboard/spend/<session id>.json`. The model reads them (re-reading only files that changed), and the
  server deletes files untouched for a year when it starts.

What the page shows:
- Each session card: `$1.24 · 3.1M tokens`, always visible. The note that the dollars are an API-price estimate
  that the plan may bill differently is in its tooltip only, at the owner's request.
- Each project header: `$X this week`; the tooltip has the all-time total and the number of sessions. Finished
  sessions count here, which is how spend is kept over time.

Tokens on a live session's card come from its transcript, not the status line: the live check found the status
line's context-window totals are not whole-session totals ($135 against 449k tokens). The project header shows
dollars only for the same reason.

Costs of this choice: a session whose status line never ran (a headless run) shows tokens only, from its
transcript. Spend is recorded only from when this tap was installed; earlier sessions have none.

## 35. Running means a session's current task; each task says what it is (2026-11-19)
Using the dashboard, the owner couldn't tell what was really active. One session had been linked to 262 tasks over
its life (7 still doing, 11 waiting), and its live line showed under every one of them. Hovers explained the tool
that was running, not what the task was. A titled session sat folded in the quiet list while working.
A checklist step marked "waiting" on Nov 17 by a session that never closed it still read as waiting on the owner.

Chosen (spec `docs/superpowers/specs/2026-11-19-dashboard-clarity-design.md`):
- **Running** holds only the task a live session is linked to now (`linkedTask`). Other open tasks go to a new,
  folded group, **Started, not current**. The live line and session chip show only under the current task.
- **Stale:** a doing or waiting task with no live session and no change for 24 hours reads "left open N days
  ago" under Started, not current, not as a wait. A live session's waiting step is still a real wait. An unknown
  change time is never stale.
- **About lines come from the agents**, not from a model inside the dashboard (no network, no API calls): the rule
  asks for `note.mjs start --about` and `--steps-about`. A plan task falls back to the first sentence of its own
  text; an Inbox step to the same session's work-log step with the same name, then to the thread's subject.
  Without one the hover says "No description yet" rather than guessing.
- **Sessions show their title**: the newest `custom-title`, else `ai-title`, from the transcript.
- **A folded project comes back** while it is stuck, waiting or working, if it became active after the fold.
  Folding it again while active wins.

How it was kept small:
- The server still reads a work-log task left doing by a closed session as `next` (so the headline counts and
  Triage don't change), and flags it `leftOpen` for the page.
- "Became active" is the time the server first saw the project active, held in memory. Costs of this choice: a
  server restart makes a folded active project come back once; tasks logged before this change have no about line.
- The rule also asks agents to close their Inbox checklists when work ends, so stale waits stop being made.

Changed after the first build (owner's ruling, same day): a session left open for days had moved on from older
work, and its old "waiting" steps still crowded Waiting on you. Now a live session whose current task is in another
epic counts as gone for that older epic's tasks: its waits read "left open" after a day, and work it began there
shows under Started, not current (a work-log epic superseded by a new `start` keeps its begun steps as `leftOpen`).
Later (2026-11-20, owner's report of the same task listed twice, once under Waiting on you): a superseded work-log
epic's waiting steps are `leftOpen` too. The session closed that entry by starting a new one, so nothing in it can
still be waiting on the owner.
A wait inside the epic the session is working on is still a real wait.

Review round (owner's review of the page, same day; spec `docs/superpowers/specs/2026-11-19-dashboard-review-fixes-design.md`):
- The group is now **Started, not active**.
- An Inbox step without its own line says "No description yet". The thread's subject moved to the epic's hover,
  because falling back to it made every step in a checklist show the same text.
- Commands are named by Claude's own description of the call (Claude Code's tools carry one: 1,025 of 1,131 shell
  calls in one session). The raw command moved to the session's hover. This applies to the card, the live line and
  stall evidence (decision 31's wording).
- Tokens show three significant figures (`1.04B`, not `1B`).
- The light/dark button names what Auto follows: "Auto (dark)".
- A quiet background job still reads "Looks stuck", which is the owner's choice. Its evidence now says it is
  still running and may be waiting on something outside, such as a CI run. The builder recommended that a
  background job never mark a session stuck, since it doesn't block the session; not built.

## 36. "Waiting on you" means any time Claude asks the owner; one row per Inbox thread (2026-11-19)
The owner, reviewing the page while this session was asking him questions in the Inbox: the session read "Idle".
"It's not just open inbox. It is anytime claude needs me. In the terminal too." Until now only Claude Code's own
`waiting` status counted, and that covers permission prompts only.

Chosen (spec `docs/superpowers/specs/2026-11-19-dashboard-needs-you-design.md`). A session reads Waiting on you
when any of these holds:
- **A terminal prompt:** Claude Code's status is `waiting`, as before.
- **A question in the terminal:** an `AskUserQuestion` call is pending, or the session is idle and its last
  message ends in a question mark with nothing after it.
- **An open Inbox question it asked:** read from Plannotator's `questions.jsonl`. Open means no answer, not
  withdrawn, not an action already done, and the thread not resolved.

The line under the session shows the question ("Inbox: …" or "Asked: …"). "Since" is when it was asked, so
Triage's escalation works unchanged. Stuck and gone still come first. A session that is busy working while an Inbox
question waits stays Working, and its hint names the question; Waiting on you is kept for sessions that have
stopped for the owner. Considered: relying on agents marking a step `waiting`. The rule asks for it, but this
session forgot, so it stays a backup signal.

Also:
- An Inbox thread shows as one row: the newest checklist wins, whichever session wrote it. Threads that share a
  name show the day they started ("· Nov 14"). Before, three identical rows appeared for two threads.
- The epic popup no longer shows the thread's subject. Agents write subjects as status notes, so it read as jargon.

## 37. Sessions watch their own long jobs; an end-of-turn check keeps the work log true (2026-11-20)
The owner: sessions should "check itself. Sort like a heartbeat check. Keeps our status up to date, and keeps the
agent on top of processes it launched with little cost", with no fixed timeout, since a job "may take 30 mins, may
take two hours". A session acts only when something wakes it, and a hung job never ends, so it never wakes anyone.

Chosen (spec `docs/superpowers/specs/2026-11-20-dashboard-heartbeat-design.md`), A + C:
- **A watcher beside each long job** (`dashboard/watch.mjs`, run in the background). It reads the job's output
  file, which costs no model tokens, and exits with one line after 15 minutes of silence or of the same lines
  repeating, when the job ended, or when the file is gone. Its exit wakes the session. A second quiet wake with no
  new output says so, and the rule then says act or ask, never re-arm, so a dead job can't loop. A marker in
  `~/.claude/dashboard/watch/` lets the page show "Watched" and the end-of-turn check see the job is covered.
  A watcher is never shown as what a session is doing: it prints nothing until it fires, so it would read stuck.
- **An end-of-turn check** (Stop hook `dashboard/tidy-hook.mjs`). When a session ends a turn with a step marked
  doing, nothing watched and no question to the owner, it asks the session once to fix its log. The same state is
  never reminded twice.

Costs, measured 2026-11-20 on a 155k-token session at Opus 5.5 list prices: one call about $0.05, a wake about
$0.15, about $1.25 after an hour asleep (the cache has to be written again). Rejected: a timer waking the session
every 20 minutes, about $0.90 per two-hour job even when all is well. Not covered: a session that dies takes its
watcher with it; the page already shows it as Gone.
