# Dashboard heartbeat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sessions start a zero-cost watcher beside each long background job, which wakes them only when the job goes quiet, repeats itself or ends. A Stop hook reminds a session once when its work log says "doing" but nothing is done or watched.

**Architecture:**
- `watch.mjs` polls the job's output file and keeps a marker in `<dashHome>/watch/`. It exits with one line when a rule fires, and its exit wakes the session.
- `tidy-hook.mjs` (Stop) reads the session's open work-log entry and its markers.
- The dashboard reads the markers to show "Watched".
- Decision logic is pure and tested; the loops are thin.

**Tech Stack:** Node built-ins, `node:test`, PowerShell installer tests.

**Spec:** `docs/superpowers/specs/2026-11-20-dashboard-heartbeat-design.md`

## Global Constraints
- Quiet window: default **15** minutes; `--quiet` accepts 5–120, and anything else exits at once with an explanation.
  Polls every 15 s. A marker is live when `exited` is null and `beatAt` is within **3** minutes. The beat refreshes
  every minute. Markers older than **7** days are pruned at server start and daily.
- Exit lines, verbatim. Lines are clipped to 200 characters with `…`:
  - `Quiet <N> min: "<what>". Last line: <line>.`
  - `Repeating for <N> min: "<what>". Line: <line>.`
  - `Job ended (code <C>): "<what>". Stop watching it.` (2 minutes after `[exited with code C]` is seen)
  - `Output file gone: "<what>".` (2 consecutive failed polls)
  - Suffix ` No new output since the last check.` when the previous marker for the same file exited quiet at the
    same size.
- Hook reminder text is the spec's quote, verbatim, with `<entry title>`, `<n>` and `<name>` filled in.
- Scripts never fail a session. Errors go to `<dashHome>/watch.log` or `<dashHome>/tidy.log`. Scripts write only
  under `<dashHome>`. Tests use `CVR_DASH_CLAUDE_HOME`, never the real `~/.claude`.
- `tools/check-personal.ps1` passes. Commits start `dashboard-heartbeat Task N: …`.

## Review Focus
1. Two watchers in one session, on two files: each marker is separate, and the hook sees "a live watcher" if
   either is live.
2. A job that ends while its output was already quiet: `Job ended` wins over `Quiet`.
3. A hook run on a transcript or work log that is missing or broken: no reminder, exit 0, nothing printed.
4. The hook on a session whose open entry has a `doing` step, but whose last text asks the owner something: no
   reminder.
5. An output file that is replaced (shrinks): treated as growth (new output), not as gone.

---

### Task 1: Gate: record whether background commands are cut off
- [ ] Read the result of the 25-minute background test started 2026-11-20. Its output file ends with
  `survived N s` when nothing cut it off.
- [ ] Write the result into the spec's "Facts this rests on". No cap: the bullet becomes verified and the "Build
  order" fallback is dropped. A cap of C minutes: add a constant `CAP_MIN` to Task 2. The watcher exits at
  `CAP_MIN - 1` with `Still running fine after <N> min: "<what>". Start the watcher again.`
- [ ] Commit `dashboard-heartbeat Task 1: background command cap checked`.

### Task 2: The watcher

**Files:** create `global/dashboard/lib/watch.mjs` (pure logic and markers) and `global/dashboard/watch.mjs`
(CLI). Test: `tests/dashboard/watch.test.mjs`.

**Interfaces (produces):**
- `markerPath(session: string, file: string) -> string`: `<dashHome>/watch/<session>-<sha1(file) first 12>.json`.
- `readMarkers(session?: string) -> Marker[]`. A Marker is
  `{session, file, what, startedAt, beatAt, lastGrowthAt, size, quietMin, exited: null|{at, reason, size}}`, with
  times in ms. Broken files are skipped.
- `isLive(m: Marker, now: number) -> boolean`.
- `pruneMarkers(now: number) -> void` (7 days, by `beatAt`).
- `judge(state, poll, now) -> {state, exit: string|null}`. This is pure.
  - `state`: `{what, quietMin, size, lastGrowthAt, windowLines: {text, at}[], failures, endedAt, prevQuietSize}`.
  - `poll`: `{ok: boolean, size, tail: string[]}`, where `tail` is the new lines since the last poll and
    `ok: false` means unreadable.
  - It applies the exit rules in Global Constraints, in this order: gone, job ended, repeating, quiet.
- `sessionOf(file: string, env) -> string|null`: `env.CLAUDE_CODE_SESSION_ID`, else the path segment before
  `tasks`.

- [ ] **Step 1: Failing tests** (`judge` with a fake clock; markers under a temp `CVR_DASH_CLAUDE_HOME`):
  - `quiet after 15 min with no growth`: exit equals `Quiet 15 min: "CI watch". Last line: waiting.`
  - `growth resets quiet`: growth at minute 14 means no exit at minute 15.
  - `repeating`: the same trimmed line arrives for 15 minutes with growth, and the exit starts `Repeating for 15 min`.
  - `changing progress lines are not repeating`: `10%`, `11%`, and so on give no exit.
  - `job ended waits 2 min`: `[exited with code 0]` is seen at t, so no exit at t+1 min, then an exit at t+2 min
    equal to `Job ended (code 0): "CI watch". Stop watching it.`. It wins over quiet (Review Focus 2).
  - `gone after 2 failed polls`; one failed poll gives no exit.
  - `shrink counts as growth` (Review Focus 5).
  - `no new output suffix`: `prevQuietSize` equals the current size at the quiet exit, so the line ends with
    ` No new output since the last check.`
  - `long line clipped to 200 with …`.
  - `--quiet 3` is refused, and `--quiet 30` is accepted (test the exported `parseArgs`).
  - `isLive`: fresh beat and not exited is true; a 4-minute-old beat is false; exited is false.
  - `two markers for one session, one live` (Review Focus 1): `readMarkers(s)` returns 2, and `.some(isLive)` is true.
  - `sessionOf` falls back to the path segment.
- [ ] **Step 2: Run** `node --test tests/dashboard/watch.test.mjs`. Expected: FAIL, because the module is missing.
- [ ] **Step 3: Implement.**
  - The CLI (`watch.mjs`):
    - parses `--file`, `--what` and `--quiet`;
    - reads the previous marker for the same file into `prevQuietSize`, but only when its `exited.reason` is
      `quiet`;
    - polls every 15 s, reading only the bytes past the last size;
    - writes the marker at start, on every growth and every minute;
    - on an exit, writes `exited`, prints the line and exits 0.
  - `watch.mjs` imports only `./lib/watch.mjs` and `./lib/paths.mjs`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `dashboard-heartbeat Task 2: the watcher`.

### Task 3: The end-of-turn tidy-up hook

**Files:**
- Create: `global/dashboard/tidy-hook.mjs`.
- Modify: `global/dashboard/lib/worklog.mjs` (add `openEntryFor`) and `install.ps1` (a fourth `$hookSpecs` row:
  `Event = 'Stop'; Script = 'dashboard/tidy-hook.mjs'; Find = (& $dashFind 'tidy-hook.mjs')`).
- Test: `tests/dashboard/tidy.test.mjs` and `tests/install.tests.ps1`.

**Interfaces:**
- Consumes: `readMarkers` and `isLive` (Task 2).
- Produces:
  - `openEntryFor(root: string, session: string) -> {title: string, doing: {n: number, name: string}[]} | null`:
    the session's latest `start` that is not closed by `done` or `drop`. `doing` lists its steps whose status is
    `doing`. An entry with no steps gives `doing: []`.
  - `tidyDecision({entry, live: boolean, asking: boolean, stopActive: boolean, lastState: string|null}) -> {remind: string|null, state: string|null}`.
    This is pure. `state` is a stable string of the entry title plus its doing steps, for example
    `title|2:Build`.
  - `askingAtEnd(transcriptTail: string[]) -> boolean`. It reads the tail (the last 64 KB) of the transcript
    JSONL. It is true when the last assistant text ends in `?` with no later tool_use or user entry (the same rule
    as `transcripts.mjs` `lastAsk`), or when an `AskUserQuestion` tool_use has no result.
- The hook reads stdin `{session_id, cwd, transcript_path, stop_hook_active}`.
  - Root: `projectRoot(cwd)`.
  - State is stored in `<dashHome>/tidy/<session>.json` as `{state}`.
  - When reminding, it prints `{"decision":"block","reason":"<text>"}`. Otherwise it prints nothing.
  - It always exits 0, with a 2 s stdin guard like `plan-hook.mjs`.

- [ ] **Step 1: Failing tests:**
  - `openEntryFor`: start with steps, then `step 2 doing`, gives `doing: [{n:2, name:'Build'}]`. After `done` it
    is null. Another session's entry is not returned.
  - `tidyDecision`:
    - reminds with the exact spec text when there is a doing step, nothing is live, the session isn't asking,
      `stopActive` is false and the state is new;
    - is null when a watcher is live;
    - is null when asking (Review Focus 4);
    - is null when `stopActive`;
    - is null when `state === lastState`;
    - is null when `doing: []`.
  - `askingAtEnd`: text ending in `?` is true; the same text followed by a tool_use is false; a pending
    `AskUserQuestion` is true.
  - Hook process (spawned with a temp home):
    - a missing transcript or work log means exit 0 and empty stdout (Review Focus 3);
    - the remind case prints valid JSON with `decision: "block"`;
    - a second run with the same state prints nothing.
  - Install test: a fresh install has exactly one Stop hook matching `tidy-hook\.mjs`, a rerun adds none, and
    uninstall removes it. Mirror the existing `plan-hook` assertions.
- [ ] **Step 2: Run** `node --test tests/dashboard/tidy.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** Keep the hook's imports to node built-ins plus `lib/worklog.mjs`, `lib/watch.mjs`,
  `lib/sessions.mjs` and `lib/paths.mjs`.
- [ ] **Step 4: Run** `node --test tests/dashboard/` and `pwsh -NoProfile -File tests/run.ps1`. Expected: PASS,
  0 failed.
- [ ] **Step 5: Commit** `dashboard-heartbeat Task 3: end-of-turn tidy-up hook`.

### Task 4: The dashboard shows watched jobs

**Files:**
- Modify: `global/dashboard/lib/model.mjs` (`toolView` gains `watched: boolean`, true when a live marker's `file`
  equals the tool's `outputFile`; markers are read once per build), `global/dashboard/page/render.mjs`,
  `global/dashboard/page/app.js` and `global/dashboard/server.mjs` (`pruneMarkers` at start and every 24 h).
- Test: `tests/dashboard/model.test.mjs` and `tests/dashboard/page.test.mjs`.

**Interfaces:**
- Consumes: `readMarkers`, `isLive` and `pruneMarkers` (Task 2).
- Produces: `watchedNote(tool, now) -> string`, which is `Watched · last output <N> min ago` (`just now` under 1
  minute) when `tool.watched`, else `''`. The hover text is
  `The session is watching this job and will check on it after <quietMin> minutes of silence.`

- [ ] **Step 1: Failing tests:**
  - model: a fixture session with a background tool whose output file has a live marker gives
    `pendingTool.watched === true`. A stale marker gives false. The stall verdict is unchanged in both cases.
  - page: the `watchedNote` cases.
- [ ] **Step 2: Run** `node --test tests/dashboard/model.test.mjs tests/dashboard/page.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement.** Pass `lastGrowthAt` and `quietMin` through with `watched`. Show the note on the
  session's line, in the muted style used for "earlier". Check `app.js` with `node --check`.
- [ ] **Step 4: Run** `node --test tests/dashboard/`. Expected: PASS.
- [ ] **Step 5: Commit** `dashboard-heartbeat Task 4: dashboard shows watched jobs`.

### Task 5: Rule, docs, install, live check
- [ ] Add the spec's "Watch what you launch" bullet, verbatim, to `global/rules/dashboard.md`, after "Close what
  you open".
- [ ] Write decision 37 in `docs/decisions.md`: the heartbeat, why A + C, the costs measured 2026-11-20, and the
  rejected timer. Mention the watcher and the Stop hook in the README Dashboard row, `docs/setup-guide.html` and
  `docs/setup-prompt.md`.
- [ ] Run `pwsh -NoProfile -File tests/run.ps1`. Expected: 0 failed. `tools/check-personal.ps1` passes.
- [ ] Commit `dashboard-heartbeat Task 5: rule and docs`.
- [ ] Install, restart the server, then run a live check:
  - start a background job that prints once and sleeps 6 minutes, with the watcher at `--quiet 5`;
  - the dashboard shows `Watched`;
  - the watcher wakes this session with `Quiet 5 min: …`;
  - a second watcher on the same file, still quiet, ends with `No new output since the last check.`;
  - the job's exit produces `Job ended` after 2 minutes, unless the watcher is stopped first;
  - end a turn with a `doing` step and nothing watched: the reminder appears once.
