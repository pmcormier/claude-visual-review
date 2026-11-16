# claude-visual-review

A workflow setup for Claude Code. It makes Claude bring decisions, sign-offs, review findings and end-of-run
reports to the [Plannotator](https://plannotator.ai) Inbox, where you read, pick options and approve, instead
of as markdown in the terminal; your answer goes straight back to the session that asked. Review tabs open in
VS Code when you ask for one. Optionally it adds rules for picking a planning method per task (BMAD,
superpowers or plan mode), a review layer for BMAD workflows, and a final review of BMAD planning docs on the
Fable model.

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

It also sets `PLANNOTATOR_BROWSER` in `~/.claude/settings.json` (other settings are kept), checks that
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

## Make it yours

Put your own preferences in a rule file of your own, such as `~/.claude/rules/my-review-tweaks.md`. Claude
loads every file in `rules/`, and the installer never touches yours. Plannotator writes its own
`~/.claude/rules/plannotator-inbox.md`; this repo leaves it alone.

## Maintaining this repo

- `docs/decisions.md` records why each choice was made; `docs/superpowers/` holds designs and plans.
- `pwsh -NoProfile -File tests/run.ps1` runs the tests; they never touch the real `~/.claude`.
- `tools/check-personal.ps1` fails on personal data in tracked files (local paths, emails, artifact links, and
  terms from a list kept outside the repo). `./install.ps1 -Owner` installs every component and adds it as a
  pre-commit hook.

## Limits

- Windows only for now (Windows opener, PowerShell installer).
- BMAD's resolver has no global layer, so each BMAD project needs its own overrides (`-BmadProject`, or
  `python -I ~/.claude/bmad/write_overrides.py <project>` after `bmad setup`).
- Opening in a VS Code tab needs the Plannotator WebView extension and a session started in a VS Code
  terminal. Anywhere else, reviews open in the browser.

## License

MIT, see [LICENSE](LICENSE).
