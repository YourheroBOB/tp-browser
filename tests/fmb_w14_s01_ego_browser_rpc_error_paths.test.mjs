// tests/fmb_w14_s01_ego_browser_rpc_error_paths.test.mjs
// 回歸測試：`tp-browser spaces` 會走 bin/ego-browser.js 的 rpcCmd()。
// fetch() 只在網路層失敗時拋錯——HTTP 401／404／502 與「非 JSON 內容」都會正常回傳 Response。
// 舊寫法直接 `await res.json()`，使用者只看到 `Unexpected token '<'` 或
// `Unexpected end of JSON input` 這種與真正原因無關的訊息（埠被別的服務佔用、代理攔截、
// daemon 中途掛掉、認證被拒），完全無法判斷。
//
// 本檔用本機 127.0.0.1 的假 daemon（零外部依賴、零正式服務、無真實憑證；
// token 一律使用明顯假值）驗證：
//   1. HTTP 401（非 JSON）要給出可判斷的訊息，而不是 JSON 解析錯誤；
//   2. 200 但空 body 要給出「非 JSON 回應」訊息；
//   3. 正常回應與 RPC 層 ok:false 的既有行為不變。
// 暫存資料只存在 mkdtempSync(tmpdir()) 之內，測試結束即刪除。
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const CLI = fileURLToPath(new URL('../bin/ego-browser.js', import.meta.url));
const FAKE_TOKEN = 'FAKE_VALUE_FOR_TEST';

const tempRoot = mkdtempSync(join(tmpdir(), 'fmb-w14-s01-ego-browser-'));
const home = join(tempRoot, 'home');
const dataDir = join(home, '.local', 'share', 'ego-linux');
mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, 'token'), `${FAKE_TOKEN}\n`, { mode: 0o600 });

let server = null;
let port = 0;
const seenTokens = [];
// 每個測試改寫這支假 /rpc 回應；node:test 同檔的頂層測試是循序執行，不會互相踩。
let rpcReply = () => ({ status: 200, body: '{"ok":true,"result":{}}', type: 'application/json' });

before(async () => {
  server = createServer((req, res) => {
    req.resume(); // 丟掉 request body，避免 keep-alive 卡住
    const send = (status, type, body) => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };
    if (req.url === '/health') {
      send(200, 'application/json', JSON.stringify({ ok: true, chrome: true }));
      return;
    }
    if (req.url === '/rpc') {
      seenTokens.push(String(req.headers['x-tp-token'] || ''));
      const { status, body, type } = rpcReply();
      send(status, type, body);
      return;
    }
    send(404, 'text/plain', 'not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  rmSync(tempRoot, { recursive: true, force: true });
});

// 用非同步 spawn（不是 spawnSync）：父程序的事件迴圈必須能同時服務上面的假 daemon。
function runCli(...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home, USERPROFILE: home, TP_DAEMON_PORT: String(port) },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    timer.unref();
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${e && e.message ? e.message : ''}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test('spaces：HTTP 401 且回應不是 JSON 時，必須回報 HTTP 狀態而非 JSON 解析錯誤', async () => {
  rpcReply = () => ({ status: 401, body: 'unauthorized', type: 'text/plain' });
  const r = await runCli('spaces');
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /answered HTTP 401 for space\.list/);
  assert.doesNotMatch(r.stderr, /Unexpected token/);
  assert.doesNotMatch(r.stderr, /is not valid JSON/);
});

test('spaces：200 但 body 為空時，必須回報非 JSON 回應而非 JSON 解析錯誤', async () => {
  rpcReply = () => ({ status: 200, body: '', type: 'application/json' });
  const r = await runCli('spaces');
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /non-JSON response for space\.list/);
  assert.doesNotMatch(r.stderr, /Unexpected end of JSON input/);
});

test('spaces：正常 RPC 回應仍印出 space.list 結果並以 0 結束', async () => {
  seenTokens.length = 0;
  rpcReply = () => ({
    status: 200,
    body: JSON.stringify({ ok: true, result: { nextSpaceId: 3, spaces: [{ id: 1 }] } }),
    type: 'application/json',
  });
  const r = await runCli('spaces');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /"nextSpaceId": 3/);
  assert.match(r.stdout, /"chrome": true/); // status 段仍先印 health
  assert.deepEqual(seenTokens, [FAKE_TOKEN]); // 假 token 有確實送出
});

test('spaces：RPC 層 ok:false 仍轉成 `name: message` 並以 1 結束', async () => {
  rpcReply = () => ({
    status: 200,
    body: JSON.stringify({ ok: false, error: { name: 'Error', message: 'boom' } }),
    type: 'application/json',
  });
  const r = await runCli('spaces');
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /Error: boom/);
});
