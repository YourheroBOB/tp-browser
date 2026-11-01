// tests/fmb_w4_s01_ego_browser_nodejs.test.mjs
// bin/ego-browser.js 的回歸測試（fan-out w4 / s01）。
// 只連本機 127.0.0.1 的假 daemon（node:http 臨時埠），不連任何正式服務；
// 認證值一律是明顯假字串 FAKE_VALUE_FOR_TEST；所有檔案都在 mkdtempSync(tmpdir()) 內。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/ego-browser.js', import.meta.url));
const FAKE_TOKEN = 'FAKE_VALUE_FOR_TEST';
const CHILD_TIMEOUT_MS = 20_000;

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'fmb-w4-s01-ego-'));
  const dataDir = join(home, '.local', 'share', 'ego-linux');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'token'), `${FAKE_TOKEN}\n`, { mode: 0o600 });
  return {
    home,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

function startFakeDaemon() {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, chrome: true }));
      return;
    }
    if (req.method === 'GET') {
      // 任何 SSE／其他 GET：給一個不主動結束的串流，避免 SDK 重試風暴。
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(': connected\n\n');
      return;
    }
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: {} }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => {
          try { server.closeAllConnections?.(); } catch {}
          server.close(() => done());
        }),
      });
    });
  });
}

function runCli(args, { home, port } = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  // 明確覆寫（空字串 → readPort() 視為未設定），避免繼承開發機上真的 TP_DAEMON_PORT。
  env.TP_DAEMON_PORT = port ? String(port) : '';

  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdin.end();

  const done = new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  const timedOut = new Promise((resolve) => {
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve({ timeout: true, stdout, stderr });
    }, CHILD_TIMEOUT_MS).unref();
  });
  return Promise.race([done, timedOut]);
}

test('nodejs -e 少了腳本字串：exit 2、明確用法訊息，且在接觸 daemon／啟動器之前就結束', async () => {
  const h = makeHome();
  try {
    const r = await runCli(['nodejs', '-e'], { home: h.home });
    assert.equal(r.timeout, undefined, 'CLI 不應該卡住');
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /-e requires a script string/);
    // 舊行為會先 ensureRunning()（健康檢查失敗 → 跑啟動器）再回 "not reachable"。
    assert.doesNotMatch(r.stderr, /not reachable/);
    assert.doesNotMatch(r.stderr, /failed to run launcher/);
  } finally {
    h.cleanup();
  }
});

test('nodejs 傳遞 exit code：腳本設定 process.exitCode = 7 時 CLI 以 7 結束', async () => {
  const daemon = await startFakeDaemon();
  const h = makeHome();
  try {
    const r = await runCli(['nodejs', '-e', 'process.exitCode = 7;'], { home: h.home, port: daemon.port });
    assert.equal(r.timeout, undefined, 'CLI 不應該卡住');
    assert.equal(r.code, 7, r.stderr);
  } finally {
    h.cleanup();
    await daemon.close();
  }
});

test('nodejs 傳遞 exit code：腳本未設定退出碼時仍以 0 結束', async () => {
  const daemon = await startFakeDaemon();
  const h = makeHome();
  try {
    const r = await runCli(['nodejs', '-e', 'globalThis.__fmbW4S01Ran = true;'], {
      home: h.home,
      port: daemon.port,
    });
    assert.equal(r.timeout, undefined, 'CLI 不應該卡住');
    assert.equal(r.code, 0, r.stderr);
  } finally {
    h.cleanup();
    await daemon.close();
  }
});
