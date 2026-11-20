# Dashboard: "needs you" means needs you, and one row per thread

Status: approved by the owner, 2026-11-19.

A short design covering the owner's second review of the page on 2026-11-19.

## Why
- **"Waiting on you" misses most of the times Claude needs the owner.** This session was asking him questions in
  the Inbox and the page said "Idle". The owner: "It's not just open inbox. It is anytime claude needs me. In the
  terminal too."
- **Three identical "<thread name>" rows.** There are two Inbox threads with that name, and one of them
  holds checklists from two sessions. The page lists one row per thread per session.
- **A popup that wasn't plain English.** The last round put the thread's subject on the epic popup. Agents write
  subjects as status notes ("plan ready (#79), 2 questions + approval"), so it read as jargon.
- **Most rows say "No description yet".** That's expected for work from before the rule. Only sessions started
  since then know `--about`, and one step this session added to its Inbox checklist was never mirrored in the work
  log.

## Goals
1. **A session reads "Waiting on you" whenever Claude needs the owner.** Any of these counts:
   - a. **A terminal prompt.** Claude Code's own status is `waiting`, as today (permission prompts).
   - b. **A question asked in the terminal.** The session is idle, and its last message to the owner asks
     something:
     - an `AskUserQuestion` call still pending, or
     - its last text ends in a question mark.
   - c. **An open Inbox question.** An Inbox question this session asked has no answer yet: `questions.jsonl`,
     `asked_by_agent_id` is the session, `answer` is null, and it hasn't been withdrawn.
   - The line under the session says what it is waiting for: the question's text, clipped, e.g. "Inbox: What
     should happen to the branch?". "Since" is when it was asked, so Triage's escalation after 15 minutes works
     the same way.
   - The headline "Waiting on you" count and Triage include these sessions.
   - Order of precedence: stuck and gone stay first, then waiting, then working.
2. **One row per Inbox thread.**
   - The newest checklist in the thread wins, whichever session wrote it.
   - Two different threads with the same name show their start date after the name: "<thread name> ·
     Nov 14".
3. **The epic popup drops the thread subject.** It goes back to the progress line, plus a description when an
   agent wrote one. It never shows a status note dressed up as a description.
4. **Descriptions.** No dashboard change. The reply tells the owner how to get them into a running session, and
   this session mirrors every checklist step it adds from now on.

## Non-goals
- No guessing from wording beyond "ends in a question mark".
- No new state colour: these are ordinary "Waiting on you".

## Approaches (for 1)
- **Claude Code's status only** (today): misses Inbox questions and questions asked in the terminal.
- **Also read the Inbox and the transcript's last message (chosen):** both files are already on disk and read
  for other purposes, so this costs no extra calls.
- **Agents mark themselves waiting** (the rule already asks for a `waiting` step): it depends on agents
  remembering, and this session forgot. It stays as a backup signal, not the main one.

## How (for the builder)
- `lib/transcripts.mjs`: record whether the last assistant text ends in `?`, the question line, and the time.
  An `AskUserQuestion` call already shows as a pending tool.
- `lib/sources/inbox.mjs`: a reader for the open questions by session: `{sessionId -> {prompt, askedMs}}`.
  - Before building, check how a withdrawn question is marked (`supersedes`).
- `lib/stall.mjs` or `lib/model.mjs`: an idle session with (b) or (c) becomes `waiting`, with evidence and `since`.
  - Rule: a pending `AskUserQuestion` counts too, even when Claude Code's status says `busy`. The builder checks
    what status Claude Code reports during one.
- `lib/sources/inbox.mjs`: one epic per thread (newest checklist by seq), with the thread's first-message date for
  the duplicate-name suffix.
- `page/render.mjs`: `epicText` drops `subject`.
- Tests for each; docs: decision 36.

## Left to the builder
- How a long question is clipped, and the exact prefix ("Inbox:" or "Asked:").
