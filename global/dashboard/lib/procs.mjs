// Process signs of life: per-process CPU and liveness (one long-lived pwsh sampler on Windows), and
// output-file growth. Writes nothing to disk. Never throws into the caller.
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARK = '#---sample---';
const START_TOLERANCE = 100000n; // 10 ms in FILETIME units
const RESTART_MS = 30000;

// CIM CreationDate is rounded to microseconds, hence the tolerance. Fixed text: only the interval varies.
// Property-restricted WQL and hand-built CSV lines (same header parseProcessTable reads) keep this cheap.
const psCommand = (ms) =>
  `$q='SELECT ProcessId,ParentProcessId,KernelModeTime,UserModeTime,CreationDate FROM Win32_Process';` +
  `$h='"ProcessId","ParentProcessId","KernelModeTime","UserModeTime","Created"';` +
  `while($true){$l=foreach($p in Get-CimInstance -Query $q){$c='';if($p.CreationDate){$c=$p.CreationDate.ToFileTimeUtc()};` +
  `'"{0}","{1}","{2}","{3}","{4}"' -f $p.ProcessId,$p.ParentProcessId,$p.KernelModeTime,$p.UserModeTime,$c};` +
  `[Console]::Out.Write($h+"
"+($l-join"
")+"
${MARK}
");[Console]::Out.Flush();Start-Sleep -Milliseconds ${ms}}`;

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

export function parseProcessTable(text) {
  if (typeof text !== 'string') return [];
  const lines = text.split(/\r?\n/).filter((l) => l !== '');
  if (!lines.length) return [];
  const head = splitCsvLine(lines[0]);
  const col = (n) => head.indexOf(n);
  const [ip, ipp, ik, iu, ic] = ['ProcessId', 'ParentProcessId', 'KernelModeTime', 'UserModeTime', 'Created'].map(col);
  if (ip < 0 || ipp < 0 || ik < 0 || iu < 0) return [];
  const out = [];
  for (const line of lines.slice(1)) {
    const f = splitCsvLine(line);
    const pid = Number(f[ip]);
    const ppid = Number(f[ipp]);
    const k = Number(f[ik]);
    const u = Number(f[iu]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isFinite(k) || !Number.isFinite(u) || f[ip] === '') continue;
    let created = null;
    if (ic >= 0 && /^\d+$/.test(f[ic] ?? '')) created = BigInt(f[ic]);
    out.push({ pid, ppid, cpuSeconds: (k + u) / 1e7, created });
  }
  return out;
}

// Pure holder of the latest two samples; the pwsh child (or a test) feeds it CSV text.
export function createSamplerState() {
  let prev = null; // { at, byPid: Map }
  let cur = null;
  return {
    ingest(csvText, nowMs = Date.now()) {
      const rows = parseProcessTable(csvText);
      if (!rows.length) return;
      prev = cur;
      cur = { at: nowMs, rows, byPid: new Map(rows.map((r) => [r.pid, r])) };
    },
    hasSample: () => cur !== null,
    descendants(pid) {
      if (!cur) return [];
      const root = cur.byPid.get(pid);
      if (!root) return [];
      const kids = new Map();
      for (const r of cur.rows) {
        if (r.pid === r.ppid) continue;
        if (!kids.has(r.ppid)) kids.set(r.ppid, []);
        kids.get(r.ppid).push(r);
      }
      const seen = new Set([pid]);
      const out = [];
      const stack = [root];
      while (stack.length) {
        const r = stack.pop();
        let cpuPct = null;
        const p = prev?.byPid.get(r.pid);
        const dt = prev ? (cur.at - prev.at) / 1000 : 0;
        if (p && dt > 0 && p.created === r.created) cpuPct = Math.max(0, ((r.cpuSeconds - p.cpuSeconds) / dt) * 100);
        out.push({ pid: r.pid, cpuPct });
        for (const c of kids.get(r.pid) ?? []) if (!seen.has(c.pid)) { seen.add(c.pid); stack.push(c); }
      }
      return out;
    },
    alive(pid, procStart) {
      const r = cur?.byPid.get(pid);
      if (!r) return false;
      let want = null;
      try { if (procStart !== undefined && procStart !== null && /^\d+$/.test(String(procStart))) want = BigInt(String(procStart)); } catch { want = null; }
      if (want === null || r.created === null) return true;
      const diff = r.created > want ? r.created - want : want - r.created;
      return diff <= START_TOLERANCE;
    },
  };
}

function killAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

export function startCpuSampler(intervalMs = 15000, { spawnFn = spawn, restartMs = RESTART_MS } = {}) {
  if (process.platform !== 'win32') {
    return {
      descendants: (pid) => (killAlive(pid) ? [{ pid, cpuPct: null }] : []),
      alive: (pid) => killAlive(pid),
      stop() {},
    };
  }
  const state = createSamplerState();
  const ms = Math.max(500, Math.floor(Number(intervalMs)) || 15000);
  const here = dirname(fileURLToPath(import.meta.url));
  let child = null;
  let timer = null;
  let stopped = false;
  let buf = '';

  const onExit = () => { try { child?.kill(); } catch { /* gone */ } };
  process.on('exit', onExit);

  function schedule() {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(start, restartMs);
    timer.unref?.();
  }
  function start() {
    if (stopped) return;
    buf = '';
    try {
      child = spawnFn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', psCommand(ms)], {
        cwd: here,
        env: { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch { child = null; schedule(); return; }
    const mine = child;
    mine.stdout?.setEncoding?.('utf8');
    mine.stdout?.on('data', (d) => {
      try {
        buf += d;
        let i;
        while ((i = buf.indexOf(MARK)) >= 0) {
          state.ingest(buf.slice(0, i), Date.now());
          buf = buf.slice(i + MARK.length).replace(/^\r?\n/, '');
        }
      } catch { buf = ''; }
    });
    mine.on('error', () => { if (child === mine) { child = null; schedule(); } });
    mine.on('exit', () => { if (child === mine) { child = null; schedule(); } });
    mine.unref?.();
  }
  start();

  return {
    descendants: (pid) => state.descendants(pid),
    alive: (pid, procStart) => (state.hasSample() ? state.alive(pid, procStart) : killAlive(pid)),
    stop() {
      stopped = true;
      clearTimeout(timer);
      process.off('exit', onExit);
      try { child?.kill(); } catch { /* gone */ }
      child = null;
    },
  };
}

const growth = new Map(); // path -> { size, grewAt }
export function outputGrowth(path, now = Date.now()) {
  let st;
  try { st = statSync(path); } catch { return { idleMs: null }; }
  const g = growth.get(path);
  if (!g) growth.set(path, { size: st.size, grewAt: st.mtimeMs });
  else if (st.size > g.size) { g.size = st.size; g.grewAt = now; } else if (st.size < g.size) { g.size = st.size; }
  return { idleMs: Math.max(0, now - growth.get(path).grewAt) };
}
