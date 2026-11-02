// tests/fmb_w10_s05_tpd_bad_request_target.test.mjs
//
// 回歸測試：daemon/tp-browserd.js 的 HTTP handler 是
//     async (req, res) => { const url = new URL(req.url, 'http://127.0.0.1'); ... }
// `req.url` 完全由呼叫端控制。request-target 為 "//"（任何網頁用
// <img src="http://127.0.0.1:9772//"> 就會產生，curl `.../9772//` 亦然）
// 會讓 `new URL()` 丟出 ERR_INVALID_URL；在 async handler 裡這等於
// unhandled promise rejection → 整個 daemon 行程死亡，而且是在
// Host / Origin / Sec-Fetch-Site 守門員有機會回 403 之前就死。
//
// 測試做法：把 daemon/*.js 複製到 tmpdir()，只改寫固定的 PORT 一行成
// 臨時迴路埠，用假 HOME 啟動，送出原始 request line，要求：
//   1) 回 4xx；2) daemon 之後仍健康。
// 零對外網路、零真實憑證、只寫 tmpdir()。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const daemonDir = fileURLToPath(new URL('../daemon/', import.meta.url));
const daemonPath = join(daemonDir, 'tp-browserd.js');

const tempRoot = mkdtempSync(join(tmpdir(), 'fmb-w10-s05-tpd-'));
const fakeHome = join(tempRoot, 'home');
mkdirSync(fakeHome, { recursive: true });

let port = 0;
let child = null;
let childErr = '';

function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port: p } = srv.address();
      srv.close(() => resolve(p));
    });
  });
}

// daemon 的 PORT 是常數（9772 / --alt-port 9774），所以把 daemon/*.js 複製到
// tmpdir()，只改寫那一行成臨時埠，避免和其他測試搶固定埠。
function stageDaemonCopy(p) {
  const runDir = join(tempRoot, 'daemon');
  mkdirSync(runDir, { recursive: true });
  for (const name of readdirSync(daemonDir)) {
    if (name.endsWith('.js')) copyFileSync(join(daemonDir, name), join(runDir, name));
  }
  const src = readFileSync(daemonPath, 'utf8');
  const needle = 'const PORT = ALT_PORT ? 9774 : 9772;';
  assert.equal(src.split(needle).length - 1, 1, 'expected exactly one PORT declaration in daemon/tp-browserd.js');
  writeFileSync(join(runDir, 'tp-browserd.js'), src.split(needle).join(`const PORT = ${p};`), 'utf8');
  return join(runDir, 'tp-browserd.js');
}

function httpStatus(p, path) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: p, path, method: 'GET', timeout: 2000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.end();
  });
}

async function waitReady(p, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(`daemon exited during startup (code ${child.exitCode}): ${childErr}`);
    }
    const r = await httpStatus(p, '/health');
    if (r.status === 200) return JSON.parse(r.body);
    await new Promise((r2) => setTimeout(r2, 150));
  }
  throw new Error(`daemon on 127.0.0.1:${p} was not ready in ${timeoutMs}ms: ${childErr}`);
}

function rawRequest(p, payload, idleMs = 4000) {
  return new Promise((resolve) => {
    const sock = net.connect(p, '127.0.0.1');
    let out = '';
    let done = false;
    const finish = () => { if (done) return; done = true; sock.destroy(); resolve(out); };
    sock.setTimeout(idleMs, finish);
    sock.on('data', (d) => { out += d.toString('utf8'); });
    sock.on('end', finish);
    sock.on('close', finish);
    sock.on('error', finish);
    sock.on('connect', () => sock.write(payload));
  });
}

before(async () => {
  port = await freeLoopbackPort();
  const entry = stageDaemonCopy(port);
  child = spawn(process.execPath, [entry], {
    cwd: join(tempRoot, 'daemon'),
    env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, EGO_BROWSERD_PORT: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (d) => { childErr += d.toString('utf8'); });
  await waitReady(port);
});

after(() => {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  rmSync(tempRoot, { recursive: true, force: true });
});

test('tp-browserd 對 request-target "//" 回 400 且不崩潰', async () => {
  const healthBefore = await httpStatus(port, '/health');
  assert.equal(healthBefore.status, 200, 'baseline /health must work');

  const raw = await rawRequest(port, `GET // HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);

  assert.match(raw, /^HTTP\/1\.1 400 /, `expected "HTTP/1.1 400 ..." but got: ${JSON.stringify(raw.slice(0, 160))}`);
  assert.equal(child.exitCode, null, `daemon must survive the bad request (exited ${child.exitCode}): ${childErr}`);

  const healthAfter = await httpStatus(port, '/health');
  assert.equal(healthAfter.status, 200, 'daemon must keep serving /health after the malformed request');
});
