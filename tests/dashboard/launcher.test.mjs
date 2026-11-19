import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DASH = fileURLToPath(new URL('../../global/dashboard/', import.meta.url));

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}

async function makeHome() {
  const base = mkdtempSync(join(tmpdir(), 'cvr-launch-'));
  const claude = join(base, 'claude');
  const dash = join(claude, 'dashboard');
  mkdirSync(dash, { recursive: true });
  const port = await freePort();
  writeFileSync(join(dash, 'config.json'), JSON.stringify({ port }));
  const env = { ...process.env, CVR_DASH_CLAUDE_HOME: claude, CVR_DASH_PLANNOTATOR_HOME: join(base, 'pn'), CVR_DASH_SAMPLER: 'off' };
  delete env.CVR_DASH_PORT;
  delete env.CVR_DASH_SERVER;
  return { base, claude, dash, port, env };
}

// Runs a script, feeding stdin; resolves {code, stdout, stderr, ms}.
function run(script, env, input = '') {
  return new Promise((res) => {
    const t0 = process.hrtime.bigint();
    const c = spawn(process.execPath, [join(DASH, script)], { env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
    c.on('exit', (code) => res({ code, stdout, stderr, ms: Number(process.hrtime.bigint() - t0) / 1e6 }));
    c.stdin.end(input);
  });
}

test('launcher exits 0 within 300 ms when server cannot start', async () => {
  const h = await makeHome();
  try {
    h.env.CVR_DASH_SERVER = join(h.base, 'no-such-server.mjs');
    await run('launcher.mjs', h.env); // warm the file cache: the cap is about the launcher, not a cold disk
    const r = await run('launcher.mjs', h.env);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
    assert.ok(r.ms < 300, `took ${Math.round(r.ms)} ms`);
  } finally { rmSync(h.base, { recursive: true, force: true }); }
});

test('launcher starts the server when the port is free, and not twice', async () => {
  const h = await makeHome();
  let pid = null;
  try {
    const r = await run('launcher.mjs', h.env);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    const file = join(h.dash, 'server.json');
    const end = Date.now() + 8000;
    while (!existsSync(file) && Date.now() < end) await new Promise((x) => setTimeout(x, 50));
    const info = JSON.parse(readFileSync(file, 'utf8'));
    pid = info.pid;
    assert.equal(info.port, h.port);
    // Second launch sees the port taken and leaves the running server alone.
    assert.equal((await run('launcher.mjs', h.env)).code, 0);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, pid);
    // Stop it the way the page does.
    const html = await new Promise((res, rej) => {
      request({ host: '127.0.0.1', port: h.port, path: '/', headers: { Host: `127.0.0.1:${h.port}` } }, (resp) => {
        let b = ''; resp.on('data', (d) => { b += d; }); resp.on('end', () => res(b));
      }).on('error', rej).end();
    });
    const token = /dash-token" content="([0-9a-f]+)"/.exec(html)?.[1] ?? 'none';
    await new Promise((res) => {
      request({ host: '127.0.0.1', port: h.port, method: 'POST', path: '/stop',
        headers: { Host: `127.0.0.1:${h.port}`, Origin: `http://127.0.0.1:${h.port}`, 'X-Dash-Token': token } },
      (resp) => { resp.resume(); resp.on('end', res); }).on('error', res).end();
    });
  } finally {
    if (pid) { try { process.kill(pid); } catch { /* already stopped */ } }
    await new Promise((x) => setTimeout(x, 300));
    rmSync(h.base, { recursive: true, force: true });
  }
});

test('plan hook ignores non-plan files', async () => {
  const h = await makeHome();
  try {
    for (const file_path of ['/work/app/src/index.js', '/work/app/docs/notes.md', '/work/app/docs/superpowers/plans/x.txt']) {
      const r = await run('plan-hook.mjs', h.env, JSON.stringify({ session_id: 's1', tool_name: 'Read', tool_input: { file_path } }));
      assert.equal(r.code, 0);
      assert.equal(r.stdout, '');
    }
    assert.equal((await run('plan-hook.mjs', h.env, 'not json')).code, 0);
    assert.equal((await run('plan-hook.mjs', h.env, '')).code, 0);
    assert.equal(existsSync(join(h.dash, 'events.jsonl')), false);
  } finally { rmSync(h.base, { recursive: true, force: true }); }
});

test('plan hook records plan and BMAD ticket files', async () => {
  const h = await makeHome();
  try {
    const files = ['\\work\\app\\docs\\superpowers\\plans\\2026-01-01-thing.md', '/work/app/_bmad-output/tickets/T-1.md'];
    for (const file_path of files) {
      const r = await run('plan-hook.mjs', h.env, JSON.stringify({ session_id: 's7', tool_name: 'Edit', tool_input: { file_path } }));
      assert.equal(r.code, 0);
      assert.equal(r.stdout, '');
    }
    const lines = readFileSync(join(h.dash, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => [l.session, l.file]), files.map((f) => ['s7', f]));
    for (const l of lines) assert.ok(Number.isFinite(Date.parse(l.at)) && /T.*Z$/.test(l.at));
  } finally { rmSync(h.base, { recursive: true, force: true }); }
});

test('launcher --open opens the page with the opener, silently', async () => {
  const h = await makeHome();
  // Something already answers on the port, so the launcher goes straight to opening the page.
  const srv = createServer((q, s) => s.end('ok'));
  await new Promise((res) => srv.listen(h.port, '127.0.0.1', res));
  try {
    const stub = join(h.base, 'opener.mjs');
    const out = join(h.base, 'opened.txt');
    writeFileSync(stub, "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.CVR_TEST_OPENED, process.argv.slice(2).join(' '));\n");
    h.env.CVR_DASH_OPENER = stub;
    h.env.CVR_TEST_OPENED = out;
    const r = await new Promise((res) => {
      const c = spawn(process.execPath, [join(DASH, 'launcher.mjs'), '--open'], { env: h.env, windowsHide: true });
      let all = '';
      c.stdout.on('data', (d) => { all += d; });
      c.stderr.on('data', (d) => { all += d; });
      c.on('exit', (code) => res({ code, all }));
      c.stdin.end();
    });
    assert.equal(r.code, 0);
    assert.equal(r.all, '');
    const end = Date.now() + 5000;
    while (!existsSync(out) && Date.now() < end) await new Promise((x) => setTimeout(x, 50));
    assert.equal(readFileSync(out, 'utf8'), `http://127.0.0.1:${h.port}/`);
  } finally {
    await new Promise((res) => srv.close(res));
    rmSync(h.base, { recursive: true, force: true });
  }
});

test('launcher without --open opens nothing', async () => {
  const h = await makeHome();
  const srv = createServer((q, s) => s.end('ok'));
  await new Promise((res) => srv.listen(h.port, '127.0.0.1', res));
  try {
    const stub = join(h.base, 'opener.mjs');
    const out = join(h.base, 'opened.txt');
    writeFileSync(stub, "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.CVR_TEST_OPENED, 'x');\n");
    h.env.CVR_DASH_OPENER = stub;
    h.env.CVR_TEST_OPENED = out;
    assert.equal((await run('launcher.mjs', h.env)).code, 0);
    await new Promise((x) => setTimeout(x, 500));
    assert.equal(existsSync(out), false);
  } finally {
    await new Promise((res) => srv.close(res));
    rmSync(h.base, { recursive: true, force: true });
  }
});

test('launcher copied without its lib folder still exits 0 silently', async () => {
  const h = await makeHome();
  const alone = mkdtempSync(join(tmpdir(), 'cvr-launch-alone-'));
  try {
    copyFileSync(join(DASH, 'launcher.mjs'), join(alone, 'launcher.mjs'));
    const r = await new Promise((res) => {
      const c = spawn(process.execPath, [join(alone, 'launcher.mjs')], { env: h.env, windowsHide: true });
      let out = '';
      c.stdout.on('data', (d) => { out += d; });
      c.stderr.on('data', (d) => { out += d; });
      c.on('exit', (code) => res({ code, out }));
      c.stdin.end();
    });
    assert.equal(r.code, 0);
    assert.equal(r.out, '');
  } finally {
    rmSync(alone, { recursive: true, force: true });
    rmSync(h.base, { recursive: true, force: true });
  }
});
