# Visual-first review and decisions

Applies in every project and every workflow: plain sessions, superpowers, BMAD, plugins. When I need to inspect,
evaluate, compare, approve, reject or decide something, show it to me in Plannotator, not as markdown in the
terminal. The Plannotator Inbox is the default; a review tab opens only when I ask for one. These rules decide how
a decision point is shown, never what a workflow does: its steps, templates, documents and approval boundaries
stay as they are.

## When

- **Use it for:** a plan, spec or document up for my sign-off; review findings I choose from; a choice
  between alternatives; anything that reads better as a picture (architecture, flows, dependencies,
  comparisons, numbers).
- **Menus count when choosing needs context.** If deciding takes more than the options themselves (a plan to
  read, what each option costs, trade-offs), send it to the Inbox even where a skill or habit would ask with
  `AskUserQuestion` or a numbered menu: its options become the `:::question` options, and the context goes in
  the message, not the terminal. A pick whose options speak for themselves stays an `AskUserQuestion`.
- **Code review only when it's due:** send a diff for review when I ask, or when you judge it prudent (a
  risky, wide or hard-to-undo change) and say why in one line. Otherwise, at a natural feedback point (work
  finished, before a commit), offer it in one line and don't send it.
- **Keep in the terminal:** progress, commands, build and test results, debugging, short answers, quick
  confirmations, and questions with one obvious answer.
- **Unattended runs** (headless, no one watching) ask nothing that blocks them; their end-of-run report goes to
  the Inbox (below).
- **Only the session I talk to asks me.** A subagent, teammate or background agent never messages me or opens a
  review: it hands the material and the question back to the session that started it, which decides.

## The Inbox (the default)

Use the `plannotator_inbox` tool (`send_message`); without it, `plannotator inbox call send_message`.

- **A sign-off** (a plan, spec, document, diagram or rule change you can't go on without): attach the files
  (`attachments`; several go in one message) and ask one `:::question` with the choices `Approve` and
  `Change`, plus `Stopped:` saying what waits. End your turn; my reply comes back to this session by itself.
- **Code, when a review is due:** a guided walkthrough of the diff (`get_guide_brief`, then `submit_guide`),
  then the sign-off question in the same thread.
- **Choices and findings:** `:::question` blocks (`:::question-multi` for findings to fix), one per decision:
  the question, a line or two of context, the choices, and `Recommended:`. Visual options are picture choices.
- **End-of-run reports.** When an unattended or long run ends, send one message: what changed, what went
  right, what went wrong, what is blocked, steps completed, next steps, and open questions as `:::question`
  blocks. When files changed, add a chart of lines changed by area (from `git diff --numstat`; say that size
  isn't importance). A guided walkthrough of the diff is optional: send it when the changes are important or
  risky; otherwise offer it in one line, and send it whenever I ask.
- **Files changed, so I can explore.** Any Inbox report on work that changed files, in any project, opens with
  a **Files changed** header: a plain Markdown list grouped by area, naming the two or three files worth opening
  in each, with one line on what changed and *why*, and a count for the rest. Every file is a
  `vscode://file/<absolute path>:<line>` link (plain paths don't open; links in raw HTML or `html` blocks are
  blocked). When the session isn't in VS Code's terminal (`TERM_PROGRAM` isn't `vscode`), also attach the
  highlighted files, which open in the Inbox with line comments; the links stay and start VS Code when clicked.
  Attach the diff as a `.patch` (`git diff`), which the Inbox shows coloured, and end with a
  `:::question` offering a guided walkthrough. Under ten changed lines, one line instead of the header. A
  background agent writes the header and patch (`model: sonnet`, `effort: medium`, as I ask here), from the
  diff plus a short note of each area's intent from the main session, and hands them back; the report waits for it.
- **While the work runs.** Work that outlasts a reply gets a Board card, kept current as it moves (started,
  handed over, done). Multi-step work we agreed on, and next steps (below), get a checklist in its thread
  (`steps`), updated as each step starts and ends. Neither notifies me; the end-of-run report is the one message.
- **Next steps live in the thread.** When you give me next steps or what waits on me, and the work has an Inbox
  thread or will outlast this reply, put them in that thread (start one if needed) with a `steps` checklist kept
  current. The chat then gives a one-line pointer to the thread, not a second copy.
- **Make the weight visible.** A message with no question is for information. Add `Stopped:` to a question
  only when you truly can't go on, and `Holds up:` naming the work that waits when you can; otherwise neither.
- **Keep it tidy.** One thread per work stream. Withdraw your own questions once they no longer apply
  (`supersedes`), and resolve a thread you own when nothing in it is left for me.
- **Opening it.** The Inbox won't load in the Plannotator WebView extension (it forbids framing). Give me the
  thread's link; Ctrl-click opens it in VS Code's built-in browser.

## Other surfaces

- **A plan from plan mode:** Plannotator's hook opens it in a tab by itself when plan mode ends. Do nothing extra.
- **A review tab, when I ask for one:** the `plannotator` tool (`action: "annotate"` or `"review"`,
  `gate: true`), then end the turn and wait for the decision message; without the tool, `plannotator annotate
  <files…> --gate --json` or `plannotator review --gate --json` in the background with `timeout: 7200000`. Never
  kill a session to move on; if one times out, run it again (drafts restore). Title it `<project> · <subject> ·
  <session>`, where `<session>` is the first 8 characters of `$CLAUDE_CODE_SESSION_ID`.
- **A visual tool a workflow already has** (superpowers brainstorming's visual companion, BMAD's HTML outputs):
  use it. Accept the visual companion when brainstorming offers it. Visualizer when I ask for it.
- **Nothing fits:** a self-contained HTML page (inline CSS and JS, no network), attached in the Inbox. Never a
  custom review app.
- **VS Code tabs.** `PLANNOTATOR_BROWSER` points at `~/.claude/visual-review/bin/open-in-vscode.exe`, which
  hands the URL to the Plannotator WebView extension and falls back to the browser outside VS Code. Open any
  other review page with the same program.

## How

- **Say it in one place.** When something goes to the Inbox or a review, the terminal gives only where it is
  (the thread's link or the review's title), what I need to do, and anything that isn't there, under the heading
  **Not in the Inbox** (or **Not in the review**). Never restate its content in the terminal. If nothing is
  unique, the message is one line.
- **Visuals are welcome.** Add a picture whenever it would help me understand or decide faster: charts and
  graphs for numbers (load the `dataviz` skill), diagrams for structure and flow (Mermaid or Graphviz),
  mockups for anything visual, side-by-side views for alternatives. They are not required; skip them where a
  picture would only decorate. Draw from real data, never invented figures, and label units.
- **Sources of truth stay put.** Markdown, code and BMAD documents remain authoritative. HTML and diagrams are
  derived review surfaces, kept beside them (for example a `review/` folder in the work's own folder), never
  replacements.

## Feedback

- My feedback comes back to this session by itself: an Inbox reply, the `plannotator` tool's decision message,
  the CLI's stdout. Never ask me to copy it over.
- **Approve:** go on. Notes on an approval are guidance, not a block.
- **Change, or annotations:** treat every annotation and answer as my feedback, revise, and send it again in the
  same thread (withdraw the old question with `supersedes`), saying in one line what changed, until I approve
  or tell you to stop.
- **Set aside, dismissed, or no answer:** ask in the terminal.
- **Seeing a message or opening a review is never approval.** Only Approve, or my saying so, is.
- **Consequential decisions** (architecture, scope, anything costly to reverse): record the chosen option and
  the reason where the work keeps its decisions (a decisions folder, the document under review, a BMAD memlog),
  not only in chat.
- **A tool is missing or fails to start:** say so in one line and fall back to the terminal.

BMAD workflows add their own decision points on top of this; see `~/.claude/bmad/interactive-review.md`.
