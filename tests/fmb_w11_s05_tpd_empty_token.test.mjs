// tests/fmb_w11_s05_tpd_empty_token.test.mjs
// Regression for daemon/tp-browserd.js: an *existing but empty* token file must
// not turn /rpc into an unauthenticated endpoint. With a zero-length expected
// token, Buffer length check passed and timingSafeEqual(empty, empty) === true,
// so any local process could drive the daemon without a token.
//
// Zero dependencies, loopback only, temp HOME created with mkdtempSync(tmpdir()).
// The daemon is spawned as a child process so no real user data is touched.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DAEMON = fileURLToPath(new URL('../daemon/tp-browserd.js', import.meta.url));
const PRIMARY_PORT = 9772;
const ALT_PORT = 9774;
const START_TIMEOUT_MS = 20_000;

const tempRoot = mkdtempSync(join(tmpdir(), 'fmb-w11-s05-token-'));
const home = join(tempRoot, 'home');
const dataDir = join(home, '.local', 'share', 'ego-linux');
const tokenFile = join(dataDir, 'token');
const daemonJson = join(dataDir, 'daemon.json');

let child = null;
let port = 0;
let skipReason = null;
let childLog = '';

function portIsFree(p) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen(p, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

function request(p, method, pathname, token, payload) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? null : Buffer.from(JSON.stringify(payload));
    const headers = { host: `127.0.0.1:${p}` };
    if (body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = body.length;
    }
    if (token) headers['x-tp-token'] = token;
    const req = http.request({ host: '127.0.0.1', port: p, path: pathname, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { parsed = null; }
        resolve({ status: res.statusCode, body: parsed, text });
      });
    });
    req.setTimeout(3000, () => req.destroy(new Error('client timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

const rpc = (p, token, payload) => request(p, 'POST', '/rpc', token, payload);

before(async () => {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  // Reproduce the failure mode exactly: the token file exists but holds no value.
  writeFileSync(tokenFile, '', { mode: 0o600 });

  if (await portIsFree(PRIMARY_PORT)) port = PRIMARY_PORT;
  else if (await portIsFree(ALT_PORT)) port = ALT_PORT;
  if (!port) {
    skipReason = `127.0.0.1:${PRIMARY_PORT}/${ALT_PORT} already in use`;
    return;
  }

  const args = [DAEMON];
  const env = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, 'AppData', 'Local') };
  delete env.EGO_BROWSERD_PORT;
  if (port === ALT_PORT) { args.push('--alt-port'); env.EGO_BROWSERD_PORT = '9774'; }
  child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (c) => { childLog += String(c); });
  child.stderr.on('data', (c) => { childLog += String(c); });

  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    const exited = child.exitCode !== null || child.signalCode !== null;
    if (exited) {
      if (/EADDRINUSE/.test(childLog)) { skipReason = 'daemon port taken by another process'; return; }
      throw new Error(`daemon exited during startup (code ${child.exitCode}): ${childLog.slice(-500)}`);
    }
    try {
      const res = await request(port, 'GET', '/health');
      if (res.status === 200) {
        // Make sure the answering daemon really is our child (not a sibling test's).
        let info = null;
        try { info = JSON.parse(readFileSync(daemonJson, 'utf8')); } catch { info = null; }
        if (!info || info.pid !== child.pid) {
          skipReason = 'port is served by a different daemon instance';
          return;
        }
        return;
      }
    } catch {}
    if (Date.now() > deadline) throw new Error(`daemon never answered /health: ${childLog.slice(-500)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
});

after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await new Promise((r) => {
      const t = setTimeout(r, 2000);
      child.once('exit', () => { clearTimeout(t); r(); });
    });
  }
  rmSync(tempRoot, { recursive: true, force: true });
});

test('空的 token 檔不得讓未帶 token 的 /rpc 通過', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const res = await rpc(port, null, { method: 'space.list', params: {} });
  assert.equal(res.status, 403, `expected 403 auth failure, got ${res.status}: ${res.text}`);
  assert.equal(res.body?.ok, false);
  assert.equal(res.body?.error?.name, 'AuthError');
});

test('daemon 會把空的 token 檔重生為高強度 token', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const tok = readFileSync(tokenFile, 'utf8').trim();
  assert.match(tok, /^[0-9a-f]{32,}$/, `token file was not regenerated: ${JSON.stringify(tok.slice(0, 8))}`);
});

test('重生後的 token 可用；等長錯誤 token 與明顯假 token 一律拒絕', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const tok = readFileSync(tokenFile, 'utf8').trim();

  const good = await rpc(port, tok, { method: 'space.list', params: {} });
  assert.equal(good.status, 200, good.text);
  assert.equal(good.body?.ok, true);
  assert.deepEqual(good.body?.result, []);

  const sameLengthWrong = await rpc(port, '0'.repeat(tok.length), { method: 'space.list', params: {} });
  assert.equal(sameLengthWrong.status, 403);

  const fake = await rpc(port, 'FAKE_VALUE_FOR_TEST', { method: 'space.list', params: {} });
  assert.equal(fake.status, 403);
});
