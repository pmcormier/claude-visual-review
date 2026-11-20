// Stall classifier: pure, no I/O. Judges a session or subagent by signs of life
// (CPU, output growth, transcript writes, Claude Code's own status), never by
// elapsed time alone, and always returns the evidence behind a "stuck" verdict.
//
// classify(input, thresholds) -> { state, evidence, hint, since }
//   state: 'working' | 'waiting' | 'idle' | 'stuck' | 'gone'
//   input: { kind: 'session'|'subagent', status: 'busy'|'idle'|'waiting'|'unknown'|null,
//            alive, signals (TranscriptSignals), cpuPct: number|null,
//            outputIdleMs: number|null, finished: true|false|null, now,
//            statusUpdatedAt?: ms }
//   thresholds in minutes (from loadConfig().thresholds).
//
// Precedence (first match wins):
//   gone > finished subagent (idle) > waiting > stuck(API error) > stuck(hung tool)
//   > stuck(quiet / subagent never reports) > idle > working.
//
// Judgment calls:
//  - Not alive: always 'gone'. Evidence names the pending tool if there was one, else null.
//  - Waiting: since = statusUpdatedAt, falling back to the transcript's last write when the
//    caller has no status timestamp. Evidence appears once waiting >= thresholds.waiting.
//  - cpuPct is the CPU of the processes the pending tool started (model.mjs, R22); with no tool pending the
//    caller passes null and the quiet rules rest on status busy + a quiet transcript + nothing running.
//  - Unknown CPU (null) never makes anything stuck by itself: the other signs must also be
//    quiet (no output growth, no transcript write), and evidence says "CPU unknown".
//    "0% CPU" means under 0.5%, so evidence never reads "1% CPU" when stuck (rounds to 0).
//  - Hung tool, foreground: pending >= hungTool min, no output for >= hungTool min, low CPU.
//    With no outputFile output is never observed, so "no output" is measured from the
//    transcript's last write (null lastWriteMs: never judged). Known outputIdleMs is clamped to
//    the tool's age. Agent/Task calls are never judged here (their subagent is classified
//    separately). An idle session does not judge a pending tool at all.
//  - Hung tool, background (outputFile set): such a job stays pending while it runs (a finished
//    one is cleared by its task-notification in transcripts.mjs), and a long job is normal,
//    so age is never a sign. Judged only on output idle (outputIdleMs; null means
//    unknown, so not judged) plus CPU, and only while the session is not idle (an idle
//    session's leftover background job is not a stall).
//  - Subagent "parent not waiting on it actively" is not visible here; the model layer handles it.
//  - Loop hint rides on any non-gone, non-idle result and never changes the state.
//  - A tool is named by Claude's own description of the call when it has one (quoted), else by the command's first
//    word. A background job's stuck evidence says it is still running and may be waiting on something outside
//    (owner's review 2026-11-19: the verdict stays, the words are gentler).

const MIN = 60000;
const mins = (ms) => Math.max(0, Math.floor(ms / MIN));
const cpuLow = (cpu) => cpu == null || cpu < 0.5; // same rule as Math.round(cpu) === 0

function label(tool) {
  if (typeof tool.description === 'string' && tool.description.trim()) return `"${tool.description.trim()}"`;
  const first = typeof tool.command === 'string' ? tool.command.trim().split(/\s+/)[0] : '';
  return first || tool.name;
}

const clip120 = (s) => { const t = String(s ?? '').trim(); return t.length > 120 ? t.slice(0, 119) + '\u2026' : t; };

/**
 * Waiting on you whenever Claude asks (spec 2026-11-19 needs-you). Stuck, gone and waiting are returned unchanged.
 * A pending AskUserQuestion waits (whatever the status). An idle session waits on a question it left in the terminal
 * (signals.lastAsk) or an open Inbox question it asked (inboxQ: {prompt, askedMs}). A working session with an open
 * Inbox question keeps working; its hint names the question.
 */
export function askedOwner(v, signals, inboxQ) {
  if (!v || v.state === 'stuck' || v.state === 'gone' || v.state === 'waiting') return v;
  const tool = signals?.pendingTool;
  if (tool?.name === 'AskUserQuestion') {
    return { ...v, state: 'waiting', evidence: `Asked: ${clip120(tool.description || 'a question in the terminal')}`, since: tool.startedMs ?? null };
  }
  if (v.state === 'idle' && signals?.lastAsk?.text) {
    return { ...v, state: 'waiting', evidence: `Asked: ${clip120(signals.lastAsk.text)}`, since: signals.lastAsk.ms ?? null };
  }
  if (v.state === 'idle' && inboxQ?.prompt) {
    return { ...v, state: 'waiting', evidence: `Inbox: ${clip120(inboxQ.prompt)}`, since: inboxQ.askedMs ?? null };
  }
  if (v.state === 'working' && inboxQ?.prompt && !v.hint) return { ...v, hint: `Inbox question open: ${clip120(inboxQ.prompt)}` };
  return v;
}

export function classify(input, thresholds) {
  const { kind, status, alive, signals, cpuPct, outputIdleMs, finished, now } = input;
  const th = thresholds;
  const tool = signals.pendingTool;
  const result = (state, evidence = null, since = null, hint = null) => ({ state, evidence, hint, since });

  if (!alive) {
    return result('gone', tool ? `${label(tool)} was still running when the process ended` : null,
      tool ? tool.startedMs : signals.lastWriteMs ?? null);
  }

  if (kind === 'subagent' && finished === true) return result('idle', null, signals.lastWriteMs ?? null);

  const rep = signals.repeat;
  const hint = rep && rep.count >= th.loopCount ? `Repeated ${rep.command} ${rep.count}× in ${th.loopWindow} min` : null;

  if (status === 'waiting') {
    const since = input.statusUpdatedAt ?? signals.lastWriteMs ?? null;
    const m = since == null ? 0 : mins(now - since);
    return result('waiting', m >= th.waiting ? `Permission prompt open for ${m} min in a terminal` : null, since, hint);
  }

  if (signals.lastEntryIsApiError && signals.lastEntryMs != null) {
    const m = mins(now - signals.lastEntryMs);
    if (m >= th.apiError) return result('stuck', `Last reply was an API error ${m} min ago`, signals.lastEntryMs, hint);
  }

  const cpuText = cpuPct == null ? 'CPU unknown' : `${Math.round(cpuPct)}% CPU`;
  const quietMs = signals.lastWriteMs == null ? 0 : now - signals.lastWriteMs;

  if (tool) {
    // A subagent call is judged through its own transcript, never here.
    if (tool.name === 'Agent' || tool.name === 'Task') return result('working', null, null, hint);
    // An idle session's leftover tool is not a stall: fall through to its status.
    if (status !== 'idle') {
      const background = !!tool.outputFile;
      const ageMs = now - tool.startedMs;
      // Output idle time: observed (outputIdleMs) when there is an output file; otherwise the
      // best proxy is the transcript's last write. Never measured -> never judged.
      const rawIdle = background ? outputIdleMs
        : (outputIdleMs ?? (signals.lastWriteMs == null ? null : quietMs));
      if (rawIdle != null) {
        const idleMs = Math.min(rawIdle, ageMs);
        const old = background || ageMs >= th.hungTool * MIN;
        const noOutput = idleMs >= th.hungTool * MIN;
        const noLife = cpuPct == null ? quietMs >= th.hungTool * MIN : cpuLow(cpuPct);
        // A session still writing its transcript is never stuck on a tool (R27); lastWriteMs null: never judged.
        const transcriptQuiet = signals.lastWriteMs != null && quietMs >= th.hungTool * MIN;
        if (old && noOutput && noLife && transcriptQuiet) {
          const described = typeof tool.description === 'string' && tool.description.trim();
          return result('stuck',
            background && described
              ? `Background job quiet for ${mins(idleMs)} min, still running: ${tool.description.trim()}. It may be waiting on something outside, such as a CI run or a download.`
              : `${label(tool)} running ${mins(ageMs)} min · ${cpuText} · no output for ${mins(idleMs)} min`,
            background ? now - idleMs : tool.startedMs, hint);
        }
      }
      return result('working', null, null, hint);
    }
  }

  if (kind === 'subagent') {
    if (quietMs >= th.subagentQuiet * MIN && cpuLow(cpuPct)) {
      return result('stuck', `Not marked finished · transcript unchanged for ${mins(quietMs)} min`, signals.lastWriteMs, hint);
    }
    return result('working', null, null, hint);
  }

  if (status === 'busy') {
    if (quietMs >= th.quiet * MIN && cpuLow(cpuPct)) {
      return result('stuck', `No activity for ${mins(quietMs)} min while busy`, signals.lastWriteMs, hint);
    }
    return result('working', null, null, hint);
  }

  if (status === 'idle') return result('idle', null, signals.lastWriteMs ?? null);

  // 'unknown' status: working only while the transcript is still moving.
  if (quietMs < th.quiet * MIN) return result('working', null, null, hint);
  return result('idle', null, signals.lastWriteMs ?? null);
}
