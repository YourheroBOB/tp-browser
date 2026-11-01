// tests/fmb_w4_s05_tpd_http_guards.test.mjs
// Regression tests for daemon/tp-browserd.js HTTP edge cases:
//
//   1. CSRF: a page can fire a plain GET at 127.0.0.1 (e.g. <img src>) with no
//      Origin header, so the Origin/Host guard alone let any website reach the
//      unauthenticated /flush-and-close endpoint and close the agent browser.
//      Browser-initiated requests always carry Sec-Fetch-Site, so cross-site
//      ones must be rejected while curl/CLI (no Sec-Fetch-Site) keep working.
//   2. Oversized /rpc body used to `req.destroy()` with no response, so the
//      client saw an opaque ECONNRESET instead of a 413 with a JSON error.
//
// The daemon is spawned with HOME pointed at a temp dir and on the alternate
// port (9774/9775) so a default daemon on :9772 is never touched. Loopback only;
// no external service, no real credential (token is generated inside tmp HOME).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const daemonPath = fileURLToPath(new URL('../daemon/tp-browserd.js', import.meta.url));
const PORT = 9774; // --alt-port => daemon 9774 / chrome 9775
const HOME = mkdtempSync(join(tmpdir(), 'fmb-w4-s05-home-'));
const TOKEN_PATH = join(HOME, '.local', 'share', 'ego-linux', 'token');

let child = null;
let started = false;
let startupLog = '';

function httpCall({ method = 'GET', path, headers = {}, body = null, timeoutMs = 10_000 }) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: PORT, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('request timeout')));
    if (body != null) req.write(body);
    req.end();
  });
}

async function probeStatus(path, headers = {}, timeoutMs = 800) {
  try {
    const r = await httpCall({ path, headers, timeoutMs });
    return r.status;
  } catch {
    return null;
  }
}

// If something already answers on 9774 it is NOT ours: never touch it.
const occupiedBefore = (await probeStatus('/health', {}, 800)) !== null;

if (!occupiedBefore) {
  try {
    child = spawn(process.execPath, [daemonPath, '--alt-port'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME, USERPROFILE: HOME },
    });
  } catch (e) {
    startupLog += `spawn failed: ${String(e)}\n`;
  }
  if (child) {
    child.stdout.on('data', (c) => { startupLog += c; });
    child.stderr.on('data', (c) => { startupLog += c; });
    child.on('error', (e) => { startupLog += `child error: ${String(e)}\n`; });
    for (let i = 0; i < 100 && !started; i += 1) {
      if ((await probeStatus('/health', {}, 500)) === 200) {
        started = true;
        break;
      }
      if (child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

after(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill('SIGKILL');
    await exited;
  }
  rmSync(HOME, { recursive: true, force: true });
});

function skipReason() {
  if (occupiedBefore) return 'port 9774 is already in use by a foreign listener; refusing to interfere';
  if (!started) return `spawned daemon did not become ready: ${startupLog.slice(-400)}`;
  return null;
}

test('daemon: cross-site /flush-and-close is rejected instead of closing the browser', async (t) => {
  const why = skipReason();
  if (why) return t.skip(why);

  const r = await httpCall({ path: '/flush-and-close', headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(r.status, 403);
  assert.match(r.body, /forbidden/);
});

test('daemon: command-line and same-origin callers are still served', async (t) => {
  const why = skipReason();
  if (why) return t.skip(why);

  // curl in tp-stop.sh / ego-stop.ps1 sends no Sec-Fetch-Site at all.
  assert.equal((await httpCall({ path: '/health' })).status, 200);
  // Pages served by the daemon itself (and cross-site POST from our own origin).
  assert.equal((await httpCall({ path: '/health', headers: { 'sec-fetch-site': 'same-origin' } })).status, 200);
  assert.equal((await httpCall({ path: '/health', headers: { 'sec-fetch-site': 'none' } })).status, 200);
  // Browser-driven cross-site request is refused.
  assert.equal((await httpCall({ path: '/health', headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
});

test('daemon: Host header must stay on 127.0.0.1', async (t) => {
  const why = skipReason();
  if (why) return t.skip(why);

  const r = await httpCall({ path: '/health', headers: { host: 'evil.example' } });
  assert.equal(r.status, 403);
  assert.match(r.body, /forbidden/);
});

test('daemon: /rpc without a token is rejected before the body is read', async (t) => {
  const why = skipReason();
  if (why) return t.skip(why);

  const r = await httpCall({ method: 'POST', path: '/rpc', body: '{"method":"status"}' });
  assert.equal(r.status, 403);
  assert.equal(JSON.parse(r.body).ok, false);
});

test('daemon: /rpc answers 413 (not a socket reset) for an oversized body', async (t) => {
  const why = skipReason();
  if (why) return t.skip(why);

  assert.ok(existsSync(TOKEN_PATH), 'daemon should create its token inside the temp HOME');
  const token = readFileSync(TOKEN_PATH, 'utf8').trim();
  assert.ok(token.length > 0, 'token must not be empty');

  const big = 'x'.repeat(1_100_000);
  const r = await httpCall({
    method: 'POST',
    path: '/rpc',
    headers: { 'x-tp-token': token, 'content-type': 'text/plain', 'content-length': Buffer.byteLength(big) },
    body: big,
  });

  assert.equal(r.status, 413);
  const payload = JSON.parse(r.body);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.name, 'PayloadTooLarge');
});

test('daemon: a small /rpc body with a valid token still returns a JSON result', async (t) => {
  const why = skipReason();
  if (why) return t.skip(why);

  const token = readFileSync(TOKEN_PATH, 'utf8').trim();
  const body = JSON.stringify({ id: 7, method: 'status' });
  const r = await httpCall({
    method: 'POST',
    path: '/rpc',
    headers: { 'x-tp-token': token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    body,
  });

  assert.equal(r.status, 200);
  const payload = JSON.parse(r.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.id, 7);
  assert.equal(payload.result.chrome, false); // no Chrome attached in the test env
  assert.deepEqual(payload.result.spaces, []);
});
