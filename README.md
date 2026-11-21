# claude-visual-review

A workflow setup for Claude Code. It makes Claude bring decisions, sign-offs, review findings and end-of-run
reports to the [Plannotator](https://plannotator.ai) Inbox, where you read, pick options and approve, instead
of as markdown in the terminal; your answer goes straight back to the session that asked. Review tabs open in
VS Code when you ask for one. Optionally it adds rules for picking a planning method per task (BMAD,
superpowers or plan mode), a review layer for BMAD workflows, a final review of BMAD planning docs on the
Fable model, rigor rules that keep Claude from giving up a correct answer just because you push back, and a
live dashboard of all the Claude Code work on your computer.

The rules are written in the first person: "I", "me" and "the owner" mean whoever installed them.

## Install (Windows + VS Code)

Needs PowerShell 7, Claude Code, VS Code, git and Python; `uv` only for BMAD projects.

The easy way: paste [`docs/setup-prompt.md`](docs/setup-prompt.md) into Claude Code, and your agent does the
rest with you. By hand, follow [`docs/setup-guide.html`](docs/setup-guide.html), or:

```powershell
git clone https://github.com/pmcormier/claude-visual-review
cd claude-visual-review
./install.ps1 -InstallTools
```

The installer asks which components you want (or takes `-Components`):

| Component | Installs to `~/.claude` | What it does |
| --- | --- | --- |
| Review (always) | `rules/visual-review.md`, `visual-review/bin/open-in-vscode.exe` | When and how Claude uses the Inbox, review tabs and visuals; the opener that shows reviews as VS Code tabs (built from `global/visual-review/bin/open-in-vscode.cs` with the C# compiler that ships with Windows). |
| Methods | `rules/methods.md` | A design step before code, the planning method picked per task, work tracking, how BMAD and superpowers run. |
| Bmad | `bmad/interactive-review.md`, `bmad/write_overrides.py` | The review layer for BMAD workflows, and the script that writes personal (gitignored) overrides into a BMAD project. |
| Fable | `rules/fable.md`, `bmad/fable-final-review.md` | A final review on the Fable model before a BMAD planning doc is final. Needs access to Fable. |
| Rigor | `rules/rigor.md`, `rigor/pushback.md`, `hooks/pushback-check.mjs` | Verification rules (label claims verified, recalled or inferred; check premises; run the experiment), and a short pushback check that a `UserPromptSubmit` hook sends with every message, so Claude holds a correct position under pushback unless you bring new evidence. Needs Node.js. |
| Dashboard | `dashboard/` (server, page, work-log tool), `commands/dashboard.md`, `rules/dashboard.md` | Opt-in. A local page (`http://127.0.0.1:47800/` by default) showing every Claude Code session on the machine: what is moving, done and next, and what has quietly stopped, each stall with its evidence. A `SessionStart` hook starts its server, a `PostToolUse` hook notes plan files Claude touches, a `Stop` hook reminds a session once when its work log still says a step is in progress while nothing is running, and it wraps your status line to read the 5-hour and weekly usage limits and each session's spend (your original is saved and restored on removal). Each session card shows its spend in dollars and tokens, and each project its spend this week; the records are kept for a year under `~/.claude/dashboard/spend/`. Adds a Start menu shortcut and `/dashboard`. The rule also asks Claude to start `watch.mjs` beside any long background job: it costs nothing while the job prints and wakes the session after 15 minutes of silence, so a hung job is noticed by the session itself; the page marks such jobs "Watched". A compact view at `127.0.0.1:<port>/compact` shows one same-size square per active project, for a side pane or a second screen; a switch in the bar moves between the two views. A project glows briefly when it makes progress (its state changes, or a step or task starts or finishes). The rule asks Claude to log each task with `note.mjs`, with one plain-English line about it (`--about`) that the page shows when you hover the task. "Waiting on you" covers every time Claude asks you something: a terminal prompt, a question left in the terminal, or an open question in the Plannotator Inbox, until you send your answer; then the session shows "Your answer is on its way" until it picks it up. Running shows only what each session is on now; tasks begun earlier and left open sit under "Started, not active", marked "left open" after a day without change. Session cards show Claude Code's title for the session. Plans already in your repos when you install it fold under "Before the dashboard" until they show progress; `/dashboard catch-up` has Claude check a project's older plans against the repo, show the evidence, and mark them `Status: done`, `open` or `dropped` in the repo after you choose and approve. It writes only under `~/.claude/dashboard/`, never into your projects. Needs Node.js. |

It also sets `PLANNOTATOR_BROWSER` in `~/.claude/settings.json`, and with Rigor or Dashboard adds their hooks there (other
settings and hooks are kept), checks that
Plannotator, the `plannotator` and `visualizer` plugins, the Plannotator WebView extension and the Inbox's
Board and Steps capabilities are in place (`-InstallTools` installs what's missing), and with
`-BmadProject <project>` adds the BMAD overrides to your projects.

It's built to be run by an agent: every problem is a one-line `MISS` with its fix, nothing aborts the run,
and it ends with a **Summary** of what's left to do (exit 0: done; 3: installed, but see the Summary).
It never replaces a file in `~/.claude` you changed: it shows the difference and asks, or, when nobody can
answer (an agent running it), keeps yours and prints the command that replaces it (`-Replace <path>`). What
it wrote is recorded in `~/.claude/visual-review/installed.json`.

Then close every VS Code window, reopen VS Code and start a new Claude Code session in its terminal: terminals
inherit VS Code's environment from when it started, so a new terminal alone doesn't see a new PATH entry.

## Update

`git pull`, then run `./install.ps1` again: it reuses the components you installed last time (or pass
`-Components` to change them). Files you didn't change are updated quietly.

To turn Rigor or Dashboard off, run `./install.ps1 -Remove Rigor` or `-Remove Dashboard`: it removes the hooks
from `settings.json` and renames the component's files to `*.retired` (a file you changed stays, and the Summary
names it). Removing Dashboard also restores the status line it wrapped and deletes its Start menu shortcut.
Leaving either out of `-Components` doesn't remove it, so copying an example that lists fewer components can't
switch off the pushback check or unwrap your status line. Leaving out another component leaves its files in
place.

Dashboard extras: if something else rewrites your status line, the Summary says so and
`./install.ps1 -Replace statusLine` wraps it again. `-ShortcutDir <folder>` puts the Start menu shortcut
somewhere else. The shortcut stores the Node.js path found at install time, so rerun the installer after
switching Node versions.

## Make it yours

Put your own preferences in a rule file of your own, such as `~/.claude/rules/my-review-tweaks.md`. Claude
loads every file in `rules/`, and the installer never touches yours. Plannotator writes its own
`~/.claude/rules/plannotator-inbox.md`; this repo leaves it alone.

## Maintaining this repo

- `docs/decisions.md` records why each choice was made; `docs/superpowers/` holds designs and plans.
- `pwsh -NoProfile -File tests/run.ps1` runs the tests; they never touch the real `~/.claude`, and clean up
  their temp folders. They don't build the opener unless `CVR_TEST_BUILD=1`, because security tools quarantine
  new .exe files appearing in `%TEMP%`.
- `tools/check-personal.ps1` fails on personal data in tracked files (local paths, emails, artifact links, and
  terms from a list kept outside the repo). `./install.ps1 -Owner` installs every component and adds it as a
  pre-commit hook.

## Limits

- Windows only for now (Windows opener, PowerShell installer).
- BMAD's resolver has no global layer, so each BMAD project needs its own overrides (`-BmadProject`, or
  `python -I ~/.claude/bmad/write_overrides.py <project>` after `bmad setup`).
- Dashboard: usage numbers need a Pro, Max or Ultra plan and appear after a session's first reply. Removal
  leaves its runtime files in `~/.claude/dashboard/` (`config.json`, `usage.json`, `installed.json`, the work log) and doesn't stop
  a running server; the server stops itself after 30 minutes with no live session, or use Stop on the page.
- Opening in a VS Code tab needs the Plannotator WebView extension and a session started in a VS Code
  terminal. Anywhere else, reviews open in the browser.

## License

MIT, see [LICENSE](LICENSE).
