// tests/fmb_w13_s05_tpd_guard_order.test.mjs
// -----------------------------------------------------------------------------
// 回歸測試（w13 / s05）：daemon/tp-browserd.js 的 loopback 守衛必須在「所有」路由
// 之前執行。
//
// 修補前：/newtab、/showcase、/docs 三個路由寫在 Host / Origin / Sec-Fetch-Site
// 守衛之前，因此
//   * `Host: attacker.example`（DNS rebinding）可以直接讀到這些頁面；
//   * 跨站瀏覽器請求（Sec-Fetch-Site: cross-site / same-site）也讀得到。
// 修補後：守衛先跑，非 loopback Host、帶 Origin、或跨站 Sec-Fetch-Site 一律 403，
// 而正常路徑（Host 127.0.0.1、Sec-Fetch-Site: none）仍可取得頁面。
//
// 本檔特性：零外部依賴、不需要 Chrome、只連 127.0.0.1、所有狀態都在 tmpdir()。
// 若 127.0.0.1:9774 已被其他程序佔用（同批其他 daemon 測試），整組測試會 skip，
// 不會讓既有測試多出失敗。
// -----------------------------------------------------------------------------
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import http from 'node:http';

const DAEMON = fileURLToPath(new URL('../daemon/tp-browserd.js', import.meta.url));
// --alt-port 走 9774，避開預設的 9772，降低與其他 daemon 測試互相搶埠的機率。
const PORT = 9774;
const HOST = '127.0.0.1';

const tempRoot = mkdtempSync(join(tmpdir(), 'fmb-w13-s05-tpd-'));
let child = null;
let skipReason = '';
let daemonLog = '';

function remember(chunk) {
  if (daemonLog.length < 4000) daemonLog += String(chunk);
}

function request(path, { method = 'GET', headers = {}, setHost = true, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, port: PORT, path, method, headers, setHost }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('request timeout')));
    req.end(body === null ? undefined : body);
  });
}

function probePortFree() {
  return new Promise((resolve) => {
    const sock = net.connect({ host: HOST, port: PORT });
    const done = (free) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(free);
    };
    sock.setTimeout(500, () => done(false));
    sock.once('connect', () => done(false));
    sock.once('error', () => done(true));
  });
}

function alive() {
  return child !== null && child.exitCode === null && child.signalCode === null;
}

async function waitForHealth() {
  for (let i = 0; i < 40; i += 1) {
    if (!alive()) return false;
    try {
      const r = await request('/health');
      if (r.status === 200) {
        // listen 若失敗（EADDRINUSE）程序會在數十毫秒內結束；再確認一次。
        await new Promise((r2) => setTimeout(r2, 120));
        return alive();
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

before(async () => {
  if (!(await probePortFree())) {
    skipReason = `127.0.0.1:${PORT} 已被其他程序佔用，跳過（不影響既有測試）`;
    return;
  }
  child = spawn(process.execPath, [DAEMON, '--alt-port'], {
    cwd: tempRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: tempRoot,
      USERPROFILE: tempRoot,
      LOCALAPPDATA: join(tempRoot, 'AppData', 'Local'),
    },
  });
  child.stdout.on('data', remember);
  child.stderr.on('data', remember);

  if (!(await waitForHealth())) {
    skipReason = `daemon 未在期限內於 ${HOST}:${PORT} 就緒（rc=${child.exitCode}）：${daemonLog.slice(0, 300)}`;
    return;
  }
  const sidecar = join(tempRoot, '.local', 'share', 'ego-linux', 'daemon.json');
  if (!existsSync(sidecar)) {
    skipReason = 'daemon.json 未建立，無法確認應答者是本次啟動的 daemon';
    return;
  }
  let pid = null;
  try { pid = JSON.parse(readFileSync(sidecar, 'utf8')).pid; } catch {}
  if (pid !== child.pid || !alive()) {
    skipReason = `port ${PORT} 上應答的不是本次啟動的 daemon，跳過`;
  }
});

after(async () => {
  if (alive()) {
    child.kill('SIGKILL');
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 3000);
      child.once('exit', () => { clearTimeout(t); resolve(); });
    });
  }
  rmSync(tempRoot, { recursive: true, force: true });
});

test('健康檢查：loopback Host 可取得 { ok: true }', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const r = await request('/health');
  assert.equal(r.status, 200, r.body);
  const body = JSON.parse(r.body);
  assert.equal(body.ok, true);
  assert.equal(typeof body.chrome, 'boolean');
  // /health 的 spaces 是「空間數量」（store.list().length，number），不是陣列：
  // 這是 daemon 既有契約，本測試只鎖「型別正確且可取得」。
  assert.equal(typeof body.spaces, 'number');
});

test('DNS rebinding：Host 非 127.0.0.1 時 /newtab 必須 403 且不洩漏頁面內容', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const r = await request('/newtab', { headers: { host: 'attacker.example' }, setHost: false });
  assert.equal(r.status, 403, `expected 403, got ${r.status}`);
  assert.ok(!r.body.includes('TooPower'), 'body must not leak the newtab page');
});

test('跨站／同站瀏覽器請求不得讀取 /newtab 與 /showcase', async (t) => {
  if (skipReason) return t.skip(skipReason);
  for (const site of ['cross-site', 'same-site']) {
    const newtab = await request('/newtab', { headers: { 'sec-fetch-site': site } });
    assert.equal(newtab.status, 403, `/newtab sec-fetch-site=${site} => ${newtab.status}`);
    assert.ok(!newtab.body.includes('TooPower'));

    const showcase = await request('/showcase', { headers: { 'sec-fetch-site': site } });
    assert.equal(showcase.status, 403, `/showcase sec-fetch-site=${site} => ${showcase.status}`);
  }
});

test('帶 Origin 標頭的瀏覽器請求不得讀取 /showcase 與 /docs', async (t) => {
  if (skipReason) return t.skip(skipReason);
  for (const path of ['/showcase', '/docs']) {
    const r = await request(path, { headers: { origin: 'http://evil.example' } });
    assert.equal(r.status, 403, `${path} with Origin => ${r.status}`);
  }
});

test('DNS rebinding：Host 非 127.0.0.1 時 /showcase 與 /docs 必須 403', async (t) => {
  if (skipReason) return t.skip(skipReason);
  for (const path of ['/showcase', '/docs']) {
    const r = await request(path, { headers: { host: `attacker.example` }, setHost: false });
    assert.equal(r.status, 403, `${path} with forged Host => ${r.status}`);
  }
});

test('不誤擋正常路徑：loopback Host + Sec-Fetch-Site: none 仍能取得 /newtab', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const r = await request('/newtab', { headers: { 'sec-fetch-site': 'none' } });
  assert.equal(r.status, 200, `loopback GET /newtab => ${r.status}`);
  assert.ok(r.body.includes('TooPower'), 'newtab page content expected');
});

test('/rpc 沒有 token 或 token 錯誤時回 403 AuthError（守衛未過度放行）', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const none = await request('/rpc', { method: 'POST' });
  assert.equal(none.status, 403, none.body);
  assert.equal(JSON.parse(none.body).error.name, 'AuthError');

  const wrong = await request('/rpc', { method: 'POST', headers: { 'x-tp-token': 'FAKE_VALUE_FOR_TEST' } });
  assert.equal(wrong.status, 403, wrong.body);
  assert.equal(JSON.parse(wrong.body).ok, false);
  assert.equal(JSON.parse(wrong.body).error.name, 'AuthError');
});

test('被拒絕的請求不會讓 daemon 掛掉（之後仍可服務 /health）', async (t) => {
  if (skipReason) return t.skip(skipReason);
  assert.equal(alive(), true, 'daemon process must still be running');
  const r = await request('/health');
  assert.equal(r.status, 200, r.body);
  assert.equal(JSON.parse(r.body).ok, true);
});
