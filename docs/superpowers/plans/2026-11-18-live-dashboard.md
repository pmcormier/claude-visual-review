# Live Dashboard Implementation Plan

Status: done — catch-up 2026-11-19

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A machine-wide live page that shows every Claude Code project's sessions, subagents, stalls (with evidence), work tree, time and plan usage, installed as the optional **Dashboard** component.

**Architecture:** Small focused ES modules under `global/dashboard/lib/` read Claude Code's, Plannotator's and git's local files into one model. `server.mjs` serves the page and pushes the model over Server-Sent Events. A `SessionStart` hook starts it (one per machine; the port is the lock). Helpers (`note.mjs`, `plan-hook.mjs`, `statusline-tap.mjs`) write only under `~/.claude/dashboard/`.

**Tech Stack:** Node.js built-ins only (`node:http`, `node:fs`, `node:child_process`, `node:test`); plain HTML/CSS/JS page; PowerShell 7 installer and tests.

**Spec:** `docs/superpowers/specs/2026-11-18-live-dashboard-design.md` (read it first; this plan argues from it). Reference look: `docs/superpowers/specs/live-dashboard/mockup.html`.

## Global Constraints
- No npm packages; Node built-ins only; Node 20 or later (`node:test`, `fs.watch` recursive on Windows).
- Never write inside a user's project. All dashboard writes go under `<claudeHome>/dashboard/`.
- Every reader of Claude Code or Plannotator files tolerates missing files, missing fields, unknown values and
  partial last lines, and yields `null`/"unknown" instead of throwing.
- Every module takes its roots from `lib/paths.mjs`, which honours `CVR_DASH_CLAUDE_HOME` and
  `CVR_DASH_PLANNOTATOR_HOME` (tests) before `~/.claude` and `~/.plannotator`.
- Server binds `127.0.0.1`, default port `47800` (config `port`).
- Default thresholds (config `thresholds`, minutes): `quiet: 20`, `hungTool: 20`, `apiError: 5`, `waiting: 5`,
  `waitingEscalate: 15`, `subagentQuiet: 20`, `loopCount: 6`, `loopWindow: 10`, `idleGap: 15`, `autoStop: 30`.
- Transcript-derived text reaches the page only through `textContent`.
- Tests never touch the real `~/.claude`; Node tests live in `tests/dashboard/` (not under `global/`, whose every
  file is installed).
- Copy on the page: sentence case; states are exactly `Working`, `Waiting on you`, `Idle`, `Looks stuck`,
  `Gone`; "Not linked to a task yet"; "No plan found"; "Usage not available".
- Repo is public: fixtures use invented names (`web-shop`, `billing-api`); `tools/check-personal.ps1` passes.

## Review Focus
1. **A long build that is genuinely working** (CPU busy, no output for an hour) must stay `Working`. Test in Task 6.
2. **A transcript whose last line is half-written** while the session writes must not crash or blank the session.
   Test in Task 1 and Task 3.
3. **A user with no status line, or one that is an object with `padding`,** must see exactly what they saw
   before install, and get it back after removal. Tests in Task 10 and Task 13.
4. **Two plans in one repo both having `Task 1`:** a commit "Task 1 done" must tick neither unless the plan is
   unambiguous. Test in Task 9.
5. **The server dying or never starting** must never delay or break session start. Test in Task 11.

---

### Task 1: Paths, tolerant JSONL, test wiring

**Files:**
- Create: `global/dashboard/lib/paths.mjs`, `global/dashboard/lib/jsonl.mjs`, `global/dashboard/lib/config.mjs`
- Create: `tests/dashboard/jsonl.test.mjs`, `tests/dashboard/config.test.mjs`, `tests/dashboard.tests.ps1`

**Interfaces:**
- Produces: `claudeHome(): string`, `plannotatorHome(): string`, `dashHome(): string` (= `<claudeHome>/dashboard`).
- Produces: `readJsonl(path, {fromByte?:number}): {records:object[], endByte:number}`; skips unparsable lines;
  a final line without `\n` is not consumed (its bytes are not included in `endByte`).
- Produces: `loadConfig(): {port:number, thresholds:{...}}`; reads `<dashHome>/config.json`, merges over defaults.

- [x] **Step 1: Write failing tests**: `readJsonl skips a broken middle line`, `readJsonl leaves a partial last line for next read` (append the rest, read from `endByte`, get the record), `readJsonl on a missing file returns empty`, `loadConfig merges a partial thresholds object over defaults` (asserts `quiet` overridden to 30, `apiError` still 5).
- [x] **Step 2:** `tests/dashboard.tests.ps1` dot-sources `lib.ps1` and runs `node --test tests/dashboard/` as one `Test 'DashboardNodeTests'`, failing on non-zero exit. Run `pwsh -NoProfile -File tests/run.ps1` → FAIL (modules missing).
- [x] **Step 3: Implement** the three modules.
- [x] **Step 4: Run** `node --test tests/dashboard/` → PASS; `pwsh -NoProfile -File tests/run.ps1` → `0 failed`.
- [x] **Step 5: Commit** "Dashboard: paths, tolerant JSONL reader, config, test wiring".

### Task 2: Sessions registry and liveness

**Files:**
- Create: `global/dashboard/lib/sessions.mjs`; Test: `tests/dashboard/sessions.test.mjs`, fixtures under `tests/dashboard/fixtures/sessions/`

**Interfaces:**
- Produces: `readSessions(): SessionInfo[]` where `SessionInfo = {sessionId, pid, procStart, cwd, name, status:'busy'|'idle'|'waiting'|'unknown', statusUpdatedAt:number|null, transcriptPath:string|null, project:string}`.
- Produces: `projectRoot(cwd): string`: `git rev-parse --show-toplevel` from `cwd` (cached), else `cwd`.
- Produces: `transcriptPathFor(cwd, sessionId)`: `<claudeHome>/projects/<encoded cwd>/<sessionId>.jsonl`, where the encoding replaces every char not `[A-Za-z0-9]` with `-` (verify against a real folder name under `~/.claude/projects/` on the build machine).

- [x] **Step 1: Failing tests**: `reads busy/idle/waiting from registry files`, `unknown status value becomes 'unknown'`, `missing fields do not throw`, `transcriptPathFor encodes a cwd of drive X, folder work, folder web-shop as X--work-web-shop`.
- [x] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [x] **Step 5: Commit** "Dashboard: session registry reader".

### Task 3: Transcript signals

**Files:**
- Create: `global/dashboard/lib/transcripts.mjs`; Test: `tests/dashboard/transcripts.test.mjs` with hand-written fixture JSONL.

**Interfaces:**
- Consumes: `readJsonl`.
- Produces: `scanTranscript(path, now): TranscriptSignals` with incremental state kept per path (re-reads only new bytes):
  `{lastWriteMs, minutes:number[60] /* 1 = activity in that minute, index 59 = now */, pendingTool:{name, command, startedMs, outputFile:string|null}|null, lastEntryIsApiError:boolean, lastEntryMs, tokens:{input, output, cacheRead, cacheCreate}, repeat:{command, count}|null, planRefs:{file, ms}[], taskRefs:{n:number, ms}[]}`.
- `pendingTool` = a `tool_use` with no matching `tool_result` id. `outputFile` = the `.output` path a background Bash result names. API error = an entry with `"isApiErrorMessage":true`. Repeats = identical Bash `command` or identical Edit `file_path`+`old_string` within `loopWindow` minutes. `planRefs` = Read/Edit/Write `file_path` matching `docs/superpowers/plans/*.md` or a BMAD ticket file. `taskRefs` = `/\bTask (\d+)\b/` in assistant text or tool inputs.

- [x] **Step 1: Failing tests**: `pending tool detected until its result arrives`, `api error as last entry`, `tokens summed from message.usage`, `six identical commands in ten minutes gives repeat count 6`, `plan file read recorded in planRefs`, `partial last line ignored then picked up`.
- [x] **Step 2–4:** run (FAIL), implement, run (PASS).
- [x] **Step 5: Commit** "Dashboard: transcript signals".

### Task 4: Subagents

**Files:** Create `global/dashboard/lib/subagents.mjs`; Test `tests/dashboard/subagents.test.mjs`.

**Interfaces:**
- Produces: `readSubagents(transcriptPath, now): SubagentInfo[]` from `<transcript dir>/<sessionId>/subagents/agent-<id>.{jsonl,meta.json}`:
  `{agentId, description, model, effort, finished:boolean|null, lastWriteMs, minutes:number[60], signals:TranscriptSignals}`.

- [x] Steps: failing tests `reads description/model/finished from meta`, `missing meta gives description 'Subagent'`, `minutes from the subagent's own transcript` → implement → pass → commit "Dashboard: subagents".

### Task 5: Process CPU and output growth (Windows)

**Files:** Create `global/dashboard/lib/procs.mjs`; Test `tests/dashboard/procs.test.mjs`.

**Interfaces:**
- Produces: `parseProcessTable(text): {pid, ppid, cpuSeconds}[]` (pure, from the helper's CSV).
- Produces: `startCpuSampler(intervalMs=5000): {descendants(pid): {pid, cpuPct}[], alive(pid, procStart): boolean, stop()}`. One long-lived `pwsh -NoProfile -Command` child loops `Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId,KernelModeTime,UserModeTime | ConvertTo-Csv` every interval; CPU % from deltas. Off Windows, `alive` uses `process.kill(pid, 0)` and CPU is `null`.
- Produces: `outputGrowth(path): {idleMs:number|null}` (time since the file last grew).

- [x] Steps: failing tests `parseProcessTable reads CSV`, `cpu percent from two samples`, `descendants walks the ppid tree` → implement → pass. **Measure** the sampler's own CPU over 2 minutes on this PC (target < 1% of one core) and write the figure in the commit message → commit "Dashboard: process sampler".

### Task 6: Stall classifier

**Files:** Create `global/dashboard/lib/stall.mjs`; Test `tests/dashboard/stall.test.mjs`.

**Interfaces:**
- Produces: `classify(input, thresholds): {state:'working'|'waiting'|'idle'|'stuck'|'gone', evidence:string|null, hint:string|null, since:number|null}`
  where `input = {kind:'session'|'subagent', status, alive, signals:TranscriptSignals, cpuPct:number|null, outputIdleMs:number|null, finished:boolean|null, now}`.
- Rules as the spec's stall table. Evidence strings use this exact shape: `<command or tool> running <N> min · <cpu>% CPU · no output for <M> min`; `Last reply was an API error <N> min ago`; `Permission prompt open for <N> min in a terminal`; `Not marked finished · transcript unchanged for <N> min`; `No activity for <N> min while busy`. Loop hint: `Repeated <command> <count>× in <window> min`.

- [x] **Step 1: Failing tests**: `busy build with CPU and no output for 60 min is working` (Review Focus 1), `tool pending, 0% CPU, no output 31 min is stuck with evidence 'pytest running 52 min · 0% CPU · no output for 31 min'`, `api error last entry 6 min ago is stuck`, `waiting 10 min is waiting with permission evidence`, `subagent not finished and stale 48 min is stuck`, `dead pid with pending tool is gone`, `idle status is idle`, `loop gives hint but stays working`.
- [x] Steps 2–5: run (FAIL), implement, run (PASS), commit "Dashboard: stall classifier".

### Task 7: Work log helper and reader

**Files:** Create `global/dashboard/note.mjs`, `global/dashboard/lib/worklog.mjs`; Test `tests/dashboard/worklog.test.mjs`.

**Interfaces:**
- CLI: `node <dashHome>/note.mjs <verb> [args]` with verbs `start "<task>" [--plan <file> --task <n>] [--steps "a|b|c"]`, `step <n> <todo|doing|done|waiting|dropped>`, `done`, `drop "<reason>"`. Session id from `CLAUDE_CODE_SESSION_ID`; project from `projectRoot(cwd)`. Appends one JSON line `{v:1, at, session, verb, ...}` to `<dashHome>/worklog/<project-slug>.jsonl`, where `project-slug` is the root path with non-`[A-Za-z0-9]` → `-`. Prints nothing; exit 0 even on error (errors to `<dashHome>/note.log`).
- Produces: `readWorklog(projectRoot): Epic[]` (one epic per `start`; steps as tasks; a task with no steps is a single-task epic).

- [x] Steps: failing tests `start then steps then done yields a done epic with three done tasks`, `step status changes keep latest`, `missing session id still writes with session null`, `cli never exits non-zero` → implement → pass → commit "Dashboard: work log".

### Task 8: Tree sources: plans, BMAD, Inbox checklists

**Files:** Create `global/dashboard/lib/sources/plans.mjs`, `.../bmad.mjs`, `.../inbox.mjs`; Tests `tests/dashboard/sources.test.mjs`.

**Interfaces:**
- Shared types (export from `lib/types.mjs` as JSDoc): `Epic = {id, source:'worklog'|'plan'|'bmad'|'inbox', title, file:string|null, tasks:Task[]}`; `Task = {id, n:number|null, title, status:'done'|'doing'|'next'|'waiting', size:string|null, sessionId:string|null, startedMs:number|null, doneMs:number|null, ticked:{done:number,total:number}|null}`.
- `readPlans(root): Epic[]`: `docs/superpowers/plans/*.md`; title from `# ` line; tasks from `### Task N: <title>`; optional trailing `[S]`/`[M]`/`[L]` → `size`; `ticked` from `- [x]`/`- [ ]` under each task.
- `readBmad(root): Epic[]`: only when `<root>/_bmad/` exists. Runs `python <claudeHome>/skills/bmad-ticket/scripts/tickets.py --project-root <root> status` (fallback `uv run …`), parses its JSON; map `state` planned/backlog → next, in-progress → doing, in-review → doing, done → done, dropped → hidden. Cache by mtime of `_bmad/` and the output folder; timeout 10 s; on any failure return `[]` and log. Capture a real output once (run it on the skill's own `scripts/tests` fixture tree) as `tests/dashboard/fixtures/bmad-status.json` and parse that in the test.
- `readInbox(root): Epic[]`: find the Plannotator project whose `project.json` root equals `root`; read `steps.jsonl` (latest record per `thread_id`+`agent.session`) and thread subjects from `messages.jsonl`. Step status `waiting` → `waiting`, `dropped` → hidden, `doing` → doing, `done` → done, `todo` → next; `sessionId` from `agent.session`.

- [x] Steps: failing tests `plan headings become tasks with size`, `ticked steps counted`, `bmad fixture maps states`, `bmad missing python returns []`, `inbox latest checklist per thread wins`, `inbox dropped steps hidden` → implement → pass → commit "Dashboard: plan, BMAD and Inbox sources".

### Task 9: Status, git matching, links, time and effort

**Files:** Create `global/dashboard/lib/git.mjs`, `global/dashboard/lib/tree.mjs`; Test `tests/dashboard/tree.test.mjs` (uses temp git repos).

**Interfaces:**
- `readCommits(root, sinceMs): {sha, ms, message, files:string[]}[]` via `git log --since --name-only --format=...`.
- `buildTree(root, {worklog, plans, bmad, inbox, commits, sessions, events}): {epics:Epic[], left:{count, hours:number|null}, spentMin:number}`.
- Merge rule: a work-log epic that names `--plan <file>` replaces that plan's epic's status for the tasks it names; otherwise work log wins on equal titles; sources otherwise listed side by side.
- Commit ↔ task: per the spec's "Calls made" (message names `Task N` **and** plan unambiguous: message names the plan file stem, or the committing session linked to that plan, or exactly one unfinished plan in the repo).
- Link order: work-log entry → Inbox checklist session → `events.jsonl` plan touch + latest `taskRefs` → none.
- Time spent: sum of linked activity minutes, idle gaps over `idleGap` excluded. Effort hours: median spent of ≥ 3 finished tasks × unfinished count, else `null`.

- [x] Steps: failing tests `'Task 1 done' with two plans each having Task 1 ticks neither` (Review Focus 4), `commit naming plan stem ticks that task`, `only one unfinished plan makes Task N unambiguous`, `work log overrides plan status`, `effort hours null under three finished tasks`, `idle gaps excluded from time` → implement → pass → commit "Dashboard: task status and links".

### Task 10: Status-line tap and usage

**Files:** Create `global/dashboard/statusline-tap.mjs`, `global/dashboard/lib/usage.mjs`; Test `tests/dashboard/usage.test.mjs`.

**Interfaces:**
- Tap: reads all stdin; if it has `rate_limits`, writes `{at, five_hour, seven_day}` to `<dashHome>/usage.json` (atomic: write temp, rename); then reads `<dashHome>/statusline-original.json` (`{command, ...}` or `null`) and, if a command exists, runs it through the shell with the same stdin, printing its stdout unchanged and exiting with its code. No original → print nothing, exit 0. Any tap error still runs the original.
- `readUsage(now): {fiveHour:{pct, resetsAt}|null, week:{pct, resetsAt}|null, stale:boolean}`; a window whose `resets_at` has passed is `null`.

- [x] Steps: failing tests `tap passes stdin to original and echoes its output byte-for-byte`, `tap with no original prints nothing`, `tap writes usage only when rate_limits present`, `tap with failing usage write still runs original`, `expired window reads null` → implement → pass → commit "Dashboard: status-line tap and usage".

### Task 11: Model, server, launcher, plan hook

**Files:** Create `global/dashboard/lib/model.mjs`, `global/dashboard/server.mjs`, `global/dashboard/launcher.mjs`, `global/dashboard/plan-hook.mjs`; Tests `tests/dashboard/server.test.mjs`, `tests/dashboard/launcher.test.mjs`.

**Interfaces:**
- `buildModel(now): Model` = `{generatedAt, usage, counts:{stuck, waiting, working, next}, projects:[{root, name, state, open:boolean, sessions:[{...SessionInfo, state, evidence, hint, life:number[60], tokens, linkedTask, subagents:[...]}], tree, quietSince}]}`; projects ordered stuck → waiting → working → others by last activity.
- Server: `GET /` page (token injected as `<meta name="dash-token">`), `GET /app.js`, `/app.css`, `/fonts/*`, `GET /events` (SSE; full model on connect, then on change, at most every 1 s), `POST /stop` (requires header `X-Dash-Token`, Host `127.0.0.1:<port>` or `localhost:<port>`, Origin same; else 403). Rebuild on `fs.watch` of the sources plus a 5 s tick. Auto-stop after `autoStop` minutes with no live session. Writes `<dashHome>/server.json` `{pid, port, startedAt}`.
- Launcher (`SessionStart` hook): connect to the port; if refused, spawn `node server.mjs` detached with `windowsHide`, `stdio:'ignore'`, `unref()`. Total time capped at 300 ms; prints nothing; always exit 0.
- Plan hook (`PostToolUse`, matcher `Read|Edit|Write`): reads hook JSON on stdin; when `tool_input.file_path` is a plan or BMAD ticket file, appends `{session, file, at}` to `<dashHome>/events.jsonl`. Prints nothing; always exit 0.

- [x] **Step 1: Failing tests**: `second server on same port exits 0 without binding`, `stop without token is 403`, `stop with token ends the process`, `events stream sends model on connect`, `launcher exits 0 within 300 ms when server cannot start` (Review Focus 5: point it at a bad server path), `plan hook ignores non-plan files`.
- [x] Steps 2–5: run (FAIL), implement, run (PASS), commit "Dashboard: model, server, launcher, plan hook".

### Task 12: The page

**Files:** Create `global/dashboard/page/index.html`, `page/app.js`, `page/app.css`, `page/fonts/InstrumentSans-*.woff2`, `page/fonts/GeistMono-*.woff2`, `page/fonts/OFL-InstrumentSans.txt`, `page/fonts/OFL-GeistMono.txt`; Test `tests/dashboard/page.test.mjs` (pure render helpers only).

**Interfaces:**
- Consumes the `Model` over SSE from `/events`.
- `app.js` exports for tests (via `globalThis.__dash` when `?test=1`): `detailText(item): string`, `formatDuration(ms): string`, `lifePath(minutes:number[60]): string`.
- Port the mockup's look, tokens and behaviour exactly: Calm palette (light: page `#c5d2e3`, cards `#e8ecf1`; dark: `#0d1117`), project panels view plus **Sessions** and **Triage** tabs, count pills that filter, Auto/Light/Dark toggle in `localStorage` key `dash-mode`, `?` tour (steps as in the mockup), hover details on task/epic/session/subagent/project only (650 ms still-mouse delay, hide on >8 px move, placed beside the panel), session ↔ task link and highlight, "New" badge until hover, fixed-width "updated Ns ago", usage meters with both reset times, "Usage not available" when null, "No plan found" for empty trees, finished epics folded, "Done earlier (n)" + "Show all history", quiet projects as one line each.
- `detailText` templates, one plain paragraph each: task (`<title>. <who is on it and for how long | Not started | Done in <time>>. <state reason if stuck/waiting>`), session (`A Claude Code window in <project>, <state phrase>. <evidence if any>. <n> helpers running, <m> finished. <tokens today>`), subagent, epic (`<n> of <m> tasks done, <time> spent.`), project.
- Fonts: download the woff2 files and licences from the fonts' official repositories; no network use at runtime.

- [x] Steps: failing tests `formatDuration`, `lifePath flat when all zero`, `detailText for a stuck task includes its evidence` → implement page → pass. **Then verify in a browser** (Playwright against a server started on a fixtures home): light, dark, each tab, tour, hover, Stop. Commit "Dashboard: page".

### Task 13: Installer component

**Files:**
- Modify: `install.ps1` (component map, `$about`, settings section, `-Remove`), Create: `global/commands/dashboard.md`, `global/rules/dashboard.md`
- Test: `tests/install.tests.ps1` (new cases)

**Interfaces:**
- Component `Dashboard` = every file under `global/dashboard/` (excluding none), plus `commands/dashboard.md`, `rules/dashboard.md`. `$about.Dashboard` = 'a live page of all Claude Code work on this computer: sessions, stalls, plans and usage (needs Node.js)'.
- Settings when installed: `SessionStart` hook `node "<claude>/dashboard/launcher.mjs"`; `PostToolUse` hook with `matcher: "Read|Edit|Write"` running `node "<claude>/dashboard/plan-hook.mjs"`; both merged like Rigor's and found again by script file name. Status line: if the user-level `statusLine` is not already the tap, save the whole object (or `null`) to `<claude>/dashboard/statusline-original.json` and set `statusLine` to `{type:'command', command:'node "<claude>/dashboard/statusline-tap.mjs"', padding:<original padding if any>}`.
- On a rerun, a `statusLine` that is no longer the tap (another tool rewrote it) is not re-wrapped silently: `Miss`
  says usage is unavailable and how to re-wrap it (`-Replace statusLine`).
- Start menu shortcut `Claude Dashboard.lnk` in `[Environment]::GetFolderPath('Programs')` → Node's absolute path with argument `"<claude>/dashboard/launcher.mjs" --open`; skipped under `-SkipToolCheck`. `launcher.mjs --open` also opens `http://127.0.0.1:<port>/` with the opener if present, else the default browser.
- `-Remove` accepts `Dashboard` too: hooks removed, status line restored from the saved original only if the current value is still the tap (else `Miss` naming it), shortcut deleted, files retired as `*.retired`; same conflict rule as Rigor (in both `-Components` and `-Remove` → error).
- `/dashboard` command text: starts the server via the launcher with `--open` and replies with the URL.
- **Rule file text needs the owner's sign-off before it is installed anywhere:** draft `global/rules/dashboard.md` (record every task with `note.mjs` — start, steps, status changes, done; mirror any Inbox checklist there; tick plan tasks you finish), send it to the owner in the Inbox thread, and wait for Approve.

- [x] **Step 1: Failing tests**: `DashboardInstallAddsHooksOnce`, `DashboardWrapsNoStatusLine` (no original → saved `null`, tap set), `DashboardWrapsObjectStatusLineKeepsPadding`, `DashboardRemoveRestoresOriginalStatusLine` (Review Focus 3), `DashboardRemoveLeavesChangedStatusLine` (exit 3, `Miss` mentions statusLine), `DashboardRerunReportsRewrittenStatusLine`, `DashboardInBothComponentsAndRemoveErrors`, `FreshInstallAllCoversEveryGlobalFile` still passes with Dashboard in the list.
- [x] Steps 2–4: run (FAIL), implement, run `pwsh -NoProfile -File tests/run.ps1` → `0 failed`.
- [x] **Step 5:** owner sign-off on `rules/dashboard.md` (Inbox). **Step 6: Commit** "Installer: Dashboard component".

### Task 14: Docs and decision

**Files:** Modify `README.md` (component table row, `-Remove` text), `docs/setup-guide.html`, `docs/setup-prompt.md`, `docs/decisions.md` (entry 31: what shipped, any deviations from the design and why).

- [x] Steps: write → `pwsh -NoProfile -File tools/check-personal.ps1` exit 0 → `pwsh -NoProfile -File tests/run.ps1` → `0 failed` → commit "Docs: Dashboard component".

### Task 15: Live check on this machine

- [x] **Step 1:** `./install.ps1 -Owner` (owner's machine), start a new Claude Code session, confirm the server started (`<claude>/dashboard/server.json`) and the page loads.
- [x] **Step 2:** Check against reality: every open session listed with the right state; this repo's plan shows as an epic; a `sleep`-style long command stays Working; usage meters show numbers after a reply; status line looks exactly as before.
- [x] **Step 3:** Record what was measured (sampler CPU, page update latency) in `docs/decisions.md` entry 31, then send the end-of-run report to the Inbox thread.
