// tests/fmb_w7_s06_tp_cli_exit_codes.test.mjs
//
// w7 / s06 — tp-browser CLI 的 exit code 契約（regression tests）：
//   1. 不帶參數 / help / --help → usage 印在 stdout、exit 0。
//   2. 未知子命令（把 start 打錯成 strat）→ unknown command + usage 印在 stderr、exit 2。
//   3. doctor：daemon 與 chrome 都不可達 → NOT RUNNING / NOT REACHABLE、exit 2。
//   4. doctor：以 127.0.0.1 假 HTTP server 模擬 daemon 與 chrome 都健康 → 印 ok、exit 0。
//
// 零外部依賴、零正式服務連線（只用 127.0.0.1 本機假 server）、
// 不讀寫 repo 以外路徑（HOME 指向 mkdtempSync(tmpdir()) 的暫存目錄）；
// 假 Browser 版本字串使用明顯假值 FAKE_VALUE_FOR_TEST。
//
// 注意：此檔刻意使用 async 的 child_process.spawn，不用 spawnSync。
// spawnSync 會同步阻塞測試程序的 event loop，而假 HTTP server 就在同一程序內，
// 子程序發出的 /health、/json/version 請求會無人受理而全部逾時，
// 使「健康」案例被誤判成 NOT RUNNING / NOT REACHABLE。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const CLI = fileURLToPath(new URL('../bin/tp-browser.js', import.meta.url));
const tempRoot = mkdtempSync(join(tmpdir(), 'fmb-w7-s06-cli-exit-'));
const openServers = [];

after(() => {
  for (const srv of openServers.splice(0)) {
    try { srv.close(); } catch { /* 測試程序結束時忽略 */ }
  }
  rmSync(tempRoot, { recursive: true, force: true });
});

// 建立一個空的暫存 HOME；CLI 以 homedir() 解析 ~/.local/share/ego-linux/daemon.json。
function emptyHome(name) {
  const home = join(tempRoot, name);
  mkdirSync(join(home, '.local', 'share', 'ego-linux'), { recursive: true });
  return home;
}

function writeDaemonJson(home, obj) {
  writeFileSync(join(home, '.local', 'share', 'ego-linux', 'daemon.json'), JSON.stringify(obj), 'utf8');
}

// async spawn：父程序事件迴圈保持自由，程序內的假 HTTP server 才能即時回應子程序請求。
function runCli(home, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home, ...extraEnv },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已結束 */ } }, 20_000);
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

// 取一個「當下沒有程序在聽」的埠：先 listen(0) 讓 OS 指派，拿完號碼馬上關掉。
function deadPort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function startFake(handler) {
  return new Promise((resolve, reject) => {
    const srv = createServer(handler);
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { openServers.push(srv); resolve(srv); });
  });
}

test('s06/bogus：未知子命令 strat → stderr 印 unknown command 與 usage、exit 2', async () => {
  const home = emptyHome('bogus');
  const r = await runCli(home, ['strat']);
  assert.equal(r.status, 2, `expected exit 2\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stderr, /unknown command/i);
  assert.match(r.stderr, /strat/);
  assert.match(r.stderr, /usage/i);
  assert.doesNotMatch(r.stdout, /usage/i);
  assert.doesNotMatch(r.stdout, /unknown command/i);
});

test('s06/help：help / --help / 不帶參數 → usage 印在 stdout、exit 0', async () => {
  const home = emptyHome('help');
  for (const args of [['help'], ['--help'], []]) {
    const label = args.length ? args.join(' ') : '(no args)';
    const r = await runCli(home, args);
    assert.equal(r.status, 0, `${label}: expected exit 0\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /usage/i, label);
    assert.doesNotMatch(r.stderr, /unknown command/i, label);
  }
});

test('s06/doctor-down：daemon 與 chrome 都不可達 → NOT RUNNING / NOT REACHABLE、exit 2', async () => {
  const home = emptyHome('doctor-down');
  const dPort = await deadPort();
  const cPort = await deadPort();
  writeDaemonJson(home, { port: dPort, chromePort: cPort });
  const r = await runCli(home, ['doctor'], { TP_DAEMON_PORT: String(dPort) });
  assert.equal(r.status, 2, `expected exit 2\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /NOT RUNNING/);
  assert.match(r.stdout, /NOT REACHABLE/);
});

test('s06/doctor-up：假 HTTP server 模擬 daemon 與 chrome 都健康 → 印 ok、exit 0', async () => {
  const home = emptyHome('doctor-up');
  const daemon = await startFake((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, chrome: true }));
    } else { res.writeHead(404); res.end(); }
  });
  const chrome = await startFake((req, res) => {
    if (req.url === '/json/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ Browser: 'FakeBrowser/FAKE_VALUE_FOR_TEST' }));
    } else { res.writeHead(404); res.end(); }
  });
  const dPort = daemon.address().port;
  const cPort = chrome.address().port;
  writeDaemonJson(home, { port: dPort, chromePort: cPort });
  const r = await runCli(home, ['doctor'], { TP_DAEMON_PORT: String(dPort) });
  assert.equal(r.status, 0, `expected exit 0\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /daemon\s+127\.0\.0\.1:\d+: ok/);
  assert.match(r.stdout, /chrome\s+127\.0\.0\.1:\d+: ok/);
  assert.doesNotMatch(r.stdout, /NOT RUNNING/);
  assert.doesNotMatch(r.stdout, /NOT REACHABLE/);
});
