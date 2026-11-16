# Shareable Repo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make this repo generic and public, so anyone's agent can clone it and install the setup with opt-in
components, while the owner keeps one-command installs and the journal moves to the owner's vault.

**Architecture:** `install.ps1` gains components, a hash manifest and conflict handling; a personal-data check
guards every commit; the journal leaves the repo; docs become generic; the GitHub repo is recreated with one
fresh root commit.

**Tech Stack:** PowerShell 7, Python 3 (`-I`), git, gh, Plannotator CLI.

**Spec:** `docs/superpowers/specs/2026-11-16-shareable-repo-design.md`

## Global Constraints

- Windows + VS Code only; installer needs PowerShell 7 (`#Requires -Version 7`).
- Rule text ships unchanged except the edits this plan names (methods.md repo references, the Fable split).
  The owner's machines and recipients get byte-identical rule files.
- The installer never overwrites a file in the Claude home that differs from what it would write without
  asking; non-interactive sessions never block on a prompt.
- Nothing personal in any tracked file: no local drive paths, no email addresses, no claude.ai artifact links,
  no term from the owner's term list. Examples use placeholders (`<repo>`, `<project>`, `<vault>`).
- The term list lives at `~/.claude/visual-review/personal-terms.txt`, never in the repo. The owner's GitHub
  username is public and stays out of the list, so the repo's clone URL passes without an allowlist.
- Python runs with `-I`. Tests never touch the real `~/.claude`.
- Commit messages end with the repo's attribution line; no pushes until Task 7.

## Review Focus

1. A recipient whose agent runs the installer non-interactively, with an existing differing `methods.md`: it must
   skip that file, print the diff and the rerun command, report Methods as partly inactive, and exit without
   hanging. (Task 3 test `NonInteractiveConflictSkips`.)
2. The owner's machine on its first run after this change (no manifest, files in place, `-Owner`): no prompts,
   manifest bootstrapped; a later local edit to an installed rule is then asked about, not overwritten.
   (Task 3 tests `OwnerBootstrap`, `EditAfterInstallIsAsked`.)
3. Re-running with nothing changed: no prompts, every file "ok", manifest unchanged. (Task 3 `RerunIsQuiet`.)
4. `settings.json` absent, or holding other `env` keys and top-level settings: all preserved, only
   `PLANNOTATOR_BROWSER` set. (Task 3 `SettingsMerged`.)
5. A BMAD project installed without the Fable component gets no Fable line; with it, gets one.
   (Task 2 `NoFableWithoutComponent`.)

---

### Task 1: Personal-data check and term list

**Files:**
- Create: `tools/check-personal.ps1`
- Create: `tests/check-personal.tests.ps1`, `tests/lib.ps1` (shared `Assert-Equal`, `Assert-True`,
  `New-TempDir` helpers), `tests/run.ps1` (runs every `tests/*.tests.ps1`, exits non-zero on any failure)
- Create outside the repo: `~/.claude/visual-review/personal-terms.txt`

**Interfaces:**
- Produces: `tools/check-personal.ps1 [-Root <path>] [-TermsFile <path>] [-Staged]` → prints
  `path:line: <rule>` per hit, exit 1 on any hit, 0 otherwise. Default `-Root` is the repo, default
  `-TermsFile` is `~/.claude/visual-review/personal-terms.txt` (missing file: generic rules only).
  `-Staged` checks the index content (`git show :<path>`) of staged files; otherwise all `git ls-files`.
  Rules: `drive-path` (`\b[A-Za-z]:\\`), `email` (RFC-ish `\S+@\S+\.\w+`), `artifact-link`
  (`claude\.ai/(code/)?artifact/`), `term:<n>` (case-insensitive literal, one per non-blank, non-`#` line).
  Binary files skipped. The hit names the rule, never echoes the term itself (`term:3`), so CI logs don't leak it.

- [ ] **Step 1: Write the failing tests** in `tests/check-personal.tests.ps1`, each in a temp git repo:
  `CleanRepoPasses` (exit 0), `DrivePathFails` (file `a.md` with "see " plus a drive letter, colon, backslash, `x` → exit 1, output contains
  `a.md:1: drive-path`), `EmailFails`, `ArtifactLinkFails`, `TermFails` (terms file `secretproject`, file
  `x.md` line 2 `SecretProject here` → `x.md:2: term:1`, output does not contain `secretproject`),
  `StagedChecksIndexNotWorktree` (staged clean, worktree dirty → exit 0 with `-Staged`), `GithubUrlPasses`
  (`https://github.com/someone/repo` → exit 0).
- [ ] **Step 2: Run** `pwsh -NoProfile -File tests/run.ps1` → FAIL (script missing).
- [ ] **Step 3: Implement** `tools/check-personal.ps1` per the interface.
- [ ] **Step 4: Run** `pwsh -NoProfile -File tests/run.ps1` → PASS.
- [ ] **Step 5: Seed the term list.** Write `~/.claude/visual-review/personal-terms.txt` with every personal
  term in today's journal: the owner's full name, email, every other project's name named in `CLAUDE.md`,
  `docs/decisions.md` and `docs/review/`, the vault folder name, machine-specific notes' keywords. Not the
  GitHub username. Run `pwsh -File tools/check-personal.ps1` and save the hit list to the scratchpad as the
  baseline for Tasks 4 and 5 (expected: many hits).
- [ ] **Step 6: Commit** `tools/`, `tests/` ("Personal-data check for tracked files").

### Task 2: Fable becomes its own component; methods.md stops pointing at this clone

**Files:**
- Create: `global/rules/fable.md`: the "Fable final review" bullet moved verbatim out of `methods.md`
  (lines 64-78), under a heading.
- Modify: `global/rules/methods.md`: remove that bullet; line 46-50 says "add the personal overrides
  (review policy, plus the Fable final review when it's installed)"; the closing paragraph (line 86) says
  "Edit them in your clone of claude-visual-review, then run `./install.ps1`".
- Modify: `global/bmad/write_overrides.py`: add the Fable entry only when
  `~/.claude/bmad/fable-final-review.md` exists; docstring says so.
- Create: `tests/write-overrides.tests.ps1`

**Interfaces:**
- Produces: component file sets used by Task 3: Fable = `rules/fable.md`, `bmad/fable-final-review.md`.

- [ ] **Step 1: Write the failing tests:** run `python -I global/bmad/write_overrides.py <tmp project>` with
  `USERPROFILE`/`HOME` set to a temp home. `NoFableWithoutComponent`: temp home lacks
  `.claude/bmad/fable-final-review.md` → no override file contains `fable-final-review`. `FableWithComponent`:
  file present → `bmad-prd.user.toml` contains it. `ExistingOverrideGainsFableLineOnce` (rerun → one line).
- [ ] **Step 2: Run** `tests/run.ps1` → `NoFableWithoutComponent` FAILS.
- [ ] **Step 3: Implement** the existence check, and move the Fable text.
- [ ] **Step 4: Run** `tests/run.ps1` → PASS. Diff check: `git diff global/rules` shows only the moved bullet
  and the two reworded passages.
- [ ] **Step 5: Commit** ("Fable final review as its own component; methods.md names no local clone").

### Task 3: Installer components, manifest and conflicts

**Files:**
- Modify: `install.ps1`
- Create: `tests/install.tests.ps1`

**Interfaces:**
- Consumes: Task 2's Fable file set; Task 1's check script (for the hook).
- Produces: `install.ps1 [-Components Review,Methods,Bmad,Fable] [-Owner] [-OnConflict Ask|Skip|Replace]
  [-Replace <relpath[]>] [-InstallTools] [-BmadProject <path[]>] [-ClaudeHome <path>] [-SkipToolCheck]`
  - Component map (paths relative to `global/`): Review = `rules/visual-review.md`,
    `visual-review/bin/open-in-vscode.cs`; Methods = `rules/methods.md`; Bmad = `bmad/interactive-review.md`,
    `bmad/write_overrides.py`; Fable = `rules/fable.md`, `bmad/fable-final-review.md`. Review is always on.
  - No `-Components` and no `-Owner`: interactive → ask per optional component; non-interactive → stop with
    the list of components and an example command (exit 2).
  - `-Owner` = all components, `-OnConflict Ask`, bootstraps a missing manifest by treating files in place as
    installed, installs `.git/hooks/pre-commit` (calls `pwsh -NoProfile -File tools/check-personal.ps1 -Staged`).
  - Manifest `<ClaudeHome>/visual-review/installed.json`: `{ "<relpath>": "<sha256 of installed file>" }`
    (the `.exe` path for the opener; build into a temp file and compare its hash).
  - Per file: absent → write; equals source → ok; equals manifest hash → update; else conflict. Conflict with
    `-Replace` naming it or `-OnConflict Replace` → back up as `.bak`, write; `Ask` interactive → show
    `git diff --no-index`, ask y/n; `Ask` non-interactive or `Skip` → keep, print diff and
    `./install.ps1 ... -Replace <relpath>`, report "<Component> partly inactive". Manifest records only files
    the installer wrote or found identical.
  - `rules/bmad.md` retired only when the manifest lists it or `-Owner`.
  - `-ClaudeHome` defaults to `~/.claude`; `-SkipToolCheck` skips the Tools step (tests only).
  - `.EXAMPLE` lines use `<project>` placeholders.

- [ ] **Step 1: Write the failing tests** (temp ClaudeHome, `-SkipToolCheck`, opener build allowed):
  `FreshInstallReviewOnly` (only Review files + manifest), `NonInteractiveNoComponentsExits2`,
  `NonInteractiveConflictSkips` (pre-existing differing `rules/methods.md`, `-Components Review,Methods`
  run with stdin redirected → file unchanged, output has `-Replace rules/methods.md` and
  `Methods partly inactive`, exit 0), `ReplaceFlagReplaces` (same, `-Replace rules/methods.md` → replaced,
  `.bak` exists), `RerunIsQuiet`, `UpdateOfUntouchedFile` (manifest hash matches, source changed → updated
  without prompt), `EditAfterInstallIsAsked` (edit installed file, rerun non-interactive → skipped),
  `OwnerBootstrap` (files in place, no manifest, `-Owner` → no conflicts, manifest written),
  `SettingsMerged` (existing `settings.json` with `env.FOO` and `model` → both kept, `PLANNOTATOR_BROWSER` set),
  `BmadRetiredOnlyWhenOurs`.
- [ ] **Step 2: Run** `tests/run.ps1` → FAIL.
- [ ] **Step 3: Implement** per the interface.
- [ ] **Step 4: Run** `tests/run.ps1` → PASS.
- [ ] **Step 5: Commit** ("Installer: opt-in components, manifest, never overwrites a changed file").

### Task 4: Move the journal to the vault

**Files:**
- Create in `<vault>/projects/claude-visual-review/`: `status.md` (the `## Status` section, parked items,
  open items, next steps and the setup-guide artifact URL from `CLAUDE.md`), `review/` (all of `docs/review/`),
  `decisions-journal.md` (today's `docs/decisions.md`, verbatim).
- Modify: `CLAUDE.md`: keep the working rules; add "Status, parked items and the journal live outside the
  repo, with the maintainer" and "`tools/check-personal.ps1` must pass before every commit"; no artifact URL.
- Modify: `docs/decisions.md`: same decisions and reasoning, without project names, machine notes, paths or
  dates of personal events; "the owner" stays.
- Delete: `docs/review/`

- [ ] **Step 1:** Copy the three items to the vault; verify each copy byte-for-byte (`Get-FileHash`).
- [ ] **Step 2:** Rewrite `CLAUDE.md` and `docs/decisions.md`; delete `docs/review/`.
- [ ] **Step 3: Verify** `pwsh -File tools/check-personal.ps1` → no hits in `CLAUDE.md`, `docs/decisions.md`.
- [ ] **Step 4: Commit** ("Journal moves to the maintainer's vault").

### Task 5: Public docs

**Files:**
- Create: `LICENSE` (MIT, `Copyright (c) 2026 pmcormier`), `docs/setup-prompt.md`
- Modify: `README.md`, `docs/setup-guide.html`, `docs/decisions.md` (entries 24 and 25)

**Interfaces:**
- Consumes: Task 3's installer interface (the prompt and guide show its real flags).

- [ ] **Step 1:** `README.md`: what it is for anyone; "the owner" means whoever installed it; public clone
  URL; `./install.ps1 -InstallTools` with the component question; `-Owner` described for maintainers; how
  to keep personal tweaks in your own rule file; updating = `git pull` + rerun; `<project>` placeholders.
- [ ] **Step 2:** `docs/setup-prompt.md`: a prompt to paste into Claude Code that has the agent (1) check
  Windows, PowerShell 7, VS Code, git, Python; (2) ask which components and whether the user has Fable access;
  (3) offer superpowers and BMAD, installing each from its official docs (look them up, don't guess);
  (4) clone to a folder the user picks, run `install.ps1 -InstallTools -Components ...`; (5) for each skipped
  conflict, show the diff and ask, then rerun with `-Replace`; (6) tell the user to restart VS Code, turn on
  Inbox Board and Steps, allow VS Code links; (7) run the setup guide's three checks; (8) say how to update.
  Plannotator's own `plannotator-inbox.md` is never touched.
- [ ] **Step 3:** `docs/setup-guide.html`: same flow for a human; public URL; no username sign-in step;
  placeholders; points to `setup-prompt.md` as the agent route.
- [ ] **Step 4:** `docs/decisions.md`: 24 "A generic, shareable repo" (approaches, why restructure, history
  recreated, MIT); 25 "Fable is its own component" (why the bullet moved out of `methods.md`).
- [ ] **Step 5: Verify** `pwsh -File tools/check-personal.ps1` → exit 0 on the whole repo;
  `tests/run.ps1` → PASS.
- [ ] **Step 6: Commit** ("Public docs: README, setup prompt, setup guide, MIT license").

### Task 6: Install on the owner's machine

- [ ] **Step 1: Run** `./install.ps1 -Owner -InstallTools` → every line `ok`, no conflicts (bootstrap).
- [ ] **Step 2: Verify** each installed rule file's hash equals its `global/` source; `installed.json`
  exists; `.git/hooks/pre-commit` exists, and a test commit of a file containing a drive path is refused (then
  reset it).
- [ ] **Step 3: Verify** a new Claude Code session loads `rules/fable.md` and `rules/methods.md` (ask it which
  rule files it sees).

### Task 7: Recreate the GitHub repo with one fresh commit

Owner-in-the-loop; each command marked (owner) is theirs, sent as an Inbox action.

- [ ] **Step 1:** `git bundle create <vault>/projects/claude-visual-review/history-2026-11-16.bundle --all`;
  `git bundle verify` → "okay".
- [ ] **Step 2:** `git checkout --orphan fresh`, `git add -A`, commit "claude-visual-review: shareable setup
  for Plannotator visual review", `git branch -D main`, `git branch -m main`; `git log --oneline` → 1 commit;
  `tools/check-personal.ps1` → exit 0.
- [ ] **Step 3 (owner):** confirm, then `gh repo delete pmcormier/claude-visual-review --yes` and
  `gh repo create pmcormier/claude-visual-review --private --source . --push`.
- [ ] **Step 4: Verify** clone the remote into the scratchpad; check passes there; one commit; author is the
  noreply address.
- [ ] **Step 5 (owner):** read the Step 4 result, then `gh repo edit pmcormier/claude-visual-review
  --visibility public --accept-visibility-change-consequences`.
- [ ] **Step 6:** republish the setup guide artifact from `docs/setup-guide.html` (its URL is in the vault's
  `status.md`); tell the owner every other install needs a fresh clone and `./install.ps1 -Owner`.
- [ ] **Step 7:** update the memory note that says the repo is private, if any; end-of-run report to the Inbox.
