# Dashboard: compact view

Status: draft for the owner's approval (2026-11-20). Inbox thread "Compact card view".

## Intent

The owner wants a view that is always open in a small space, such as an Edge split pane or a corner of another
monitor. It answers "what is going on right now?" at a glance, with no scrolling or searching for current status,
and gives more at a click. The full page stays open in its own tab for digging. In his words: "only the essentials
… definitely focused on what is currently going on. No digging into history", and later "Lets ensure what is in
the squares is verbose enough to get the full picture. Similar to running."

## Goals

- One square per **active** project. All squares are the same size and laid out in as many columns and rows as the
  window allows. A tall, narrow window stacks them; a wide one sets them side by side.
- Each square is verbose enough to tell the whole current story, like the full card's Running group. Its
  **headline stays at the top** (owner's note).
- A click on a square opens that project's full card in the same space, with a way back.
- A small switch in each view moves between the compact view and the full page. A plain click navigates; Ctrl-click
  or middle-click opens a new tab; a small ↗ opens a new window.

## Non-goals

- Spend, tokens, open and close controls, and history do not appear in a square.
- No new data. The compact view reads the same live model the full page already gets.
- No settings for square size or layout in this round.

## Anti-goals (a failure even if it works)

- Having to search a square, or the page, for a project's current status.
- Squares that move or resize as work changes. A project still appears when its work starts and leaves when it ends.
- A second source of truth: the compact view must never disagree with the full page about a project's state.

## Decisions the owner made (Inbox, 2026-11-20)

- **Which projects get a square:** active projects only (working, waiting on you, stuck). Below the squares, one
  line names the quiet projects. A name in that line opens that project's full card, like a square does.
- **How the squares fit verbose content (approach A, chosen from three):** same-size squares, cut to fit.
  - Considered: B, the same width with height fitting the content. It never cuts anything, but squares differ in
    height. C, the window shared out evenly: squares are equal and the page never scrolls, but they get small with
    many projects.
  - The owner's notes on A:
    - when the squares need more room than the window has, the view scrolls;
    - squares stay the same size, in as many columns and rows as fit;
    - "scrolling within a square is ok … but definitely keep the headliner data at the top".
- **Its own address**, plus a switch in each view: a plain click navigates, and another tab or window is one click
  away.
- **Order:** A–Z by project name, as for the full page's cards (decision 38).

## What a square shows, top to bottom

1. **Headline (fixed; never scrolls away):**
   - the project's name;
   - its state, as the same chip the full page uses (Working, Waiting on you, Stuck);
   - the heartbeat: the small "signs of life over the last hour" line the full page draws for a session.
2. **Body (scrolls inside the square when it is too long):** for each live session in the project, the same facts
   the full card's Running and Waiting on you groups show, without spend:
   - the task the session is on;
   - that task's steps, each with its mark (done, the one it is on, to do);
   - what is running now (decision 39): one line per running tool, with "Watched · last output N min ago" when a
     watcher covers it (decision 37);
   - why it waits or looks stuck: the question asked, or the stall evidence.
3. **Next:** one line naming the project's next task, when there is one.

A square's hover texts are the full page's: the same words, from the same functions in `page/render.mjs`.

## The full view of one project

Clicking a square, or a quiet project's name, replaces the squares with that project's full card: the same card the
full page draws, with its history and controls. A "Back to all" button sits at the top. While one project is open,
the live updates keep updating it.

## Builder's calls in this document (the owner can overrule them)

- **Address:** `/compact`, served by the dashboard server as the same page. The page picks the view from the path.
  One page means one copy of the live connection, the theme and the hovers.
- **Square size:** about 320 × 300 px. The layout is a grid of fixed-width columns: as many 320 px columns as fit,
  with the page scrolling past the last row. The builder may tune the size after looking at real content.
- **Heartbeat for a project with several live sessions:** the most active session's line, the one with the most
  recent activity.
- **Idle projects** (a session open, waiting for the owner's next message, nothing asked) count as quiet and go in
  the quiet line. That matches the owner's "focused on what is currently going on". A question to the owner counts
  as waiting on you and gets a square.
- **The open project survives a reload:** the open project is kept in the address (`/compact#<project>`), so a
  reload or a bookmark keeps it.
- **The ↗ new window** opens at a compact size, about 700 × 900 px for the compact view, and at a normal size for the
  full page.

## Left to the builder

- How to share the full card's drawing code between the two views without copying it.
- The exact cut of a long task title or step (one line with "…", full text in the hover).
- Keyboard: a square is a button. Enter opens it; Escape goes back to all.

## Docs

- `README.md`'s Dashboard row and `docs/setup-guide.html` mention the compact view and its address.
- A decision in `docs/decisions.md` records the approach and the owner's picks.
