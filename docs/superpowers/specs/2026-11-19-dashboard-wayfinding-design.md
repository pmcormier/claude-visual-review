# Dashboard page: finding your way in large projects

Status: approved by the owner, 2026-11-19.

## Why

On a large project, the Projects view scrolls on and on, and the work that is running gets lost among
everything that isn't. The owner wants to open the page and see the running work first, and to reach
everything else when he goes looking for it. Today:

- every unfinished epic starts expanded (`epicLi` in `app.js`), so a project with 50 open plans shows all 50 open;
- epics are not sorted. Plans come in file-name order (oldest first), then the work log, then BMAD;
- hovering a session lights its task only when that task is visible, and a folded parent doesn't light;
- the "Done earlier (N)" row also holds unfinished epics that have been quiet for a week, so the name is wrong;
- the help tour still says "with sizes"; the symbols have no key; long lines are cut off and the hover pop-up
  doesn't repeat them.

## Goals

1. Each project's tree is grouped by state. Groups appear in this order, and each can be folded or opened as
   one:
   - **Running:** an epic with a task being worked on (`work`). This includes an epic that looks stuck (`stuck`)
     or whose session ended mid-task (`gone`); its icon already says which.
   - **Waiting on you:** `wait`.
   - **Next:** unfinished, and touched within the last week.
   - **Done:** finished within the last week.
   - Under "Show all history", as today: **Quiet for a week** (unfinished, untouched for a week, which replaces
     the mislabelled "Done earlier" for these), **Done earlier** (finished, over a week ago), **Before the
     dashboard** and **dropped**.
2. **Default view (Focus):**
   - Running and Waiting on you are open, and their epics are open.
   - Every other group is folded.
   - Inside each group, the most recently touched epic comes first.
3. **Live changes:** an epic that changes state moves to its new group. Anything the person opened or closed by
   hand stays that way until they press Focus. The owner chose this.
4. **Per-project buttons:** Expand all, Collapse all, and Focus (back to the default view).
5. **Hover:** when a session is hovered and its task sits inside a folded epic or group, that epic and group
   light too, so the person can see where it is.
6. **Symbol key:** one small "Key" link in the header opens a legend of the six icons (working, idle, done,
   stuck, waiting, subagent) and the colours. The help tour gets a step that points at it.
7. **Hover pop-up:** when a row's label is cut off, the pop-up starts with the full label, then the explanation.
8. **Help text:**
   - The "The plan" step drops "with sizes" and describes the groups.
   - The "Hover for more" step also mentions the key and the full line in the pop-up.

## Non-goals

- No change to the server or the model the page receives. The Sessions and Triage views are unchanged.
- No sort menu. The owner floated sort options; the fixed order above comes first, and a menu waits to see if it
  is missed.
- No change to which plans count as work left (decision 32 stands).

## Anti-goals

- The page never moves something the person opened or closed by hand.
- Running work is never hidden inside a folded group by default.

## How

- **Page only:** `render.mjs` and `app.js`.
- `foldEpics` grows into a pure grouping function. It returns the groups above, each sorted by last activity
  (newest first), and it is tested with `node:test` like the rest of `render.mjs`.
- **Fold state:** stays in `localStorage` (`dash-open`). A key that is present means "the person set this".
  Without a key, an item follows the default view. Focus deletes the keys for that project. Group keys are
  per project and per group name.
- **Moving an epic between groups** uses the existing keyed `sync` re-render, so an epic keeps its own fold
  key when it moves.
- **Lighting parents:** when a task is lit, every folded ancestor (the epic row and the group header) also gets
  the `linked` class.
- **Detecting a cut-off label** is done when the pop-up opens (`scrollWidth > clientWidth` on the label).

## Rules settled after the builder check

1. **Groups are exclusive, decided in this order:**
   - any task `work`, `stuck` or `gone` → Running;
   - else any task `wait` → Waiting on you;
   - else unfinished → Next, or Quiet for a week when untouched for `EARLIER_AFTER_MS` (7 days);
   - else finished → Done, or Done earlier after 7 days.
   Task states come from the page's existing `taskState` (task status plus its live session). Running wins over
   Waiting because both are open by default, and the running work is the one that would otherwise be missed.
2. **The grouping function in `render.mjs` stays pure.** It takes the epics, `now`, and a function that returns
   each task's state. `app.js` passes in `taskState`.
3. **Work left is unchanged.** "Shown" (what feeds `leftText`, `stateTokens`, `effortLeft` and `sizeSummary`) is
   Running + Waiting + Next + Done. "Quiet for a week" stays out, as it is today.
4. **Default fold per group:**
   - Running and Waiting groups and their epics default open. Every other group and its epics default folded.
   - An epic's default follows the group it is in now. An epic in "Next" that the person opens shows its own
     tasks only when the epic itself is opened.
5. **Expand all and Collapse all** write a hand-set key for each main group and each epic of that project,
   including history groups only while "Show all history" is on. An epic that arrives later follows its default
   view. Focus deletes every key for the project.
6. **Hover lights every folded ancestor** of the lit task: the epic row and the group header.
7. **Going to a task** (clicking a session's task) opens its group and then its epic, and both become hand-set
   keys.
8. **Empty groups are hidden.** With "Show all history" off, each history group keeps a one-line hint ("Quiet
   for a week (N)" etc.), as today. With it on, the history groups are foldable groups that default folded.
9. **Epics with no known activity** sort last in their group, in source order, and count as touched (as today:
   unknown activity never folds into a history group).
10. **No reordering under the mouse.** While the pointer is over a project's tree, a re-render keeps the current
    order and grouping. The move happens when the pointer leaves, or on the next update after that.

## Calls I made (the owner can overrule)

- Stuck and gone go under Running, not a group of their own: they are running work that needs a look, and
  their icons and the project edge already flag them.
- "Quiet for a week" splits off from "Done earlier", because today's label calls unfinished work done.
- The key sits behind a header link rather than always on show, to keep the page quiet.

## Left to the builder

- The exact markup and styling of group headers and the three buttons, within the page's existing style.
- Wording of the group headers' counts.
