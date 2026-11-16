# Interactive review in BMAD workflows (owner's policy)

The general rules live in `~/.claude/rules/visual-review.md`: the Plannotator Inbox as the default, review tabs
on request, choices, visuals, acting on feedback, fallback. Follow them in this workflow. This file adds what is
specific to BMAD. Neither file changes what the workflow does, its steps, its templates or its output
documents. Headless, `-H`, autonomous and skill-invoked runs (no person watching) skip both and keep BMAD's
normal behaviour, apart from the end-of-run report, and so does a run inside a subagent or teammate: it reports
its decision points to the session that started it.

## Decision points in BMAD

Real decision points only. Quick confirmations ("continue?", a one-word answer) and conversational
discovery stay in the terminal. A step's own approval menu (for example `bmad-build`'s plan approval) is a
decision point: send the document it asks about to the Inbox as a sign-off, with the menu's options as a
`:::question`, not an `AskUserQuestion`.

1. **A document ready for review or sign-off** (a draft, finalize, a validation report, a change proposal,
   a ticket slicing, a retrospective decision): an Inbox sign-off. When BMAD has already produced HTML for
   it (a validation report, a deep-recon briefing, UX mockups), attach that HTML in the same message as the
   markdown document.
2. **Code**: review findings as a `:::question-multi` asking which to fix. The diff itself goes out as a guided
   walkthrough only when the global rule says a code review is due (asked for, or judged prudent); otherwise
   the step offers it in one line.
3. **A choice between alternatives** (architecture options, scope cuts, requirement trade-offs, workflow
   variants, design directions): `:::question` blocks, one per decision. Visual options (layouts, themes,
   screen directions) are picture choices.
4. **Structure that reads better as a picture** (components and boundaries, a workflow or state flow,
   requirement-to-feature traceability, a change's impact, an epic/story map): a Mermaid or Graphviz diagram,
   or a self-contained HTML page, in the same message as the document it explains.

The override that loads this file also names the decision points for that workflow.

## BMAD specifics

- **Where visuals live.** In the run's workspace under `.working/review/`, or beside the document when the
  workflow has no workspace. BMAD's markdown documents stay the source of truth.
- **Approval boundaries.** An Approve answers the one question the BMAD step asked, and nothing more. It never
  stretches to a later step or to a status the step didn't ask about (for example, approving a story's code
  doesn't mark the ticket done).
- **Record it.** If the workflow keeps a memlog, note what was decided, the reason, and where.
- **Fable final review.** Send the confirmed findings to the Inbox as a `:::question-multi` ("Which of these
  should I fix?"), then apply the chosen ones.
