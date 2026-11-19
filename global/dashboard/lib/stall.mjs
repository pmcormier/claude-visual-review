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
//  - Unknown CPU (null) never makes anything stuck by itself: the other signs must also be
//    quiet (no output growth, no transcript write), and evidence says "CPU unknown".
//    "0% CPU" means under 1% (rounds to 0).
//  - Hung tool, foreground: pending >= hungTool min, no output for >= hungTool min, low CPU.
//    With no outputFile there is no output signal, so "no output" is measured from tool start.
//  - Hung tool, background (outputFile set): such a job stays pending while it runs (a finished
//    one is cleared by its task-notification in transcripts.mjs), and a long job is normal,
//    so age is never a sign. Judged only on output idle (outputIdleMs; null means
//    unknown, so not judged) plus CPU, and only while the session is not idle (an idle
//    session's leftover background job is not a stall).
//  - Subagent "parent not waiting on it actively" is not visible here; the model layer handles it.
//  - Loop hint rides on any non-gone, non-idle result and never changes the state.

const MIN = 60000;
const mins = (ms) => Math.max(0, Math.floor(ms / MIN));
const cpuLow = (cpu) => cpu == null || cpu < 1;

function label(tool) {
  const first = typeof tool.command === 'string' ? tool.command.trim().split(/\s+/)[0] : '';
  return first || tool.name;
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
    const background = !!tool.outputFile;
    const ageMs = now - tool.startedMs;
    const judgeable = background ? (outputIdleMs != null && status !== 'idle') : true;
    if (judgeable) {
      const idleMs = background ? outputIdleMs : (outputIdleMs ?? ageMs);
      const old = background || ageMs >= th.hungTool * MIN;
      const noOutput = idleMs >= th.hungTool * MIN;
      const noLife = cpuPct == null ? quietMs >= th.hungTool * MIN : cpuLow(cpuPct);
      if (old && noOutput && noLife) {
        return result('stuck',
          `${label(tool)} running ${mins(ageMs)} min · ${cpuText} · no output for ${mins(idleMs)} min`,
          background ? now - idleMs : tool.startedMs, hint);
      }
    }
    // An idle session's leftover background job is not a stall: fall through to its status.
    if (!(background && status === 'idle')) return result('working', null, null, hint);
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
