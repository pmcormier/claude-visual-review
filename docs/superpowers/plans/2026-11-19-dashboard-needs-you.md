# Dashboard needs-you Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A session reads "Waiting on you" whenever Claude needs the owner (a terminal prompt, a question asked in
the terminal, an open Inbox question); one row per Inbox thread; the epic popup drops the thread subject.

**Architecture:** The transcript scan records a last question to the owner. A new Inbox reader returns open
questions by session. A pure function in `stall.mjs` turns either into a `waiting` verdict for an idle session.
`readInbox` keys checklists by thread.

**Tech Stack:** Node built-ins, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-19-dashboard-needs-you-design.md`

## Global Constraints
- Stuck and gone keep precedence. Only an idle session, or one with an `AskUserQuestion` pending, becomes `waiting`.
- An open Inbox question means all of these hold in its latest `questions.jsonl` envelope:
  - `answer` is null;
  - `superseded_by` is null;
  - it is not an action that already has an `action_result`;
  - its thread is not resolved (`resolved_at` on a message in `messages.jsonl`).

  Checked 2026-11-19: three such questions on this machine, one per live session.
- Evidence copy: `Inbox: <prompt>` for an Inbox question; `Asked: <text>` for one asked in the terminal. Both are
  clipped to 120 characters with `…`.
- This work builds on branch `dashboard-review-fixes`, which isn't merged yet, so one merge covers both.
- Commits start `dashboard-needs-you Task N: …`.

## Review Focus
1. A withdrawn (superseded) or answered question never makes a session wait.
2. A working session with an open Inbox question stays `working`; its hint names the question.
3. A last message that ends in "?" followed by a tool call or a user reply is not a question left open.
4. Two threads with the same name get dates; one thread with checklists from two sessions shows once (the newest).
5. Triage's 15-minute escalation counts from when the question was asked.

---

### Task 1: The signals: last question in the transcript, open Inbox questions

**Files:** `global/dashboard/lib/transcripts.mjs`, `global/dashboard/lib/sources/inbox.mjs`; tests
`tests/dashboard/transcripts.test.mjs`, `tests/dashboard/sources.test.mjs`.

**Interfaces:**
- Produces:
  - `scanTranscript(...).lastAsk: {text: string, ms: number}|null`. It is set by an assistant text block whose
    trimmed text ends in `?`; `text` is its last line. Any later tool call or user entry clears it.
  - An `AskUserQuestion` tool call keeps its first question as `description`.
  - `readOpenQuestions() -> Map<sessionId, {prompt: string, askedMs: number}>`, across every Inbox project. Per
    session, the newest open question wins. The rule is in Global Constraints.

- [ ] **Step 1: Failing tests.**
  - `lastAsk` is set by a text that ends in "?", cleared by a later tool call, and cleared by a later user message.
  - `AskUserQuestion` input `{questions:[{question:'Which way?'}]}` gives `description: 'Which way?'`.
  - Inbox fixtures, one question each: answered, superseded, an action with a result, a resolved thread, and an
    open one. Only the open one is returned, keyed by `asked_by_agent_id`, with `askedMs` taken from its envelope's
    `at`.
- [ ] **Step 2: Run** `node --test tests/dashboard/transcripts.test.mjs tests/dashboard/sources.test.mjs`.
  Expected: the new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: pass.
- [ ] **Step 5: Commit** `dashboard-needs-you Task 1: last question and open Inbox questions`.

### Task 2: The verdict, and the model wiring

**Files:** `global/dashboard/lib/stall.mjs`, `global/dashboard/lib/model.mjs`; tests
`tests/dashboard/stall.test.mjs`, `tests/dashboard/model.test.mjs`.

**Interfaces:**
- Consumes: Task 1.
- Produces: `askedOwner(verdict, signals, inboxQ) -> verdict` (pure, in `stall.mjs`):
  - stuck, gone or waiting: returned unchanged.
  - pending `AskUserQuestion`: `waiting`, evidence `Asked: <description>`, since the tool's start.
  - idle and `signals.lastAsk`: `waiting`, evidence `Asked: <text>`, since `lastAsk.ms`.
  - idle and `inboxQ`: `waiting`, evidence `Inbox: <prompt>`, since `askedMs`.
  - working and `inboxQ`: unchanged, but `hint` (when empty) becomes `Inbox question open: <prompt>`.
- `model.mjs`:
  - `sessionView` applies `askedOwner` after `classify`;
  - the open questions are read once per build, cached on a signature of the Inbox files that adds
    `questions.jsonl` to `inboxSig`.

- [ ] **Step 1: Failing tests**, one per rule above. In model, a fixture session with an open Inbox question reads
  `waiting` and counts in `counts.waiting`.
- [ ] **Step 2: Run** `node --test tests/dashboard/stall.test.mjs tests/dashboard/model.test.mjs`. Expected: the
  new tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `node --test tests/dashboard/`. Expected: pass.
- [ ] **Step 5: Commit** `dashboard-needs-you Task 2: waiting on you when Claude asks`.

### Task 3: One row per thread; the popup drops the subject

**Files:** `global/dashboard/lib/sources/inbox.mjs`, `global/dashboard/page/render.mjs`; tests
`tests/dashboard/sources.test.mjs`, `tests/dashboard/page.test.mjs`.

**Interfaces:**
- `readInbox`:
  - one epic per thread: the newest checklist by seq, else file order, whichever session wrote it;
  - id `inbox:<thread>`;
  - `sessionId` comes from that checklist.
- When two threads share a title, each title gets ` · <Mon D>`: the date of the thread's first message
  (`created_at`), formatted with `toLocaleDateString('en-US', {month: 'short', day: 'numeric'})`.
- `epicText` no longer reads `subject`.

- [ ] **Step 1: Failing tests:**
  - one thread with two sessions' checklists shows once, using the newest;
  - two threads named "Build status" get dates;
  - the epic popup has no subject. Update the earlier subject test.
- [ ] **Step 2: Run** `node --test tests/dashboard/sources.test.mjs tests/dashboard/page.test.mjs`. Expected: fail.
- [ ] **Step 3: Implement.** Check every caller and test that uses the old `inbox:<thread>:<session>` id.
- [ ] **Step 4: Run** `node --test tests/dashboard/`. Expected: pass.
- [ ] **Step 5: Commit** `dashboard-needs-you Task 3: one row per Inbox thread; popup without the subject`.

### Task 4: Docs, install, live check
- [ ] Write decision 36 (needs-you signals, one row per thread). Update the README Dashboard row: "Waiting on you"
  includes questions asked in the terminal or the Inbox.
- [ ] Run `pwsh -NoProfile -File tests/run.ps1`. Expected: 0 failed. `check-personal` passes.
- [ ] Commit `dashboard-needs-you Task 4: docs`.
- [ ] Install, restart the server, then check:
  - the three sessions with open Inbox questions read "Waiting on you" with the question as their line;
  - "build status" shows once per thread.
