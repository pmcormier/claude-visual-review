# Design: a generic, shareable repo (2026-11-16)

Status: approved by the owner, 2026-11-16.

## Intent
The owner wants to share this setup (Plannotator Inbox plus visual review, optionally BMAD and superpowers) with
other people, and keep them current, without maintaining a second repo. Today the repo mixes the installable
setup with the owner's journal (project names, local paths, machine notes, session reviews), so it can't be
shared. This change makes the repo itself the shareable product: anyone can clone it, have their agent install
it, and `git pull` for updates. The owner keeps using it exactly as before.

## Goals
- A newcomer on Windows + VS Code goes from no Plannotator to a working setup by giving their Claude Code agent
  one prompt (`docs/setup-prompt.md`). The agent clones the repo, installs the tools from their official
  sources, and runs the installer.
- Components are opt-in: the visual-review layer (always), `methods.md`, the BMAD layer, the Fable final review.
  superpowers and BMAD themselves are offered, not assumed.
- The installer never overwrites a file in `~/.claude` that differs from what it would write without asking.
- Nothing personal is tracked, now or in history; a check keeps it that way.
- The owner's machines still install everything with one command.

## Non-goals
- Supporting Mac or Linux. The opener stays Windows-only; the prompt says so.
- Making the rules configurable to other people's taste. They stay the owner's opinions. A recipient who wants
  different behaviour adds their own rule file in `~/.claude/rules/`, which the installer never touches.
- Copying Plannotator's, BMAD's or superpowers' install instructions. The prompt points at their official docs.

## Anti-goals (a failure even if it works)
- The owner's rules get watered down or grow switches to suit someone else.
- A recipient's existing `~/.claude` files are silently replaced.
- Personal data reaches the public repo, including through the check's own list of terms.
- The owner loses their journal: status, decisions' context, past review pages.

## Approaches considered
1. **Give the recipient access to the repo as it is.** Nothing to build; exposes the journal and history.
2. **Paste the files into a generated prompt.** No repo access needed; the prompt is a second copy that goes
   stale and has to replicate the installer's checks in prose.
3. **A script-published public copy** (fresh commit of `global/`, installer, guide). Nothing personal leaves;
   a second repo on GitHub and a publish step after every change.
4. **Restructure this repo to be generic (picked).** One repo, `git pull` for updates, no publish step. Costs a
   one-time history reset and the discipline to keep commits generic. The owner picked it because they don't
   want two repos.

## Decisions
- **Visibility: public** (Claude's call; the owner didn't say). The check is strict enough for public, so a
  private share is covered too.
- **The journal moves to the owner's vault**, in its existing project folder: the status, parked items and
  dated notes from `CLAUDE.md`, all of `docs/review/`, and the personal context in `decisions.md`.
  `CLAUDE.md` keeps only the working rules. `decisions.md` stays, rewritten without project names, machine
  notes or local paths, so the reasoning is still there for the people who share it.
- **Installer components.** `install.ps1` asks which components to install (or takes them as a parameter),
  and before overwriting a differing file shows what changes and asks. The owner's machines use a parameter
  that selects everything and skips the questions for files this repo installed before. Examples in the
  installer and docs use placeholder paths.
- **`methods.md` lines that point at this repo** say "your clone of this repo" instead of a fixed path.
- **Fable** is installed only when chosen; the prompt tells the agent to ask whether the user has Fable access.
- **Setup prompt** (`docs/setup-prompt.md`): what to paste to an agent. It clones the repo, installs
  Plannotator, the plannotator and visualizer plugins and the WebView extension, offers superpowers and BMAD,
  runs the installer with the chosen components, then walks the manual steps the installer can't do (restart
  VS Code, Inbox Board and Steps capabilities, "Always allow" for VS Code links) and the checks from the setup
  guide. Re-running it on an installed machine updates: `git pull`, then the installer.
- **Setup guide** (`docs/setup-guide.html`) becomes generic too: the public clone URL, placeholder paths. The
  owner's published artifact is republished from it.
- **Personal-data check.** A script in `tools/` fails when a tracked file matches a term list. The list lives
  outside the repo (in `~/.claude/visual-review/`), so the terms themselves are never published; with no list,
  the check still blocks generic patterns (absolute drive paths, email addresses, claude.ai artifact links).
  The owner installs it as a pre-commit hook on their machines.
- **History reset (owner's choice, 2026-11-16).** Before anything is pushed: the old history is saved as a git
  bundle in the vault. Then the GitHub repo is deleted and created again under the same name (the owner runs
  `gh repo create`, since auto mode blocks it), and one new root commit is pushed. A force-push was rejected
  because GitHub can still serve force-pushed commits by ID. The owner confirms the deletion separately, right
  before it runs. Every existing clone is replaced by a fresh one afterwards.
- **License (owner's choice):** MIT.
- **The repo goes public last**, after the check passes on the new root commit and the owner has read the result.

## Claude's calls after the builder check (the owner can override)
- **Commit identity:** the GitHub noreply address already used on every commit. The public clone URL names the
  owner's GitHub account; that is public by nature and allowlisted by the check.
- **What "installed before" means:** a manifest in `~/.claude/visual-review/installed.json` records the hash of
  each file the installer wrote. A file still matching its recorded hash updates silently; a file that differs
  (the user edited it, or it existed before) is shown and asked about. A skipped file is reported as such, with
  the component it leaves partly inactive. `settings.json` is merged (one key), never replaced, and the change
  is announced. `rules/bmad.md` is retired only if the manifest shows this repo installed it. The owner's
  parameter bootstraps the manifest from the files in place on its first run.
- **The check's term list:** seeded by Claude from the terms in today's journal, kept in
  `~/.claude/visual-review/personal-terms.txt`, and created before the history reset so the check runs on the
  new root commit. The owner's parameter installs the pre-commit hook; recipients get neither. Examples in
  tracked files use placeholders (`<repo>`, `<project>`) instead of real paths; the only allowlisted match is
  the repo's own GitHub URL.
- **The rules ship unchanged.** "The owner" reads as whoever installed them; the README says so. The owner's
  machines and recipients run byte-identical rule files.
- **`docs/superpowers/` ships** (this design and its plan), since it passes the check and records the why.

## Left to the builder
- How the installer asks (prompt per component, a parameter, or both) and how it shows a differing file.
- The exact current install commands for BMAD and superpowers, from their official docs at build time.
- How the owner's machines record what was installed before (so updates don't ask every time).
- Wording of the setup prompt, as long as it covers the steps above.
- A `decisions.md` entry for this change (the repo's own rule).
