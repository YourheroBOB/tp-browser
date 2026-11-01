// tests/fmb_w3_s05_cli_throw_nonerror.test.mjs
//
// 回歸測試（w3 / s05）：使用者腳本 throw 非 Error 值時，CLI 必須
//   1) 不因為 catch 區塊自己爆掉而卡住（throw null／undefined 加上殘留計時器），
//   2) 把原始 thrown 值放進 stderr（throw 'boom' → 看得到 boom），
//   3) 一律以 exit code 1 結束。
//
// 兩個踩過的坑，這裡都已經避開：
//   A. 假 daemon 跑在本測試行程內，所以**絕對不能用 spawnSync**。spawnSync 會同步阻塞
//      父行程的事件迴圈，子行程的 /health 永遠等不到回應，CLI 便會落到
//      runLauncher('start') 去跑真正的 tp-start.sh，測試自己把自己鎖死到逾時。
//      → 改用非同步 spawn。
//   B. 也不能佔用固定埠 9772／9774。`node --test` 會平行跑多個測試檔，
//      其他檔案（例如 fmb_w1_s10_rpc_body）會在 9772 起真 daemon，固定埠必然互撞。
//      → 假 daemon 綁 127.0.0.1:0 讓 OS 指派臨時埠，再用 TP_DAEMON_PORT 告訴 CLI。
//
// 邊界：只連線本測試自己在 127.0.0.1 上啟動的假 daemon；暫存檔全在 tmpdir() 內；
// 認證值一律使用明顯假字串 FAKE_VALUE_FOR_TEST；不連任何正式服務、不讀寫 repo 以外的路徑。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BINS = ['bin/tp-browser.js', 'bin/ego-browser.js'];
const CHILD_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 40_000;

const tempRoot = mkdtempSync(join(tmpdir(), 'fmb-w3-s05-'));
const homeDir = join(tempRoot, 'home');
const dataDir = join(homeDir, '.local', 'share', 'ego-linux');

let fakeDaemon = null;
let daemonPort = 0;
let skipReason = '';

// 假 daemon：只實作 CLI 啟動流程真正需要的端點。
// /health 回 {ok:true,chrome:true} 讓 ensureRunning() 直接放行、不會去跑啟動器腳本；
// /events 回 text/event-stream 並保持連線，模擬「SDK 已開啟 SSE 串流」的情境。
function handleFakeDaemon(req, res) {
  let path = '/';
  try {
    path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  } catch {
    path = '/';
  }
  if (path === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, chrome: true }));
    return;
  }
  if (path === '/events' || path === '/stream' || path === '/sse') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(': fake daemon\n\n');
    return; // 保持開啟：CLI 必須自己 process.exit，不能靠事件迴圈排空
  }
  if (path === '/rpc') {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: {} }));
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, result: {} }));
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
}

before(async () => {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'token'), 'FAKE_VALUE_FOR_TEST', { mode: 0o600 });

  const server = createServer(handleFakeDaemon);
  try {
    await listen(server, 0); // 0 = 由 OS 指派空閒埠，絕不與其他測試檔的 9772／9774 相撞
    fakeDaemon = server;
    daemonPort = server.address().port;
  } catch (err) {
    skipReason = `cannot start fake daemon on 127.0.0.1:0 (${err?.code || err?.message})`;
  }
});

after(async () => {
  if (fakeDaemon) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      if (typeof timer.unref === 'function') timer.unref();
      if (typeof fakeDaemon.closeAllConnections === 'function') fakeDaemon.closeAllConnections();
      fakeDaemon.close(() => { clearTimeout(timer); resolve(); });
    });
  }
  rmSync(tempRoot, { recursive: true, force: true });
});

// 非同步 spawn：父行程的事件迴圈必須保持暢通，才能回應子行程的 /health。
function runBin(binRelPath, code) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(REPO_ROOT, binRelPath), 'nodejs', '-e', code], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        LOCALAPPDATA: join(homeDir, 'AppData', 'Local'),
        TP_DAEMON_PORT: String(daemonPort),
      },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, CHILD_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => finish({ status: null, signal: null, stdout, stderr, timedOut, spawnError: err }));
    child.on('close', (status, signal) => finish({ status, signal, stdout, stderr, timedOut, spawnError: null }));
  });
}

for (const bin of BINS) {
  const label = bin.split('/').pop();

  test(`${label}: 腳本 throw null 時在逾時內以 exit 1 結束（不會被殘留計時器卡住）`, { timeout: TEST_TIMEOUT_MS }, async (t) => {
    if (skipReason) return t.skip(skipReason);
    const r = await runBin(bin, 'setInterval(() => {}, 1000); throw null');
    assert.equal(r.spawnError, null, `spawn 失敗：${r.spawnError?.message}`);
    assert.equal(r.timedOut, false, `child 逾時未結束（CLI 卡住）；stderr=${r.stderr}`);
    assert.equal(r.signal, null, `child 被 ${r.signal} 終止；stderr=${r.stderr}`);
    assert.equal(r.status, 1, `status=${r.status}；stderr=${r.stderr}`);
    assert.match(r.stderr, /null/);
  });

  test(`${label}: 腳本 throw 'boom' 時 stderr 保留原始訊息`, { timeout: TEST_TIMEOUT_MS }, async (t) => {
    if (skipReason) return t.skip(skipReason);
    const r = await runBin(bin, "throw 'boom'");
    assert.equal(r.spawnError, null, `spawn 失敗：${r.spawnError?.message}`);
    assert.equal(r.timedOut, false, `child 逾時未結束（CLI 卡住）；stderr=${r.stderr}`);
    assert.equal(r.signal, null, `child 被 ${r.signal} 終止；stderr=${r.stderr}`);
    assert.equal(r.status, 1, `status=${r.status}；stderr=${r.stderr}`);
    assert.match(r.stderr, /boom/);
    assert.doesNotMatch(r.stderr, /Error: undefined/);
  });

  test(`${label}: 腳本 throw undefined 時仍以 exit 1 結束`, { timeout: TEST_TIMEOUT_MS }, async (t) => {
    if (skipReason) return t.skip(skipReason);
    const r = await runBin(bin, 'setInterval(() => {}, 1000); throw undefined');
    assert.equal(r.spawnError, null, `spawn 失敗：${r.spawnError?.message}`);
    assert.equal(r.timedOut, false, `child 逾時未結束（CLI 卡住）；stderr=${r.stderr}`);
    assert.equal(r.signal, null, `child 被 ${r.signal} 終止；stderr=${r.stderr}`);
    assert.equal(r.status, 1, `status=${r.status}；stderr=${r.stderr}`);
    assert.match(r.stderr, /Error/);
  });
}
