// tests/fmb_w6_s05_ego_browser_daemon_json_ports.test.mjs
//
// 回歸測試：ego-browser CLI 的 status／doctor 必須採用 daemon.json 裡「實際」的
// port／chromePort，而不是只認 9774／9775。舊行為下：
//   * status 會回報 not reachable on 127.0.0.1:9772 並以 exit 2 結束；
//   * doctor 會去探 9773。
// 本測試把 HOME 指到暫存目錄、用兩個 OS 指派埠的假 HTTP server 當 daemon 與 Chrome，
// 且刻意不設 TP_DAEMON_PORT（否則就驗不到 daemon.json 這條路徑）。
//
// 邊界：不連任何正式服務（只連 127.0.0.1 上自己開的 server）、不讀寫 repo 以外的既定路徑、
// 不使用任何真實憑證。
//
// 兩個刻意的設計約束（都是踩過的坑）：
//
// 1) 不佔用保留埠。某些執行環境的 ephemeral 埠範圍很寬（例如 1024–65535），`listen(0)`
//    有可能剛好分配到 9772／9773／9774／9775；只要本檔在整個測試檔期間佔住它，其他測試
//    （例如要起 9774 daemon 的 tests/fmb_w4_s05_tpd_http_guards.test.mjs）就會綁不上埠。
//    因此拿到保留埠就關掉重試。
//
// 2) 子程序數量刻意壓到最低（5 個）。本檔與其他測試檔在 `node --test` 下是平行執行的；
//    每一個 `node bin/ego-browser.js` 子程序都會搶 CPU，讓別檔「啟動 daemon 後立刻斷言
//    token 已存在」這類時序敏感的測試更容易失敗。因此這裡只保留能證明行為的最小組合，
//    不為了多列幾組壞設定而重複 spawn。多餘的埠型別（null／布林／小數…）由同一條
//    isPortNumber() 路徑涵蓋，用兩組代表值即可。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/ego-browser.js', import.meta.url));

// 其他測試／正式預設會用到的埠，本檔一律不佔用。
const RESERVED_PORTS = new Set([9772, 9773, 9774, 9775, 18800, 18802, 8765, 8890, 8899]);

let tempRoot;
let daemonJson;
let env;
let daemonServer;
let chromeServer;
let daemonPort;
let chromePort;

// 每次請求都記下來，用來證明 CLI 真的打到「哪一個」埠。
const daemonHits = [];
const chromeHits = [];

function listenOnce(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

function close(server) {
  return new Promise((resolve) => {
    try { server.closeAllConnections(); } catch {}
    server.close(() => resolve());
  });
}

// 取得一個「不與其他測試衝突」的 OS 指派埠。
async function listenOnEphemeral(server) {
  for (let attempt = 0; attempt < 32; attempt++) {
    const port = await listenOnce(server, 0);
    if (!RESERVED_PORTS.has(port)) return port;
    await close(server);
  }
  throw new Error('could not obtain a non-reserved ephemeral port');
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    // 子程序已結束，但仍可能有 keep-alive socket；先切斷再關，並保留上限等待。
    try { server.closeAllConnections(); } catch {}
    server.close(() => resolve());
    const guard = setTimeout(resolve, 2000);
    if (typeof guard.unref === 'function') guard.unref();
  });
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    // 不能用 spawnSync：同步等待會鎖住本行程的事件迴圈，假 server 就無法回應子程序。
    const child = spawn(process.execPath, [CLI, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function writeDaemonJson(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  writeFileSync(daemonJson, text, 'utf8');
}

// doctor 的行首前綴比對：不論該埠上剛好有沒有服務，行首都固定是 `daemon  127.0.0.1:<port>:`
// （後面接 ok／NOT RUNNING）。因此這種斷言不會被「本機剛好有人在聽 9772／9773」干擾。
function assertDoctorPort(stdout, kind, port, label) {
  const prefix = `${kind === 'daemon' ? 'daemon' : 'chrome'}  127.0.0.1:${port}:`;
  assert.ok(stdout.includes(prefix), `${label} 應探 ${port}（前綴 ${JSON.stringify(prefix)}）；輸出=${stdout}`);
}

before(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), 'fmb-w6-s05-ego-browser-'));
  const home = join(tempRoot, 'home');
  const dataDir = join(home, '.local', 'share', 'ego-linux');
  mkdirSync(dataDir, { recursive: true });
  daemonJson = join(dataDir, 'daemon.json');

  env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.TP_DAEMON_PORT; // 這條路徑必須由 daemon.json 決定埠號

  daemonServer = createServer((req, res) => {
    daemonHits.push(req.url);
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, chrome: true }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"ok":false}');
  });

  chromeServer = createServer((req, res) => {
    chromeHits.push(req.url);
    if (req.url === '/json/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ Browser: 'X/1' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });

  daemonPort = await listenOnEphemeral(daemonServer);
  chromePort = await listenOnEphemeral(chromeServer);
  assert.notEqual(daemonPort, chromePort);
  assert.ok(!RESERVED_PORTS.has(daemonPort), 'daemon 假 server 不可佔用保留埠');
  assert.ok(!RESERVED_PORTS.has(chromePort), 'chrome 假 server 不可佔用保留埠');
  assert.equal(env.TP_DAEMON_PORT, undefined);
});

after(async () => {
  await closeServer(daemonServer);
  await closeServer(chromeServer);
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

test('status 採用 daemon.json 的 port（非 9774 也照用）並以 exit 0 結束', async () => {
  writeDaemonJson({ port: daemonPort, chromePort });

  const before = daemonHits.length;
  const res = await runCli(['status']);

  assert.equal(res.code, 0, `status 應以 exit 0 結束；stderr=${res.stderr}`);
  assert.ok(
    daemonHits.slice(before).includes('/health'),
    `status 應打到 127.0.0.1:${daemonPort}/health，實際請求=${daemonHits.slice(before).join(',')}`,
  );

  const health = JSON.parse(res.stdout);
  assert.equal(health.ok, true);
  assert.equal(health.chrome, true);
});

test('doctor 同時採用 daemon.json 的 port 與 chromePort', async () => {
  writeDaemonJson({ port: daemonPort, chromePort });

  const beforeChrome = chromeHits.length;
  const res = await runCli(['doctor']);

  assert.equal(res.code, 0, res.stderr);
  assert.ok(
    res.stdout.includes(`daemon  127.0.0.1:${daemonPort}: ok (chrome attached: true)`),
    `doctor 應探 daemon.json 的 daemon 埠 ${daemonPort}；輸出=${res.stdout}`,
  );
  assert.ok(
    res.stdout.includes(`chrome  127.0.0.1:${chromePort}: ok (X/1)`),
    `doctor 應探 daemon.json 的 chromePort ${chromePort}；輸出=${res.stdout}`,
  );
  assert.ok(
    chromeHits.slice(beforeChrome).includes('/json/version'),
    `doctor 應打到 127.0.0.1:${chromePort}/json/version`,
  );
});

test('daemon.json 損壞（非 JSON）時 doctor 仍回落 9772／9773', async () => {
  writeDaemonJson('{ this is not json');

  const res = await runCli(['doctor']);
  assert.equal(res.code, 0, res.stderr);
  assertDoctorPort(res.stdout, 'daemon', 9772, '損壞的 daemon.json');
  assertDoctorPort(res.stdout, 'chrome', 9773, '損壞的 daemon.json');
});

test('daemon.json 埠不合法（超界／字串）時 doctor 仍回落 9772／9773', async () => {
  // 兩組代表值：數值超界、型別錯誤（字串）。0／負數／小數／null／布林走的是同一條
  // isPortNumber() 判斷，不再重複 spawn。
  for (const cfg of [{ port: 70000, chromePort: 70001 }, { port: '9774', chromePort: '9775' }]) {
    writeDaemonJson(cfg);
    const res = await runCli(['doctor']);
    const label = JSON.stringify(cfg);
    assert.equal(res.code, 0, `${label}: ${res.stderr}`);
    assertDoctorPort(res.stdout, 'daemon', 9772, label);
    assertDoctorPort(res.stdout, 'chrome', 9773, label);
  }
});

test('port 不合法但 chromePort 合法時，兩者各自獨立決定（daemon 回落 9772、chrome 用 C）', async () => {
  writeDaemonJson({ port: 'not-a-port', chromePort });

  const res = await runCli(['doctor']);
  assert.equal(res.code, 0, res.stderr);
  assertDoctorPort(res.stdout, 'daemon', 9772, '不合法的 port');
  assert.ok(
    res.stdout.includes(`chrome  127.0.0.1:${chromePort}: ok (X/1)`),
    `chrome 應採用 chromePort ${chromePort}（不得被壞掉的 port 拖累）；輸出=${res.stdout}`,
  );
});
