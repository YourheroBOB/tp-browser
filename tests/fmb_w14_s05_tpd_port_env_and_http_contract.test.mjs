// tests/fmb_w14_s05_tpd_port_env_and_http_contract.test.mjs
// daemon/tp-browserd.js 的回歸測試 ＋ HTTP 契約鎖定。
//
// 回歸的 bug：EGO_BROWSERD_PORT 只認得 "9774" 這一個值；其他任何合法埠號都被
// 靜默忽略，daemon 仍然綁 9772，於是「指定了埠的呼叫端」連到一個自己沒要求的
// 埠，兩個想要不同埠的呼叫端也會互撞。本檔用 OS 配發的臨時埠啟動真正的
// daemon，驗證該埠真的被尊重，並一併鎖住相鄰的關鍵分支：token 驗證、
// Host/Origin/Sec-Fetch-Site 守衛、1 MiB 上限（413 後 daemon 仍存活）、
// JSON 物件驗證、未知 RPC 方法、/events 的 token 要求。
//
// 刻意把 footprint 壓到最小，避免和其他同樣會 spawn daemon 的測試互相干擾：
//   1. 埠由 listen(0) 向 OS 要，並排除 9772／9774 這兩個固定埠。
//   2. 若該埠在 spawn 前一瞬被別人搶走，換一個新埠重試（不讓檔案變紅）。
//   3. 不呼叫 /flush-and-close、不留任何背景工作；after() 一律 SIGKILL 收尾，
//      最多等 2 秒，絕不留下孤兒 daemon。
//
// 邊界：只連 127.0.0.1；HOME 指向 mkdtemp 沙箱（不寫 repo 以外真檔）；
// 需要假憑證時只用 FAKE_VALUE_FOR_TEST 這類明顯假字串；不連任何正式服務。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const daemonPath = fileURLToPath(new URL('../daemon/tp-browserd.js', import.meta.url));
const sandbox = mkdtempSync(join(tmpdir(), 'fmb-w14-s05-tpd-'));
const home = join(sandbox, 'home');
const dataDir = join(home, '.local', 'share', 'ego-linux');
const tokenFile = join(dataDir, 'token');
const daemonJsonFile = join(dataDir, 'daemon.json');

let child = null;
let port = 0;
let token = '';
let daemonJson = {};
let output = '';

function record(chunk) {
  output = (output + String(chunk)).slice(-2000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Ask the OS for an unused loopback port so this file can never collide with the
// other daemon tests that use the fixed 9772 / 9774 pairs.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
}

function call(method, path, { headers = {}, body = null, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

function openEventStream(tok) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/events', method: 'GET', headers: { 'x-tp-token': tok } }, (res) => {
      res.on('error', () => {});
      resolve({ status: res.statusCode, headers: res.headers, destroy: () => { res.destroy(); req.destroy(); } });
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitFor(fn, { deadlineMs = 10_000, intervalMs = 40, label = 'condition' } = {}) {
  const end = Date.now() + deadlineMs;
  for (;;) {
    const ok = await fn();
    if (ok) return ok;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}\n--- daemon output ---\n${output}`);
    await sleep(intervalMs);
  }
}

async function stopChild() {
  const c = child;
  child = null;
  if (!c || c.exitCode !== null) return;
  c.kill('SIGKILL');
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    c.once('exit', finish);
    const t = setTimeout(finish, 2000);
    if (typeof t.unref === 'function') t.unref();
  });
}

async function launch(attempts = 4) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try { rmSync(daemonJsonFile, { force: true }); } catch {}
    try { rmSync(tokenFile, { force: true }); } catch {}
    port = await freePort();
    if (port === 9772 || port === 9774) continue;
    output = '';
    const c = spawn(process.execPath, [daemonPath], {
      cwd: sandbox,
      env: { ...process.env, HOME: home, USERPROFILE: home, EGO_BROWSERD_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = c;
    c.stdout.on('data', record);
    c.stderr.on('data', record);
    c.on('exit', (code, signal) => record(`\n[daemon exited code=${code} signal=${signal}]\n`));
    try {
      // `daemon.json` is written before the listener is set up, so this is the
      // cheapest possible proof that EGO_BROWSERD_PORT was honoured.
      await waitFor(() => existsSync(daemonJsonFile), { deadlineMs: 8000, label: 'daemon.json' });
      await waitFor(async () => {
        if (c.exitCode !== null) return false;
        try { return (await call('GET', '/health', { timeoutMs: 1500 })).status === 200; } catch { return false; }
      }, { deadlineMs: 8000, label: `GET /health on 127.0.0.1:${port}` });
      await waitFor(() => existsSync(tokenFile), { deadlineMs: 5000, label: 'token file' });
      token = readFileSync(tokenFile, 'utf8').trim();
      daemonJson = JSON.parse(readFileSync(daemonJsonFile, 'utf8'));
      return;
    } catch (e) {
      lastErr = e;
      await stopChild();
    }
  }
  throw lastErr ?? new Error('daemon could not be started on any attempt');
}

function rpcBody(method, params, id = null) {
  return JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) });
}

before(async () => {
  mkdirSync(home, { recursive: true });
  await launch();
  assert.ok(token.length > 0, 'daemon must generate a non-empty token');
});

after(async () => {
  await stopChild();
  try { rmSync(sandbox, { recursive: true, force: true }); } catch {}
});

test('regression: EGO_BROWSERD_PORT 指定非 9774 的埠時，daemon 真的綁在該埠（舊碼會靜默綁 9772）', () => {
  assert.notEqual(port, 9772, 'test must run on an isolated port');
  assert.notEqual(port, 9774, 'test must run on an isolated port');
  assert.equal(daemonJson.port, port, 'daemon.json 記錄的 port 必須等於 EGO_BROWSERD_PORT');
  assert.equal(typeof daemonJson.pid, 'number');
  assert.equal(typeof daemonJson.chromePort, 'number');
});

test('/health 回報 ok／chrome 布林／spaces 數量', async () => {
  const r = await call('GET', '/health');
  assert.equal(r.status, 200);
  const body = JSON.parse(r.text);
  assert.equal(body.ok, true);
  assert.equal(typeof body.chrome, 'boolean');
  assert.equal(body.spaces, 0);
});

test('Host／Origin／Sec-Fetch-Site 守衛擋下 DNS rebinding 與跨站請求', async () => {
  const badHost = await call('GET', '/health', { headers: { host: 'evil.example' } });
  assert.equal(badHost.status, 403);
  assert.equal(badHost.text, 'forbidden host/origin');

  const withOrigin = await call('GET', '/health', { headers: { origin: 'http://evil.example' } });
  assert.equal(withOrigin.status, 403);

  const crossSite = await call('GET', '/health', { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(crossSite.status, 403);

  const sameSite = await call('GET', '/health', { headers: { 'sec-fetch-site': 'same-site' } });
  assert.equal(sameSite.status, 403);

  const sameOrigin = await call('GET', '/health', { headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(sameOrigin.status, 200);

  const cliLike = await call('GET', '/health', { headers: { 'sec-fetch-site': 'none' } });
  assert.equal(cliLike.status, 200);
});

test('/rpc 需要 token：缺 token 或錯 token 一律 403 AuthError（x-tp-token 與 x-ego-token 皆可）', async () => {
  const noToken = await call('POST', '/rpc', { headers: { 'content-type': 'application/json' }, body: rpcBody('space.list') });
  assert.equal(noToken.status, 403);
  assert.equal(JSON.parse(noToken.text).error.name, 'AuthError');

  const wrongToken = await call('POST', '/rpc', {
    headers: { 'content-type': 'application/json', 'x-tp-token': 'FAKE_VALUE_FOR_TEST' },
    body: rpcBody('space.list'),
  });
  assert.equal(wrongToken.status, 403);
  assert.equal(JSON.parse(wrongToken.text).error.name, 'AuthError');

  const aliased = await call('POST', '/rpc', {
    headers: { 'content-type': 'application/json', 'x-ego-token': token },
    body: rpcBody('space.list', undefined, 's05'),
  });
  assert.equal(aliased.status, 200);
  const body = JSON.parse(aliased.text);
  assert.equal(body.ok, true);
  assert.equal(body.id, 's05');
  assert.deepEqual(body.result, []);
});

test('/rpc 拒絕非物件 JSON 本體與壞 JSON（400 BadRequest）', async () => {
  for (const payload of ['[]', '[1,2]', 'null', '42', '"text"', 'true']) {
    const r = await call('POST', '/rpc', {
      headers: { 'content-type': 'application/json', 'x-tp-token': token },
      body: payload,
    });
    assert.equal(r.status, 400, `payload=${payload}`);
    assert.equal(JSON.parse(r.text).error.name, 'BadRequest', `payload=${payload}`);
  }

  const broken = await call('POST', '/rpc', {
    headers: { 'content-type': 'application/json', 'x-tp-token': token },
    body: '{"method":',
  });
  assert.equal(broken.status, 400);
  assert.equal(JSON.parse(broken.text).error.message, 'invalid JSON');
});

test('/rpc 超過 1 MiB 回 413 PayloadTooLarge，且 daemon 之後仍正常服務', async () => {
  // Just over the cap: enough to cross 1048576 bytes without wasting memory.
  const huge = JSON.stringify({ id: 1, method: 'space.list', pad: 'x'.repeat(1048576 + 512) });
  const r = await call('POST', '/rpc', {
    headers: { 'content-type': 'application/json', 'x-tp-token': token },
    body: huge,
  });
  assert.equal(r.status, 413);
  assert.equal(JSON.parse(r.text).error.name, 'PayloadTooLarge');

  const after413 = await call('GET', '/health');
  assert.equal(after413.status, 200);
  assert.equal(JSON.parse(after413.text).ok, true);
});

test('/rpc 未知方法回 200 與可判斷的錯誤物件（並回顯 id）', async () => {
  const r = await call('POST', '/rpc', {
    headers: { 'content-type': 'application/json', 'x-tp-token': token },
    body: rpcBody('definitely.not.a.method', {}, 7),
  });
  assert.equal(r.status, 200);
  const body = JSON.parse(r.text);
  assert.equal(body.ok, false);
  assert.equal(body.id, 7);
  assert.match(body.error.message, /unknown RPC method/);
});

test('/events 需要 token；通過後回 text/event-stream', async () => {
  const denied = await call('GET', '/events');
  assert.equal(denied.status, 403);
  assert.equal(denied.text, 'bad token');

  const stream = await openEventStream(token);
  try {
    assert.equal(stream.status, 200);
    assert.match(String(stream.headers['content-type']), /text\/event-stream/);
  } finally {
    stream.destroy();
  }

  // 串流關閉後 daemon 仍應健康（SSE client 已被移除，不得留下半死連線）。
  const health = await call('GET', '/health');
  assert.equal(health.status, 200);
});
