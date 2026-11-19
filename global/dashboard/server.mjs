// The dashboard server: one per machine, Node built-ins only. Binds 127.0.0.1 on the configured port (the
// port is the single-instance lock: a second start sees it taken and exits 0 without doing anything else),
// keeps the model in memory, and pushes it to the page over Server-Sent Events.
//
// Routes (every request must carry Host 127.0.0.1:<port> or localhost:<port>, else 403, which also blocks
// DNS-rebinding pages from reading the token or the model):
//   GET /             page/index.html with <!--DASH_TOKEN--> replaced by <meta name="dash-token" content="…">
//   GET /app.js, /render.mjs, /app.css, /fonts/<name>.woff2   fixed allow-list under page/ (raw path match)
//   GET /events       SSE: the full model on connect, then on change (at most once a second), heartbeat 25 s
//   POST /stop        needs X-Dash-Token (per-start random token) and Origin http://<that Host>; else 403
// Rebuilds: fs.watch (recursive) on <claudeHome>/sessions, <claudeHome>/projects, <dashHome> and
// <plannotatorHome>/inbox (when present), throttled: a rebuild starts 500 ms after the first event and at least
// 2 s after the previous rebuild started; plus a 5 s tick. SSE clients more than 4 MB behind are dropped. Auto-stops after `autoStop` minutes with no live session.
// Files (all under <dashHome>): server.json {pid, port, startedAt} while running; server.log, rotated to
// server.log.1 at 1 MB.
// Env: CVR_DASH_PORT overrides the port; CVR_DASH_PAGE_DIR the page folder (tests); CVR_DASH_SAMPLER=off
// replaces the pwsh CPU sampler with kill(0) liveness (tests).
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  readFileSync, writeFileSync, mkdirSync, statSync, renameSync, appendFileSync, unlinkSync, watch,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeHome, dashHome, plannotatorHome } from './lib/paths.mjs';
import { loadConfig } from './lib/config.mjs';
import { buildModel } from './lib/model.mjs';
import { startCpuSampler } from './lib/procs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE_DIR = process.env.CVR_DASH_PAGE_DIR || join(HERE, 'page');
const TICK_MS = 5000;
const WATCH_THROTTLE_MS = 500;
// Watch-triggered rebuilds start at least this far apart: active sessions write transcripts continuously, and
// back-to-back rebuilds cost ~29% of a core (measured 2026-11-19, see the task 11 fix report).
const WATCH_MIN_GAP_MS = 2000;
const MAX_BUFFERED = 4 * 1024 * 1024; // an SSE client this far behind is dropped
const PUSH_MIN_MS = 1000;
const HEARTBEAT_MS = 25000;
const LOG_MAX = 1024 * 1024;
const MAX_CLIENTS = 32;
const SLOW_BUILD_MS = 2000;
// Files the server itself (or a log writer) touches in <dashHome>: changes to them never trigger a rebuild.
const SELF_FILES = /^(server\.(json|log(\.1)?)|dashboard\.log|note\.log)$|\.tmp$/;
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; "
  + "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const home = dashHome();
const LOG = join(home, 'server.log');
const SERVER_JSON = join(home, 'server.json');

function log(msg) {
  try {
    mkdirSync(home, { recursive: true });
    try { if (statSync(LOG).size > LOG_MAX) renameSync(LOG, LOG + '.1'); } catch { /* no log yet */ }
    appendFileSync(LOG, `${new Date().toISOString()} ${String(msg).replace(/\s+/g, ' ').slice(0, 500)}\n`);
  } catch { /* logging must never throw */ }
}

function envPort() {
  const n = Number(process.env.CVR_DASH_PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

const port = envPort() ?? loadConfig().port;
const token = randomBytes(32).toString('hex');
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const startedAt = Date.now();

let sampler = null;
let model = null;
let modelJson = null; // what clients get
let modelKey = null; // modelJson without generatedAt, for change detection
let pushedKey = null;
let lastPushAt = 0;
let pushTimer = null;
let building = false;
let queued = false;
let stopping = false;
let lastLiveAt = startedAt;
let lastBuildStart = 0;
let tick = null;
let heartbeat = null;
let watchTimer = null;
const clients = new Set();
const watchers = new Map();

// ---- model and push -------------------------------------------------------------------------------------------

function send(res, text) {
  try {
    res.write(text);
    if (res.writableLength > MAX_BUFFERED) drop(res); // not reading: stop buffering models for it
  } catch { drop(res); }
}
function drop(res) {
  clients.delete(res);
  try { res.end(); } catch { /* closed */ }
}

function push() {
  if (!modelJson || modelKey === pushedKey) return;
  const wait = lastPushAt + PUSH_MIN_MS - Date.now();
  if (wait > 0) {
    if (!pushTimer) pushTimer = setTimeout(() => { pushTimer = null; push(); }, wait);
    return;
  }
  pushedKey = modelKey;
  lastPushAt = Date.now();
  const payload = `data: ${modelJson}\n\n`;
  for (const c of [...clients]) send(c, payload);
}

function autoStopMs(th) {
  const m = Number(th?.autoStop);
  return Number.isFinite(m) && m > 0 ? m * 60000 : null; // 0 or less: never auto-stop
}

async function rebuild() {
  if (stopping) return;
  if (building) { queued = true; return; }
  building = true;
  try {
    const t0 = Date.now();
    lastBuildStart = t0;
    const config = loadConfig();
    const m = await buildModel(t0, { sampler, config });
    const ms = Date.now() - t0;
    const first = model === null;
    model = m;
    modelJson = JSON.stringify(m);
    modelKey = JSON.stringify({ ...m, generatedAt: 0 });
    if (first || ms > SLOW_BUILD_MS) {
      const sessions = m.projects.reduce((n, p) => n + p.sessions.length, 0);
      log(`${first ? 'first build' : 'slow build'}: ${m.projects.length} projects, ${sessions} sessions, ${m.live} live, ${ms} ms`);
    }
    if (m.error) log(m.error);
    const now = Date.now();
    if (m.live > 0) lastLiveAt = now;
    const limit = autoStopMs(config.thresholds);
    if (limit !== null && now - lastLiveAt >= limit) { shutdown('auto-stop: no live session'); return; }
    push();
  } catch (e) {
    log(`rebuild failed: ${e?.stack || e}`);
  } finally {
    building = false;
    if (queued && !stopping) { queued = false; setImmediate(rebuild); }
  }
}

// ---- watching -------------------------------------------------------------------------------------------------

function onWatch(dir, name) {
  if (dir === home && name && SELF_FILES.test(basename(String(name)))) return;
  if (watchTimer || stopping) return;
  const wait = Math.max(WATCH_THROTTLE_MS, lastBuildStart + WATCH_MIN_GAP_MS - Date.now());
  watchTimer = setTimeout(() => { watchTimer = null; rebuild(); }, wait);
}

function ensureWatchers() {
  const dirs = [join(claudeHome(), 'sessions'), join(claudeHome(), 'projects'), home, join(plannotatorHome(), 'inbox')];
  for (const dir of dirs) {
    if (watchers.has(dir)) continue;
    let w = null;
    for (const recursive of [true, false]) {
      try { w = watch(dir, { recursive, persistent: false }, (_ev, name) => onWatch(dir, name)); break; } catch { w = null; }
    }
    if (!w) continue; // missing folder: the tick tries again
    w.on('error', (e) => {
      log(`watch error on a source folder: ${e?.code || e?.message || e}`);
      try { w.close(); } catch { /* closed */ }
      watchers.delete(dir);
    });
    watchers.set(dir, w);
  }
}

// ---- HTTP -----------------------------------------------------------------------------------------------------

const BASE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };

function reply(res, status, body = '', type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': type, ...extra });
  res.end(body);
}

const STATIC = new Map([
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/render.mjs', ['render.mjs', 'text/javascript; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
]);

function serveFile(res, rel, type, transform) {
  let body;
  try { body = readFileSync(join(PAGE_DIR, rel)); } catch { reply(res, 404, 'Not found'); return; }
  if (transform) body = transform(body.toString('utf8'));
  reply(res, 200, body, type, transform ? { 'Content-Security-Policy': CSP } : {});
}

function tokenOk(given) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function onStop(req, res, host) {
  if (!tokenOk(req.headers['x-dash-token']) || req.headers.origin !== `http://${host}`) {
    reply(res, 403, 'Forbidden');
    return;
  }
  reply(res, 200, '{"ok":true}', 'application/json');
  res.on('finish', () => setImmediate(() => shutdown('stop requested from the page')));
}

function onEvents(req, res) {
  if (clients.size >= MAX_CLIENTS) { reply(res, 503, 'Too many clients'); return; }
  res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
  clients.add(res);
  const bye = () => drop(res);
  req.on('close', bye);
  res.on('error', bye);
  send(res, 'retry: 3000\n\n');
  if (modelJson) send(res, `data: ${modelJson}\n\n`);
}

function handle(req, res) {
  try {
    const host = req.headers.host;
    if (!allowedHosts.has(host)) { reply(res, 403, 'Forbidden'); return; }
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://${host}`) { reply(res, 403, 'Forbidden'); return; }
    const path = String(req.url || '').split('?')[0]; // raw path: no decoding, no dot-segment folding
    if (req.method === 'POST' && path === '/stop') { onStop(req, res, host); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { reply(res, 405, 'Method not allowed', undefined, { Allow: 'GET, HEAD' }); return; }
    if (path === '/events') {
      if (req.method !== 'GET') { reply(res, 405, 'Method not allowed', undefined, { Allow: 'GET' }); return; }
      onEvents(req, res);
      return;
    }
    if (path === '/' || path === '/index.html') {
      serveFile(res, 'index.html', 'text/html; charset=utf-8',
        (html) => html.replace('<!--DASH_TOKEN-->', `<meta name="dash-token" content="${token}">`));
      return;
    }
    const s = STATIC.get(path);
    if (s) { serveFile(res, s[0], s[1]); return; }
    const font = /^\/fonts\/([A-Za-z0-9_-][A-Za-z0-9._-]*\.woff2)$/.exec(path);
    if (font) { serveFile(res, join('fonts', font[1]), 'font/woff2'); return; }
    reply(res, 404, 'Not found');
  } catch (e) {
    log(`request failed: ${e?.message || e}`);
    try { reply(res, 500, 'Error'); } catch { /* gone */ }
  }
}

// ---- lifecycle ------------------------------------------------------------------------------------------------

function removeServerJson() {
  try {
    if (JSON.parse(readFileSync(SERVER_JSON, 'utf8')).pid === process.pid) unlinkSync(SERVER_JSON);
  } catch { /* not ours or gone */ }
}

function shutdown(why) {
  if (stopping) return;
  stopping = true;
  log(`stopping: ${why}`);
  clearInterval(tick);
  clearInterval(heartbeat);
  clearTimeout(watchTimer);
  clearTimeout(pushTimer);
  for (const w of watchers.values()) { try { w.close(); } catch { /* closed */ } }
  try { sampler?.stop(); } catch { /* gone */ }
  for (const c of [...clients]) drop(c);
  removeServerJson();
  server.close(() => process.exit(0));
  server.closeAllConnections?.();
  setTimeout(() => process.exit(0), 1000).unref();
}

const server = createServer(handle);
server.on('error', (e) => {
  if (e?.code === 'EADDRINUSE') { log(`port ${port} in use: another dashboard (or program) has it; exiting`); process.exit(0); }
  log(`server error: ${e?.code || e?.message || e}`);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => {
  try {
    mkdirSync(home, { recursive: true });
    const tmp = `${SERVER_JSON}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ pid: process.pid, port, startedAt }));
    renameSync(tmp, SERVER_JSON);
  } catch (e) { log(`could not write server.json: ${e?.message || e}`); }
  log(`listening on 127.0.0.1:${port} (pid ${process.pid})`);
  process.on('exit', removeServerJson);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
    try { process.on(sig, () => shutdown(sig)); } catch { /* not on this platform */ }
  }
  process.on('uncaughtException', (e) => log(`uncaught: ${e?.stack || e}`));
  process.on('unhandledRejection', (e) => log(`unhandled rejection: ${e?.stack || e}`));
  sampler = process.env.CVR_DASH_SAMPLER === 'off' ? null : startCpuSampler(15000);
  ensureWatchers();
  tick = setInterval(() => { ensureWatchers(); rebuild(); }, TICK_MS);
  heartbeat = setInterval(() => { for (const c of [...clients]) send(c, ': hb\n\n'); }, HEARTBEAT_MS);
  rebuild();
});
