# Update glow (short design)

Status: approved (owner, 2026-11-20, Inbox)

**Why:** the owner wants to see at a glance which project just moved, as a trial that may prove too frequent.

**What counts:** real progress only. The project's state changes, a step or task changes status, a work-log entry
starts, or a session opens or closes. Tool lines don't count. Nothing glows on first sight of a project.

**What shows:** the project's card (a square in compact view) gets a soft ring in the colour of what happened: the new
state's colour, or teal when a step finished and the state held. In for about a third of a second, out over about two
seconds (2.6 s in all). A rebuild mid-glow carries on where it was. Reduced motion: a plain outline for the same time.

**Approaches:** any change on the card (rejected: working projects would glow constantly); only when it needs the
owner (rejected: the "New" marker already does that); real progress (picked).

**How:** `progressOf(p)` and `glowKind(prev, next)` in `page/render.mjs` (tested); `glowFor`/`withGlow` in
`page/app.js` on full cards and squares; the keyframes in `page/app.css`. Decision 44.
