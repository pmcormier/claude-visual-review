# Dashboard: project cards keep their place

Status: approved by the owner 2026-11-20 (the order was his pick in the Inbox; small change, short design).

**Intent.** The owner: "I do not like the cards jumping around based on their status. Keep them in the same
positions sorted some logical way." Today the open project cards sort by state (stuck, waiting, working, the rest),
then by name, so a card moves whenever a session starts, stops or asks something.

**Approaches.** A–Z by project name; the order each project first showed up; an order the owner sets by dragging.
Chosen: **A–Z by project name** (owner's pick), because it never moves and any project is easy to find. The top
strip's counts still point to what needs attention.

**Design.**
- Open project cards: A–Z by name, ignoring case; state no longer affects the order.
- Tasks inside a card still move between Running, Waiting on you and the rest (the owner asked for that earlier).
- Builder's calls: the folded "quiet projects" list below the cards keeps its most-recent-first order (it is a short
  list for finding recent work, not cards); a project still opens into the cards when work starts in it, as before.

**Non-goals.** The compact card view (a later brainstorm).
