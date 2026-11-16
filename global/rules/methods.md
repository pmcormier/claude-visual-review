# Planning methods and work tracking

Applies to every project on this machine. The method is picked per task (below); the rest of this file says
how each installed method runs once picked. BMAD and superpowers are what's installed today, not a closed
list: check what is actually installed before offering options, and treat a newly installed framework as a
candidate too.

## Picking the method
**Design before code.** For any feature, enhancement, or non-trivial bug fix, even a single-line change, do a
design step before writing code. Skipping it is the exception, not the default. If a task seems too small, ask
first: *"do you want to design this, or skip straight to a fix?"* The obligation is the design step, not any
particular tool.

**Ask which method, for every piece of work where there's a choice: per project and per task.** Offer what is
actually installed and usable here (today: BMAD and superpowers; check, since this changes), plus plan mode, or
"skip design, just fix" for small changes. Picking BMAD in a project without `_bmad/` starts with `bmad setup`
after I confirm. Mark a default as recommended: what the project's CLAUDE.md or AGENTS.md names, otherwise
BMAD. A default is a suggestion, never a decision. Ask once per task, then stay with the choice for that task.
This ask comes before any skill that says it must run first.

Superpowers injects its `using-superpowers` skill at every session start and after compaction, including a rule
to invoke skills before any response, even at a "1% chance". That text describes what superpowers offers; it
doesn't set the order of work here. The method question comes first; after that, use a superpowers skill when it
fits the task and the method I picked, as with any other framework's skills.

- **None installed:** use plan mode, or do the design step conversationally. A missing skill is never permission
  to skip straight to code.

## Work tracking
No single board is chosen yet. A project that names its own board in its CLAUDE.md keeps it. Otherwise, BMAD
projects track work with `bmad-ticket` on its git-backed store (`repo-ticketing`); it can switch the store to
GitHub Issues (`gh-ticketing`) later without re-slicing. Projects without BMAD keep the tracking they already
use; ask before introducing a new one.
- The session task list tracks steps within one session; it doesn't replace a ticket.
- Answer "what's next?" from the ticket store's ready list.
- Reference a ticket in commits with a neutral `Refs <KEY>` line, never `Fixes`/`Closes`: a closing reference
  marks work done before I've seen it.
- Close tickets yourself when the work is clearly done (final commit in, `Verify:` check passed) and say which
  ones you closed. Anything that needs my attention, such as a failing or skipped check, open review, or a
  judgment call, bring to me instead of deciding it.
- Superpowers' debugging, test-driven development, and verification skills stay available whatever method is
  picked.

## When BMAD is picked
- In a project without `_bmad/`, start with `bmad setup` once I confirm.
- After `bmad setup`, or in any BMAD project missing them, add the personal overrides (review policy, plus
  the Fable final review when it's installed): `python -I ~/.claude/bmad/write_overrides.py <root>`, or
  `./install.ps1 -BmadProject <root>` in your clone of claude-visual-review, which also checks them with BMAD's
  resolver. It never overwrites; to
  an existing planning-skill override that lacks the Fable line, it adds just that line. If `git status` shows
  the `*.user.toml` files, add `_bmad/custom/*.user.toml` to that repo's `.git/info/exclude`. Nothing is
  committed into the project, so a shared repo's teammates don't get these.
- Plan system-level work with `bmad-architecture` and `bmad-spec` (plus `bmad-prd` or `bmad-ux` when the work
  needs them), then slice it into tickets with `bmad-ticket`. When `bmad-spec` offers to hand off to
  `bmad-ticket`, accept.
- Size each ticket for one `bmad-build` session, name the spec capability IDs it covers when a spec exists, and
  end it with a `Verify:` line.
- Build each ticket with `bmad-build` in its own session, passing the ticket's reference. For that ticket,
  `bmad-build` replaces superpowers' planning and execution skills and feature-dev; don't mix them in.
  `bmad-build` stops at `built`; close the ticket afterwards as Work tracking says.
- Keep these sessions on the default workflow preset, because `bmad-build` runs its own review loop.
- `bmad-retrospective` closes out an epic.
- Interactive review: BMAD decision points follow `~/.claude/rules/visual-review.md` plus the BMAD layer
  `~/.claude/bmad/interactive-review.md`, loaded by the personal overrides.

## When superpowers is picked
- Follow its flow (brainstorming, writing-plans, then executing-plans or subagent-driven-development) and link
  the plan file from the ticket.

This file and `~/.claude/bmad/*` are installed from claude-visual-review. Edit them in your clone of
claude-visual-review, then run `./install.ps1`; it asks before replacing a copy in `~/.claude` that you changed.
