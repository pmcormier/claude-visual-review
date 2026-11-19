# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Static HTML, CSS and JavaScript served by one dependency-free Node server on 127.0.0.1. Node is already a
requirement of the Rigor component. No build step, no npm packages.

## Users

People who run Claude Code on their own machine, often several sessions at once across several projects, with
background subagents and long shell jobs. They already get pinged by the Plannotator Inbox when a session needs
them. They look at this page between tasks to see the whole picture.

## Product Purpose

claude-visual-review installs a visual-first review workflow for Claude Code (rules, the Plannotator Inbox
conventions, planning-method rules, optional components). Its dashboard surface is one live page per machine
that shows, across every project:

- what is running now: each live session, its state, and its subagents;
- what has quietly stopped: stalled sessions, hung tools, unresumed API errors, unanswered permission prompts,
  subagents that never report back, and loops, each with the evidence for the call;
- the work as a tree: project → epic (a plan, spec or BMAD epic) → task, plus one live "now" line;
- time spent (measured from timestamps) and effort left (a count of unfinished tasks, with an hours estimate
  calibrated against past work).

Success: a glance answers "what's moving, what's done, what's next, and what is stuck" without opening any
terminal.

## Positioning

The Inbox hears from a session when it asks something. This page sees the sessions that never ask: it reads
Claude Code's own session, transcript and subagent files and judges stalls by signs of life (CPU, output,
transcript writes), never by elapsed time alone.

## Operating Context

- Opened in a VS Code tab (through the installed opener) or a browser, kept open beside work.
- One server per machine, started by the first Claude Code session's hook; stops itself when no session has been
  open for a while; a Stop button and a Start menu shortcut / `/dashboard` command for manual control.
- Windows first (the repo targets Windows and VS Code); other platforms are a later concern.

## Capabilities and Constraints

- Reads undocumented Claude Code internals (`~/.claude/sessions/*.json`, transcripts, `subagents/*.meta.json`);
  must show "unknown" rather than break when their format changes.
- Tree depth is capped: project, epic, task, plus a live "now" line. Plan steps never appear.
- Finished epics fold to one line and expand on click; work older than a week folds into "Done earlier", with a
  "Show all history" control. Projects with a live session, a task in progress, or a stall stay open.
- No notifications: pinging stays the Inbox's job.
- Light and dark follow the system setting. No theme picker.
- Installable by anyone from this public repo; nothing personal in tracked files.

## Evidence on Hand

Real data exists on any machine running Claude Code: session registry files with `busy` / `idle` / `waiting`
status, transcripts with API-error markers, subagent metadata with description, model and `finished`. Mockups use
invented sample data and must say so.

## Product Principles

- Signs of life, not timers: never call something stuck without showing why.
- Big picture first; detail on demand.
- Bounded by design: depth limits and folding, not endless trees.
- Trust signals over discipline: what can be computed is computed, not remembered by a model.
- Costs nothing to leave open: no tokens, negligible CPU.
