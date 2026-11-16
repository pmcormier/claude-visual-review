# CLAUDE.md: claude-visual-review

The source of truth for a Claude Code workflow setup: visual-first review with the Plannotator Inbox, the
planning-method rules, the BMAD layer and the Fable final review. `global/` mirrors `~/.claude`; BMAD projects
get personal overrides only. See `README.md` for what each file does and `docs/decisions.md` for why.

- This repo is public. Nothing personal goes in a tracked file: no local paths, emails, artifact links, or
  names of the maintainer's other projects or machines. `tools/check-personal.ps1` must pass before every
  commit; `./install.ps1 -Owner` installs it as a pre-commit hook. Examples use placeholders (`<project>`).
- Status, parked items and session notes live outside the repo, with the maintainer.
- `~/.claude` holds copies installed by `install.ps1`. Edit here, then run `./install.ps1`, never the copies.
- A choice someone would later ask "why?" about gets an entry in `docs/decisions.md` in the same change.
- Docs move with the files: a change to what is installed or how updates `README.md`, `docs/setup-guide.html`
  and `docs/setup-prompt.md` in the same commit.
- Tests: `pwsh -NoProfile -File tests/run.ps1`. They never touch the real `~/.claude`.
- Changes to the rule files go through the rules themselves: get the owner's sign-off (the Inbox, by default)
  before installing.
- Claude commits approved, verified work when it judges it prudent; the owner decides pushes.
