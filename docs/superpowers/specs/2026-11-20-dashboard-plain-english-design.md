# Dashboard: plain-English check

Status: draft for the owner's approval (2026-11-20). Inbox thread "Plain-English check of the dashboard". Short design.

**Intent.** The owner: "ensuring that everything on the screen is real, readable, non-technical, english. Can we do
some testing to ensure that is the case?" He also sees hover descriptions missing in places.

**Approach (owner's pick, C of three):** audit the live page first, then turn each kind of problem it finds into a
guard test. Considered: the audit alone (a snapshot that drifts) and guard tests alone (they only catch patterns we
think of).

**1. The audit (once, now).**
- A Playwright script opens the full page (Projects, Sessions and Triage, with every group expanded and "Show all
  history" on) and the compact view (the squares, and each project's card). It writes out every visible text and every
  hover text, with where it appears, and lists every row, chip, icon and button that has no hover.
- A fresh reviewer reads that collection against four tests: **real** (no placeholder, test or stale text, nothing
  that disagrees with what is happening); **readable** (a full thought, not cut mid-word without "…"); **non-technical**
  (no paths, ids, tool names, code, JSON, "null", "undefined", "NaN"); **English** (plain words for someone who hasn't
  followed the work). Each finding names the text, where it shows and which test it fails.
- Run on this machine's live data, which already holds the nasty cases (long-lived sessions, plans, Inbox questions,
  MCP tools). The collection stays in the scratchpad; it is never committed (it holds real project text).

**2. The findings go to the owner** as a pick-list, grouped by kind, with a fix proposed for each kind.

**3. Guard tests.** For each kind the owner wants fixed, a test in `tests/dashboard/` feeds the page's text functions
the raw input that caused it and checks the plain result, plus one sweep test: every text function, given a model
built from realistic fixtures (raw commands, paths, MCP names, empty and missing fields), returns nothing that matches
a list of technical patterns (`mcp__`, drive paths, `undefined`, `null`, `NaN`, `[object`, long hex ids).

**Already known, folded in:** a work-log entry replaced by a newer one with the same title from the same session
shows as a separate "Started, not active" task (seen: "Dashboard page: finding your way" three times). Fix: such a
replaced entry is hidden on the page, and `note.mjs` gets a `steps` command that changes an open entry's steps in
place, so agents stop starting a new entry to rename a step. The "Next:" line naming a replaced entry's step goes
with it.

**Non-goals.** No rewording of text the owner already approved unless the audit finds it fails a test; no new
features.

**Docs.** The rule text gains one line for `note.mjs steps` (a rule change: the owner signs it off with this design).
Decision 43 records the check.
