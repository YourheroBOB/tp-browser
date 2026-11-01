// tests/fmb_w9_s08_ego_browser_exit_cleanup.test.mjs
// 回歸測試（fan-out w9 / s08）：
//   ego-browser nodejs 在使用者腳本自行 process.exit() 時，import 期間同步退出會跳過 finally，
//   使 tp-run-XXXX/script.mjs（含腳本原文，可能帶帳密或網址）永久留在 TMPDIR。
// 修法：建立暫存目錄後註冊 process.on('exit') 做同步 rmSync 清理，正常路徑也用同一套機制；
//       腳本的 exit code 必須原樣保留。
//
// 重要實作細節：必須用「非同步 spawn」起 CLI。spawnSync 會阻塞本程序的事件迴圈，
// 同一條事件迴圈上的假 daemon 就無法在子程序執行期間 accept/回應請求，子程序的
// /health 一定逾時，CLI 會誤判 daemon 不在、跑去跑真的 tp-start.sh 並以 exit 2 收場。
// 零外部依賴、零正式服務連線：只在 127.0.0.1 起假 daemon，暫存一律放 mkdtempSync(tmpdir())。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const CLI = fileURLToPath(new URL('../bin/ego-browser.js', import.meta.url));
const FAKE_TOKEN = 'FAKE_VALUE_FOR_TEST';
const CHILD_TIMEOUT_MS = 20_000;

const tempRoot = mkdtempSync(join(tmpdir(), 'fmb-w9-s08-'));
const fakeHome = join(tempRoot, 'home');
const runTmp = join(tempRoot, 'tmpdir'); // 隔離的 TMPDIR，專門檢查 tp-run-* 殘留
const dataDir = join(fakeHome, '.local', 'share', 'ego-linux');

mkdirSync(fakeHome, { recursive: true });
mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, 'token'), `${FAKE_TOKEN}\n`, { mode: 0o600 });
mkdirSync(runTmp, { recursive: true });

let server = null;
let port = 0;

before(async () => {
  await new Promise((resolve, reject) => {
    server = createServer((req, res) => {
      // 子程序可能在任何時間點斷線；沒有 handler 時 Node 會把 res 的 'error'
      // 變成未捕捉例外而弄掛整條測試。
      res.on('error', () => {});
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      if (path === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, chrome: true }));
        return;
      }
      if (path === '/events') {
        // 模擬真實 daemon 的 SSE 串流：保持開啟，讓事件迴圈不會自己排空，
        // 這樣才能驗證「CLI 是顯式 exit」而不是僥倖被排空。
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        try { res.write(': fmb-w9-s08 keep-alive\n\n'); } catch {}
        return;
      }
      if (path === '/rpc') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: null }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { name: 'NotFound', message: path } }));
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });
});

after(() => {
  try { server?.closeAllConnections?.(); } catch {}
  try { server?.close(); } catch {}
  rmSync(tempRoot, { recursive: true, force: true });
});

function leftoverRunDirs() {
  let names = [];
  try { names = readdirSync(runTmp); } catch {}
  return names.filter((n) => n.startsWith('tp-run-'));
}

// 非同步 spawn：父程序事件迴圈必須保持暢通，否則假 daemon 無法在子程序存活期間回應。
function runCli(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'nodejs', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        LOCALAPPDATA: join(fakeHome, 'AppData', 'Local'),
        TMPDIR: runTmp,
        TP_DAEMON_PORT: String(port),
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, CHILD_TIMEOUT_MS);
    killer.unref();
    child.on('error', (e) => { clearTimeout(killer); reject(e); });
    child.on('close', (status, signal) => {
      clearTimeout(killer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

function failInfo(r) {
  return `status=${r.status} signal=${r.signal}\nstdout=${r.stdout}\nstderr=${r.stderr}`;
}

test('s08：process.exit(3) 時 exit code 原樣保留且 TMPDIR 不留 tp-run-*', async () => {
  assert.ok(port > 0, 'fake daemon 尚未 listen');
  const r = await runCli('process.exit(3)');
  assert.equal(r.status, 3, failInfo(r));
  assert.deepEqual(leftoverRunDirs(), [], `TMPDIR 殘留：${leftoverRunDirs().join(', ')}`);
});

test('s08：process.exit(0) 時 exit code 為 0 且 TMPDIR 不留 tp-run-*', async () => {
  assert.ok(port > 0, 'fake daemon 尚未 listen');
  const r = await runCli('process.exit(0)');
  assert.equal(r.status, 0, failInfo(r));
  assert.deepEqual(leftoverRunDirs(), [], `TMPDIR 殘留：${leftoverRunDirs().join(', ')}`);
});

test('s08：腳本 throw 時 exit code 為 1 且 TMPDIR 不留 tp-run-*', async () => {
  assert.ok(port > 0, 'fake daemon 尚未 listen');
  const r = await runCli("throw new Error('fmb-w9-s08 boom')");
  assert.equal(r.status, 1, failInfo(r));
  assert.match(r.stderr, /fmb-w9-s08 boom/);
  assert.deepEqual(leftoverRunDirs(), [], `TMPDIR 殘留：${leftoverRunDirs().join(', ')}`);
});

test('s08：正常結束時 exit code 為 0、腳本真的被執行過且 TMPDIR 不留 tp-run-*', async () => {
  assert.ok(port > 0, 'fake daemon 尚未 listen');
  const r = await runCli("console.log('fmb-w9-s08-ran')");
  assert.equal(r.status, 0, failInfo(r));
  assert.match(r.stdout, /fmb-w9-s08-ran/);
  assert.deepEqual(leftoverRunDirs(), [], `TMPDIR 殘留：${leftoverRunDirs().join(', ')}`);
});

test('s08：process.exitCode = 5 的退出碼不被蓋掉、TMPDIR 也不留 tp-run-*', async () => {
  assert.ok(port > 0, 'fake daemon 尚未 listen');
  const r = await runCli('process.exitCode = 5');
  assert.equal(r.status, 5, failInfo(r));
  assert.deepEqual(leftoverRunDirs(), [], `TMPDIR 殘留：${leftoverRunDirs().join(', ')}`);
});
