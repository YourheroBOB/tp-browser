// tests/fmb_w12_s05_tpd_malformed_request_target.test.mjs
// 回歸測試（daemon/tp-browserd.js）：畸形 HTTP request-target 不得讓 daemon 崩潰或卡住。
//
// 背景：HTTP request-target 完全由呼叫端控制，而 `new URL(req.url, 'http://127.0.0.1')`
// 對 "//"、"///"、"http://" 這類「special scheme 但沒有 host」的目標會拋 ERR_INVALID_URL。
// 請求處理器是 async，createServer() 不理會它回傳的 promise，因此該例外會變成
// unhandledRejection 直接終止 daemon —— loopback 上任何一個畸形請求就能讓所有
// agent session 一起掛掉。修好後應回 4xx 並繼續服務。
//
// 隔離原則：
//  - 只連自己 spawn 的 127.0.0.1 daemon，不連任何外部或正式服務。
//  - 暫存資料只寫在 os.tmpdir() 內（mkdtemp）。
//  - 認證用測試自己產生的本機 token，不涉任何真實憑證。
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const tmpRoot = mkdtempSync(join(tmpdir(), 'fmb-w12-s05-tpd-'));

let child = null;
let childStderr = '';
let home = '';
let port = 0;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port: p } = srv.address();
      srv.close(() => resolve(p));
    });
  });
}

async function health() {
  const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
  return { status: r.status, body: await r.json() };
}

// 用原始 socket 送出任意 request-target（含畸形值），回傳伺服器實際吐回來的位元組。
function rawGet(target) {
  return new Promise((resolve) => {
    let buf = '';
    const sock = net.connect(port, '127.0.0.1');
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      resolve(buf);
    };
    sock.setTimeout(5000, finish);
    sock.on('connect', () => {
      sock.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    sock.on('data', (d) => { buf += d.toString('utf8'); });
    sock.on('end', finish);
    sock.on('close', finish);
    sock.on('error', finish);
  });
}

before(async () => {
  // 複製一份 daemon（含同層相依模組）到暫存目錄，只把固定埠換成隨機空閒埠，
  // 以免與其他測試檔同時 spawn 的 daemon 撞埠。被測程式碼本身一字未改。
  const daemonDir = join(tmpRoot, 'daemon');
  cpSync(join(repoRoot, 'daemon'), daemonDir, { recursive: true });
  for (const extra of ['lib', 'bin', 'tools']) {
    const src = join(repoRoot, extra);
    if (existsSync(src)) cpSync(src, join(tmpRoot, extra), { recursive: true });
  }
  home = join(tmpRoot, 'home');
  mkdirSync(home, { recursive: true });

  port = await freePort();
  const entry = join(daemonDir, 'tp-browserd.js');
  const src = readFileSync(entry, 'utf8');
  const patched = src.replace('const PORT = ALT_PORT ? 9774 : 9772;', `const PORT = ${port};`);
  assert.notEqual(patched, src, 'test harness could not pin the daemon port (PORT declaration changed)');
  writeFileSync(entry, patched, 'utf8');

  child = spawn(process.execPath, [entry], {
    env: { ...process.env, HOME: home, USERPROFILE: home, EGO_BROWSERD_PORT: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => { childStderr += d.toString('utf8'); });

  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) {
      assert.fail(`daemon exited before becoming healthy (code ${child.exitCode}): ${childStderr.slice(0, 800)}`);
    }
    try {
      const h = await health();
      if (h.status === 200) return;
    } catch {}
    if (Date.now() > deadline) {
      assert.fail(`daemon never became healthy on 127.0.0.1:${port}: ${childStderr.slice(0, 800)}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
});

after(() => {
  if (child && child.exitCode === null) {
    try { child.kill('SIGKILL'); } catch {}
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('baseline: /health 可用', async () => {
  const h = await health();
  assert.equal(h.status, 200);
  assert.equal(h.body.ok, true);
});

for (const target of ['//', '///', 'http://']) {
  test(`畸形 request-target ${JSON.stringify(target)} 回應 4xx 且 daemon 存活`, async () => {
    const started = Date.now();
    const raw = await rawGet(target);
    const elapsed = Date.now() - started;
    // 不能卡住（卡住代表 handler 丟出的例外把請求懸在那裡）。
    assert.ok(elapsed < 4000, `request-target ${JSON.stringify(target)} hung for ${elapsed}ms`);
    // 有回應就必須是 HTTP 狀態列；完全沒有回應（空字串）由下面 /health 檢查攔下。
    if (raw !== '') {
      assert.match(raw, /^HTTP\/1\.1 [45]\d\d/, `unexpected response for ${JSON.stringify(target)}: ${JSON.stringify(raw.slice(0, 80))}`);
    }
    const h = await health();
    assert.equal(h.status, 200, `daemon not serving after request-target ${JSON.stringify(target)}: ${childStderr.slice(0, 400)}`);
  });
}

test('畸形 request-target 之後 RPC 與 token 驗證仍正常', async () => {
  const token = readFileSync(join(home, '.local', 'share', 'ego-linux', 'token'), 'utf8').trim();
  assert.ok(token.length > 0, 'daemon should have generated a local token file');

  const r = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tp-token': token },
    body: JSON.stringify({ id: 1, method: 'space.list' }),
    signal: AbortSignal.timeout(3000),
  });
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.result, []);
});
