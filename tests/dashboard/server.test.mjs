import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../../global/dashboard/server.mjs', import.meta.url));

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}

// A fake home with config.json on a free port and a stub page folder (the real page arrives in Task 12).
async function makeHome(config = {}) {
  const base = mkdtempSync(join(tmpdir(), 'cvr-server-'));
  const claude = join(base, 'claude');
  const dash = join(claude, 'dashboard');
  const page = join(base, 'page');
  mkdirSync(dash, { recursive: true });
  mkdirSync(join(claude, 'sessions'), { recursive: true });
  mkdirSync(join(claude, 'projects'), { recursive: true });
  mkdirSync(join(page, 'fonts'), { recursive: true });
  writeFileSync(join(page, 'index.html'), '<!doctype html><head><!--DASH_TOKEN--></head><body>stub</body>');
  writeFileSync(join(page, 'app.js'), 'console.log(1)');
  writeFileSync(join(page, 'render.mjs'), 'export const x = 1;');
  writeFileSync(join(page, 'fonts', 'Inter.woff2'), 'font');
  writeFileSync(join(base, 'secret.txt'), 'nope');
  const port = await freePort();
  writeFileSync(join(dash, 'config.json'), JSON.stringify({ port, ...config }));
  const env = {
    ...process.env, CVR_DASH_CLAUDE_HOME: claude, CVR_DASH_PLANNOTATOR_HOME: join(base, 'plannotator'),
    CVR_DASH_PAGE_DIR: page, CVR_DASH_SAMPLER: 'off',
  };
  delete env.CVR_DASH_PORT;
  return { base, dash, port, env };
}

function startServer(home) {
  const child = spawn(process.execPath, [SERVER], { env: home.env, stdio: 'ignore', windowsHide: true });
  const exited = new Promise((res) => child.once('exit', (code) => res(code)));
  return { child, exited };
}

async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* not yet */ }
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const serverJson = (home) => JSON.parse(readFileSync(join(home.dash, 'server.json'), 'utf8'));

function http(port, { method = 'GET', path = '/', headers = {} } = {}) {
  return new Promise((res, rej) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (r) => {
      let body = '';
      r.setEncoding('utf8');
      r.on('data', (d) => { body += d; });
      r.on('end', () => res({ status: r.statusCode, headers: r.headers, body }));
    });
    req.on('error', rej);
    req.end();
  });
}

async function withServer(fn, env = {}) {
  const home = await makeHome();
  Object.assign(home.env, env);
  const s = startServer(home);
  try {
    await waitFor(() => existsSync(join(home.dash, 'server.json')) && serverJson(home).pid === s.child.pid);
    await fn(home, s);
  } finally {
    try { s.child.kill(); } catch { /* gone */ }
    await Promise.race([s.exited, new Promise((r) => setTimeout(r, 2000))]);
    rmSync(home.base, { recursive: true, force: true });
  }
}

// Reads /events until done(events) is true; events are {event, data} ('message' when unnamed). Comments are skipped.
function sseUntil(port, done, ms = 8000) {
  return new Promise((res, rej) => {
    const events = [];
    const req = request({ host: '127.0.0.1', port, path: '/events', headers: { Host: `127.0.0.1:${port}` } }, (r) => {
      assert.equal(r.statusCode, 200);
      assert.match(r.headers['content-type'], /text\/event-stream/);
      let buf = '';
      r.setEncoding('utf8');
      r.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let event = 'message';
          const data = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data.push(line.slice(6));
          }
          if (data.length) events.push({ event, data: data.join('\n') });
        }
        if (done(events)) { req.destroy(); res(events); }
      });
    });
    req.on('error', rej);
    req.setTimeout(ms, () => { req.destroy(); rej(new Error(`no matching events: ${JSON.stringify(events).slice(0, 300)}`)); });
    req.end();
  });
}

const tokenOf = (html) => /<meta name="dash-token" content="([0-9a-f]+)">/.exec(html)?.[1];

test('second server on same port exits 0 without binding', async () => {
  await withServer(async (home, first) => {
    const second = startServer(home);
    try {
      const code = await Promise.race([second.exited, new Promise((r) => setTimeout(() => r('timeout'), 8000))]);
      assert.equal(code, 0);
      assert.equal(serverJson(home).pid, first.child.pid);
      assert.equal((await http(home.port)).status, 200);
    } finally { try { second.child.kill(); } catch { /* gone */ } }
  });
});

test('stop without token is 403', async () => {
  await withServer(async (home) => {
    const origin = `http://127.0.0.1:${home.port}`;
    assert.equal((await http(home.port, { method: 'POST', path: '/stop', headers: { Origin: origin } })).status, 403);
    assert.equal((await http(home.port, { method: 'POST', path: '/stop', headers: { Origin: origin, 'X-Dash-Token': 'ab' } })).status, 403);
    assert.equal((await http(home.port)).status, 200); // still running
  });
});

test('stop with wrong Origin is 403', async () => {
  await withServer(async (home) => {
    const token = tokenOf((await http(home.port)).body);
    assert.ok(token);
    for (const headers of [
      { 'X-Dash-Token': token, Origin: 'http://evil.example' },
      { 'X-Dash-Token': token }, // missing Origin
      { 'X-Dash-Token': token, Origin: `http://127.0.0.1:${home.port}`, Host: `evil.example:${home.port}` },
    ]) {
      assert.equal((await http(home.port, { method: 'POST', path: '/stop', headers })).status, 403, JSON.stringify(headers));
    }
    assert.equal((await http(home.port)).status, 200);
  });
});

test('stop with token ends the process', async () => {
  await withServer(async (home, s) => {
    const page = await http(home.port);
    const token = tokenOf(page.body);
    assert.ok(token, page.body);
    const r = await http(home.port, {
      method: 'POST', path: '/stop', headers: { 'X-Dash-Token': token, Origin: `http://127.0.0.1:${home.port}` },
    });
    assert.equal(r.status, 200);
    const code = await Promise.race([s.exited, new Promise((res) => setTimeout(() => res('timeout'), 5000))]);
    assert.equal(code, 0);
    assert.equal(existsSync(join(home.dash, 'server.json')), false);
  });
});

test('events stream sends model on connect', async () => {
  await withServer(async (home) => {
    const events = await sseUntil(home.port, (evs) => evs.some((e) => e.event === 'message'));
    const first = JSON.parse(events.find((e) => e.event === 'message').data);
    assert.deepEqual(first.counts, { stuck: 0, waiting: 0, working: 0, next: 0 });
    assert.ok(Array.isArray(first.projects));
    assert.ok(Number.isFinite(first.generatedAt));
  });
});

test('static files come only from the allow-list and Host must be local', async () => {
  await withServer(async (home) => {
    const page = await http(home.port);
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.body, /DASH_TOKEN/);
    assert.equal((await http(home.port, { path: '/app.js' })).status, 200);
    const mod = await http(home.port, { path: '/render.mjs' });
    assert.equal(mod.status, 200);
    assert.match(mod.headers['content-type'], /^text\/javascript/); // module scripts need a JavaScript type
    assert.equal((await http(home.port, { path: '/app.css' })).status, 404); // absent from the stub page
    assert.equal((await http(home.port, { path: '/fonts/Inter.woff2' })).status, 200);
    for (const path of ['/fonts/../app.js', '/fonts/%2e%2e%2fsecret.txt', '/../secret.txt', '/fonts/x.ttf', '/server.mjs']) {
      assert.equal((await http(home.port, { path })).status, 404, path);
    }
    assert.equal((await http(home.port, { headers: { Host: 'attacker.example' } })).status, 403);
    assert.equal((await http(home.port, { headers: { Host: `localhost:${home.port}` } })).status, 200);
  });
});

test('events stream sends a named hb event with the server time, repeatedly', async () => {
  await withServer(async (home) => {
    const t0 = Date.now();
    const events = await sseUntil(home.port, (evs) => evs.filter((e) => e.event === 'hb').length >= 3);
    const hbs = events.filter((e) => e.event === 'hb').map((e) => Number(e.data));
    for (const t of hbs) assert.ok(Number.isFinite(t) && t >= t0 - 1000 && t <= Date.now() + 1000, String(t));
    assert.ok(hbs[2] > hbs[0], 'later heartbeats carry later times');
  }, { CVR_DASH_HB_MS: '100' });
});

test('/events accepts GET only', async () => {
  await withServer(async (home) => {
    const r = await http(home.port, { method: 'POST', path: '/events' });
    assert.equal(r.status, 405);
  });
});

test('auto-stop with a fractional autoStop ends the server with no live session', async () => {
  const home = await makeHome({ thresholds: { autoStop: 0.01 } }); // 0.6 s
  const s = startServer(home);
  try {
    await waitFor(() => existsSync(join(home.dash, 'server.json')));
    const code = await Promise.race([s.exited, new Promise((r) => setTimeout(() => r('timeout'), 12000))]);
    assert.equal(code, 0);
    assert.equal(existsSync(join(home.dash, 'server.json')), false);
    assert.match(readFileSync(join(home.dash, 'server.log'), 'utf8'), /stopping: auto-stop: no live session/);
  } finally {
    try { s.child.kill(); } catch { /* gone */ }
    rmSync(home.base, { recursive: true, force: true });
  }
});

test('/compact serves the page with its token, like /', async () => {
  await withServer(async (home) => {
    const a = await http(home.port);
    const b = await http(home.port, { path: '/compact' });
    assert.equal(b.status, 200);
    assert.match(b.headers['content-type'], /text\/html/);
    assert.ok(tokenOf(b.body));
    assert.equal(tokenOf(b.body), tokenOf(a.body));
    assert.equal((await http(home.port, { path: '/compact/x' })).status, 404);
  });
});
