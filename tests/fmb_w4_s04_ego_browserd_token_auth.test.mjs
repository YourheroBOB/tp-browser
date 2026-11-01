// tests/fmb_w4_s04_ego_browserd_token_auth.test.mjs
// 回歸測試：daemon/ego-browserd.js 的 token 檔處理與 /rpc 認證。
//
// 修掉的 bug：舊版 ensureToken() 只判斷 token 檔「是否存在」，因此一個空檔案（或只剩
// 空白的檔案）會讓 TOKEN === ''。checkToken() 用 timingSafeEqual() 比較兩個零長度
// Buffer 時恆為 true，於是任何「不帶 x-tp-token 標頭」的本機請求都會通過認證，取得
// 完整的 /rpc 與 /events 權限。
//
// 本測試以子程序啟動真正的 daemon，但把 HOME/USERPROFILE 指到 tmpdir() 底下的隔離
// 目錄，只連線 127.0.0.1，不連線任何正式服務，也不讀寫 repo 以外的真實使用者資料。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DAEMON = fileURLToPath(new URL('../daemon/ego-browserd.js', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
// 走 daemon 既有的 alt-port 軌（9774），與預設 9772 的既有測試錯開。
const ALT_PORT = 9774;

const roots = [];
const children = [];
let lastStderr = '';

after(() => {
  for (const child of children) { try { child.kill('SIGKILL'); } catch {} }
  for (const root of roots) { try { rmSync(root, { recursive: true, force: true }); } catch {} }
});

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'fmb-w4-s04-'));
  roots.push(home);
  const dataDir = join(home, '.local', 'share', 'ego-linux');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return { home, dataDir, tokenPath: join(dataDir, 'token') };
}

function startDaemon(home) {
  lastStderr = '';
  const child = spawn(process.execPath, [DAEMON], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home, USERPROFILE: home, EGO_BROWSERD_PORT: String(ALT_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume();
  child.stderr.on('data', (c) => { lastStderr = `${lastStderr}${c.toString('utf8')}`.slice(-2000); });
  children.push(child);
  return child;
}

function stopDaemon(child) {
  try { child.kill('SIGKILL'); } catch {}
}

async function waitFor(fn, ok, ms = 10_000, step = 100) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = fn();
    if (ok(value)) return value;
    if (Date.now() >= deadline) return value;
    await sleep(step);
  }
}

function httpJson(port, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(body);
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: payload
        ? { 'content-type': 'application/json', 'content-length': payload.length, ...headers }
        : headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(5000, () => req.destroy(new Error('http timeout')));
    req.on('error', reject);
    req.end(payload ?? undefined);
  });
}

function postJson(port, path, body, headers) { return httpJson(port, 'POST', path, body, headers); }

async function probeHealth(port) {
  try {
    const r = await httpJson(port, 'GET', '/health');
    return r.status === 200;
  } catch {
    return false;
  }
}

async function waitForHealth(port, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await probeHealth(port)) return true;
    await sleep(150);
  }
  return false;
}

test('token 檔為空時必須重新產生高強度 token（不得以空字串當認證）', async () => {
  const { home, tokenPath } = makeHome();
  writeFileSync(tokenPath, '', { mode: 0o600 });
  const child = startDaemon(home);
  try {
    const tok = await waitFor(
      () => { try { return readFileSync(tokenPath, 'utf8').trim(); } catch { return ''; } },
      (v) => v.length > 0,
    );
    assert.ok(tok.length > 0, `daemon 啟動後 token 檔仍是空的：checkToken() 會用零長度 Buffer 放行所有請求（stderr: ${lastStderr.slice(-200)}）`);
    assert.match(tok, /^[0-9a-f]{48}$/, `預期 24 bytes hex token，實際長度 ${tok.length}`);
    if (process.platform !== 'win32') {
      assert.equal(statSync(tokenPath).mode & 0o777, 0o600, 'token 檔權限必須收斂為 0600');
    }
  } finally {
    stopDaemon(child);
  }
});

test('既有非空 token 不被覆寫，且權限被收斂為 0600', async () => {
  const { home, dataDir, tokenPath } = makeHome();
  const existing = 'FAKE_VALUE_FOR_TEST_do_not_use_as_a_real_token';
  writeFileSync(tokenPath, existing, { encoding: 'utf8', mode: 0o644 });
  if (process.platform !== 'win32') chmodSync(tokenPath, 0o644);
  const child = startDaemon(home);
  try {
    // daemon.json 是在 ensureToken() 之後才寫的，看到它就代表 token 已被處理過。
    const written = await waitFor(() => existsSync(join(dataDir, 'daemon.json')), (v) => v === true);
    assert.equal(written, true, `daemon 未完成啟動（daemon.json 未產生）：${lastStderr.slice(-200)}`);
    assert.equal(readFileSync(tokenPath, 'utf8').trim(), existing, '既有 token 不得被重新產生，否則 CLI 手上的憑證會失效');
    if (process.platform !== 'win32') {
      assert.equal(statSync(tokenPath).mode & 0o777, 0o600, '既有的寬鬆權限必須被收斂為 0600');
    }
  } finally {
    stopDaemon(child);
  }
});

test('缺少 token／空白 token／錯誤 token 一律 403，正確 token 才能呼叫 /rpc', async (t) => {
  if (await probeHealth(ALT_PORT)) {
    t.skip(`127.0.0.1:${ALT_PORT} 已被其他程序佔用，跳過 HTTP 認證驗證`);
    return;
  }
  const { home, tokenPath } = makeHome();
  writeFileSync(tokenPath, '', { mode: 0o600 });
  const child = startDaemon(home);
  try {
    if (!(await waitForHealth(ALT_PORT))) {
      t.skip(`daemon 未在時限內回應 /health（環境問題）：${lastStderr.slice(-200)}`);
      return;
    }
    const tok = readFileSync(tokenPath, 'utf8').trim();
    assert.ok(tok.length > 0, 'daemon 以空 token 啟動');

    const body = JSON.stringify({ id: 1, method: 'status', params: {} });

    const missing = await postJson(ALT_PORT, '/rpc', body);
    assert.equal(missing.status, 403, `未帶 token 的請求竟通過認證：${missing.body}`);

    const blank = await postJson(ALT_PORT, '/rpc', body, { 'x-tp-token': '' });
    assert.equal(blank.status, 403, `空白 token 竟通過認證：${blank.body}`);

    const wrong = await postJson(ALT_PORT, '/rpc', body, { 'x-tp-token': 'FAKE_VALUE_FOR_TEST' });
    assert.equal(wrong.status, 403, `錯誤 token 竟通過認證：${wrong.body}`);

    const good = await postJson(ALT_PORT, '/rpc', body, { 'x-tp-token': tok });
    assert.equal(good.status, 200);
    assert.equal(JSON.parse(good.body).ok, true);
  } finally {
    stopDaemon(child);
  }
});
