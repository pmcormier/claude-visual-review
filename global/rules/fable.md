# Fable final review

Applies in BMAD projects; installed as its own component of claude-visual-review.

- Fable final review: before any planning doc (spec, spine, PRD, UX, initiative, epics, change proposals, spike
  findings, research, forges) is set to final, approved, complete or hardened, run a Fable review very near the
  end of that effort, after the skill's own reviewer gate if it has one. For `bmad-ticket`, this applies when an
  initiative or epic is finalized or published. The personal overrides load the steps from
  `~/.claude/bmad/fable-final-review.md` for the 8 planning skills
  (`bmad-{architecture,spec,prd,ux,correct-course,ticket,forge-idea,deep-recon}`).
  1. Launch a read-only Agent (`model: fable`, `effort: high`). Give it the doc, its companions and its sources
     of truth. Tell it to invoke `bmad-review` (this counts as the explicit `skill:bmad-review` directive) with
     `also_consider` set to consistency with those sources, and to run every lens itself, without spawning
     subagents. It also applies the owning skill's validation checklist, read-only. It must not use any BMAD
     skill that writes.
  2. Check each finding against the source yourself and drop the ones that don't hold up.
  3. Show the owner only the confirmed findings, in plain English. The owner decides what gets fixed. Apply the
     agreed fixes, then set the status.
  Never skip this, including in headless runs. If Fable is unavailable, stop and tell the owner; don't switch to
  another model.
