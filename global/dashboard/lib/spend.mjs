// Session spend: one small file per session under <dashHome>/spend/, written by the status-line tap from Claude
// Code's own status-line input (cost.total_cost_usd and the context-window token totals). Kept for a year, so a
// finished session still counts after Claude Code deletes its transcript (30 days by default). Never throws.
import { readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export const SPEND_KEEP_MS = 365 * 86400000;
const WEEK_MS = 7 * 86400000;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const norm = (p) => { const r = resolve(String(p)); return process.platform === 'win32' ? r.toLowerCase() : r; };

function readRecord(file) {
  try {
    const r = JSON.parse(readFileSync(file, 'utf8'));
    if (!r || typeof r.sessionId !== 'string' || typeof r.cwd !== 'string') return null;
    return {
      sessionId: r.sessionId, cwd: r.cwd, model: typeof r.model === 'string' ? r.model : null,
      costUsd: num(r.costUsd), tokensIn: num(r.tokensIn) ?? 0, tokensOut: num(r.tokensOut) ?? 0,
      firstAt: num(r.firstAt), at: num(r.at),
    };
  } catch { return null; } // unreadable record: skip it
}

/** @returns {Map<string, {sessionId, cwd, model, costUsd, tokensIn, tokensOut, firstAt, at}>} by session id */
export function readSpend(dir) {
  const out = new Map();
  let names;
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return out; }
  for (const n of names) { const r = readRecord(join(dir, n)); if (r) out.set(r.sessionId, r); }
  return out;
}

const caches = new Map(); // dir -> Map(name -> {mtimeMs, rec})
/** readSpend for the server's rebuild loop: stats every file but re-reads only those whose mtime changed. */
export function readSpendCached(dir) {
  const out = new Map();
  let names;
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { caches.delete(dir); return out; }
  const prev = caches.get(dir) ?? new Map();
  const next = new Map();
  for (const n of names) {
    const file = join(dir, n);
    let mtimeMs;
    try { mtimeMs = statSync(file).mtimeMs; } catch { continue; }
    const hit = prev.get(n);
    const rec = hit && hit.mtimeMs === mtimeMs ? hit.rec : readRecord(file);
    next.set(n, { mtimeMs, rec });
    if (rec) out.set(rec.sessionId, rec);
  }
  caches.set(dir, next);
  return out;
}

/**
 * One session's spend for the page: the status line's record when there is one (Claude Code's own cost), else
 * the transcript's token totals with no cost (a headless run has no status line).
 */
export function sessionSpend(rec, tokens) {
  if (rec) return { costUsd: rec.costUsd, tokensIn: rec.tokensIn, tokensOut: rec.tokensOut, source: 'statusline' };
  if (!tokens || typeof tokens !== 'object') return null;
  const n = (v) => num(v) ?? 0;
  return { costUsd: null, tokensIn: n(tokens.input) + n(tokens.cacheRead) + n(tokens.cacheCreate), tokensOut: n(tokens.output), source: 'transcript' };
}

/** Totals for one project: sessions whose cwd is the root or inside it. Week = records updated in the last 7 days. */
export function spendFor(records, root, now = Date.now()) {
  const out = { weekUsd: 0, totalUsd: 0, weekTokens: 0, sessions: 0 };
  let rk;
  try { rk = norm(root); } catch { return out; }
  const prefix = rk.endsWith(sep) ? rk : rk + sep;
  for (const r of records?.values?.() ?? []) {
    let k;
    try { k = norm(r.cwd); } catch { continue; }
    if (k !== rk && !k.startsWith(prefix)) continue;
    out.sessions += 1;
    out.totalUsd += r.costUsd ?? 0;
    if (r.at !== null && now - r.at <= WEEK_MS) {
      out.weekUsd += r.costUsd ?? 0;
      out.weekTokens += r.tokensIn + r.tokensOut;
    }
  }
  out.weekUsd = Math.round(out.weekUsd * 100) / 100;
  out.totalUsd = Math.round(out.totalUsd * 100) / 100;
  return out;
}

/** Deletes spend files not written for a year. */
export function pruneSpend(dir, now = Date.now()) {
  let names;
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    try { const p = join(dir, n); if (now - statSync(p).mtimeMs > SPEND_KEEP_MS) unlinkSync(p); } catch { /* skip */ }
  }
}
