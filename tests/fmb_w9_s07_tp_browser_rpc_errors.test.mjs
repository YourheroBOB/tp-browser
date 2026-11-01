// tests/fmb_w9_s07_tp_browser_rpc_errors.test.mjs
// 迴歸測試（波次 w9／子任務 s07）：
//   `tp-browser spaces` 在 daemon /rpc 回非 2xx、2xx 但 ok:false、或 error 為字串時，
//   舊版只印 `Error: undefined: undefined`。修正後 stderr 必須帶 HTTP 狀態碼或錯誤原文，
//   且 exit code 非 0；正常回應仍要印出 space 清單並 exit 0。
//
// 假 daemon 只綁 127.0.0.1 的 OS 指派臨時埠，不連線任何正式服務；
// token 使用明顯假值 FAKE_VALUE_FOR_TEST；HOME 指向 mkdtempSync 建立的暫存目錄。
//
// 注意：CLI 必須用非同步 spawn 啟動。先前用 spawnSync 會同步阻塞本測試程序的 event loop，
// 假 daemon 因此無法接受 child 的 /health 請求，全部案例都會誤判成 daemon 不可達。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const CLI = fileURLToPath(new URL('../bin/tp-browser.js', import.meta.url));

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// 每個情境開跑前覆寫：假 daemon 的 /rpc 行為。
let rpcHandler = (res) => sendJson(res, 200, { ok: true, result: [] });
let rpcCalls = 0;

const server = createServer((req, res) => {
  const path = (req.url || '').split('?')[0];
  if (req.method === 'GET' && path === '/health') {
    sendJson(res, 200, { ok: true, chrome: true });
    return;
  }
  if (req.method === 'POST' && path === '/rpc') {
    rpcCalls += 1;
    req.on('end', () => rpcHandler(res));
    req.resume();
    return;
  }
  sendJson(res, 404, { ok: false, error: 'fake daemon: no such route' });
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

const PORT = server.address().port;

const HOME = mkdtempSync(join(tmpdir(), 'fmb-w9-s07-home-'));
const DATA_DIR = join(HOME, '.local', 'share', 'ego-linux');
mkdirSync(DATA_DIR, { recursive: true });
writeFileSync(join(DATA_DIR, 'token'), 'FAKE_VALUE_FOR_TEST\n', { mode: 0o600 });

after(() => {
  server.closeAllConnections();
  server.close();
  rmSync(HOME, { recursive: true, force: true });
});

async function runSpaces() {
  const before = rpcCalls;
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'spaces'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 20_000,
      env: { ...process.env, HOME, USERPROFILE: HOME, TP_DAEMON_PORT: String(PORT) },
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({
        r: { status: null, signal: 'SIGKILL', stdout, stderr: `${stderr}\nlocal test timeout` },
        rpcCalls: rpcCalls - before,
      });
    }, 20_000);

    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });

    child.on('error', (error) => {
      clearTimeout(timer);
      finish({
        r: { status: null, signal: null, error, stdout, stderr: `${stderr}\n${error.message}` },
        rpcCalls: rpcCalls - before,
      });
    });

    child.on('close', (status, signal) => {
      clearTimeout(timer);
      finish({
        r: { status, signal, stdout, stderr },
        rpcCalls: rpcCalls - before,
      });
    });
  });
}

async function assertRpcFailure(run, needles) {
  const { r, rpcCalls } = run;
  assert.equal(rpcCalls, 1, `CLI should call /rpc exactly once; stderr=${r.stderr}`);
  assert.equal(r.signal, null, `unexpected signal ${r.signal}; stderr=${r.stderr}`);
  assert.notEqual(r.status, 0, `exit code must be non-zero; stdout=${r.stdout}`);
  assert.ok(!r.stderr.includes('undefined'), `stderr must not contain "undefined": ${r.stderr}`);
  for (const needle of needles) {
    assert.ok(r.stderr.includes(needle), `stderr must contain ${JSON.stringify(needle)}; got: ${r.stderr}`);
  }
}

test('rpc 401 + {"error":"unauthorized"}：stderr 帶 401 與錯誤原文，exit 非 0', async () => {
  rpcHandler = (res) => sendJson(res, 401, { error: 'unauthorized' });
  await assertRpcFailure(await runSpaces(), ['401', 'unauthorized']);
});

test('rpc 500 + {"ok":false}（無 error 欄位）：stderr 帶 500 與可讀退路', async () => {
  rpcHandler = (res) => sendJson(res, 500, { ok: false });
  await assertRpcFailure(await runSpaces(), ['500', 'no error details']);
});

test('rpc 200 + ok:false + error 物件：stderr 帶 200、name 與 message', async () => {
  rpcHandler = (res) => sendJson(res, 200, { ok: false, error: { name: 'SpaceListError', message: 'ledger unavailable' } });
  await assertRpcFailure(await runSpaces(), ['200', 'SpaceListError', 'ledger unavailable']);
});

test('rpc 200 + ok:false + error 為字串：stderr 帶錯誤原文', async () => {
  rpcHandler = (res) => sendJson(res, 200, { ok: false, error: 'plain string failure' });
  await assertRpcFailure(await runSpaces(), ['200', 'plain string failure']);
});

test('rpc 500 + 非 JSON body：stderr 仍帶 500，不洩 undefined', async () => {
  rpcHandler = (res) => {
    res.writeHead(500, { 'content-type': 'text/html' });
    res.end('<html><body>daemon blew up</body></html>');
  };
  await assertRpcFailure(await runSpaces(), ['500']);
});

test('rpc 200 + ok:true：仍印出 space 清單並 exit 0', async () => {
  rpcHandler = (res) => sendJson(res, 200, { ok: true, result: [{ id: 1, name: 'research-flow', pages: {} }] });
  const { r, rpcCalls } = await runSpaces();
  assert.equal(rpcCalls, 1, `CLI should call /rpc exactly once; stderr=${r.stderr}`);
  assert.equal(r.signal, null, `unexpected signal ${r.signal}; stderr=${r.stderr}`);
  assert.equal(r.status, 0, `exit code must be 0; stderr=${r.stderr}`);
  assert.ok(r.stdout.includes('research-flow'), `stdout should list spaces; got: ${r.stdout}`);
  assert.ok(r.stdout.includes('"ok": true'), `stdout should include health; got: ${r.stdout}`);
  assert.ok(!r.stdout.includes('undefined'), `stdout must not contain "undefined": ${r.stdout}`);
});
