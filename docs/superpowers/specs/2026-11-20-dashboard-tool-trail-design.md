# Dashboard: a running list of tools under a working task

Status: approved by the owner 2026-11-20. Inbox thread "Compact card view". Short design.

**Intent.** The owner: "Tools flash by so fast. Considering a running list, the current on top, crossed out as they
are completed so a short history is visible." Since decision 39, the line under a running task lists only the tools
running now, so most of them show for a second and vanish.

**What it does.**
- Under a task a session is working on: the tools running now on top (as today), then the last **5** tools that
  session finished, newest first, each crossed out with how long ago it ended ("12 s ago").
- Only while the session is **working**. When it goes idle or waits on the owner, the finished ones clear and the
  line goes back to what decision 39 shows (owner's pick, 2026-11-20).
- The same list appears on the full page and in the compact view's squares (owner, 2026-11-20: "full and compact").
- Each entry is named as today: Claude's description of the call, else the command's first line, else the tool's
  name. Heartbeat watchers stay out, as in decision 37.

**Approaches.** How long finished tools stay was the owner's pick among three: the last 3 from the last 2 minutes;
**the last 5 while the session is working** (chosen); the last 3 always. Chosen because the trail stays steady while
work goes on and never shows stale tools on a quiet project.

**How it's built (builder's notes).**
- The transcript reader (`lib/transcripts.mjs`) keeps each session's last 5 finished tools (name, description,
  command, end time) when a tool's result arrives. A background job that keeps running stays "running", as today.
- The model passes them on as `recentTools` per session; `page/render.mjs` decides what the lines say (a pure,
  tested function); `app.js` draws finished entries crossed out.

**Non-goals.** No history beyond the last 5; nothing stored on disk; the full card's hover is unchanged.

**Docs.** Decision 42 records it.
