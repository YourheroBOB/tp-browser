// tests/fmb_w1_s10_rpc_body.test.mjs
// 回歸測試：POST /rpc 的 body 邊界（daemon/ego-browserd.js）
//
//  Bug 1：body 為 'null'（或任何非物件 JSON）時，舊版在 try 內存取 msg.method 先丟
//         TypeError，catch 內再存取 msg.id 又丟一次，形成未處理的 rejection，
//         整個 daemon 直接退出。
//  Bug 2：body 超過 1 MiB 時舊版只做 req.destroy()，客戶端只看到 socket hang up／
//         fetch failed，沒有可判讀的錯誤。
//  期望：非物件 body → 400 BadRequest；超過 1 MiB → 413 + PayloadTooLarge；
//         兩種情況之後 daemon 都必須仍然存活（/health 仍回 200）。
//
// 特性：零外部依賴、只連 127.0.0.1、暫存 HOME 用 mkdtempSync()、token 只從該暫存
// HOME 讀取（不碰使用者真實資料目錄），結束時一律 kill 子程序並清除暫存目錄。
// 預設 port 9772 已被占用時整支測試 skip（可能是其他 daemon 在跑）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DAEMON = fileURLToPath(new URL('../daemon/ego-browserd.js', import.meta.url));
const HOST = '127.0.0.1';
const PORT = 9772;
const BASE = `http://${HOST}:${PORT}`;
const ONE_MIB = 1024 * 1024;
const START_TIMEOUT_MS = 20000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// true = 9772 沒人監聽（可以自己起 daemon）；false = 已被占用（skip）
function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, HOST);
  });
}

test('POST /rpc：非物件 body 回 400 且 daemon 存活；超過 1 MiB 回 413 PayloadTooLarge', async (t) => {
  if (!(await portIsFree(PORT))) {
    t.skip(`127.0.0.1:${PORT} 已被占用（可能有其他 daemon 在跑），跳過`);
    return;
  }

  const home = mkdtempSync(join(tmpdir(), 'fmb-w1-s10-home-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.EGO_BROWSERD_PORT; // 避免繼承外部設定而跑到 9774

  const child = spawn(process.execPath, [DAEMON], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (d) => { logs += String(d); });
  child.stderr.on('data', (d) => { logs += String(d); });

  const stopChild = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  };

  try {
    // 等 /health 可用（daemon 不需要 Chrome，attachChrome 的背景重試不影響 HTTP 層）
    let up = false;
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      try {
        const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1000) });
        await r.text();
        if (r.status === 200) { up = true; break; }
      } catch {}
      await sleep(50);
    }
    assert.equal(up, true, `daemon 未在時限內啟動於 ${BASE}\n--- daemon log ---\n${logs.slice(-2000)}`);

    const tokenPath = join(home, '.local', 'share', 'ego-linux', 'token');
    assert.ok(existsSync(tokenPath), 'daemon 應在暫存 HOME 內建立 token 檔');
    const token = readFileSync(tokenPath, 'utf8').trim();
    assert.ok(token.length > 0, 'token 不應為空');

    const rpc = async (body) => {
      const res = await fetch(`${BASE}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tp-token': token },
        body,
        signal: AbortSignal.timeout(15000),
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: res.status, json, text };
    };

    const healthOk = async () => {
      const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5000) });
      const body = await r.text();
      return { status: r.status, body };
    };

    // 先用合法請求確認 token 是本 daemon 認的；403 表示 9772 上另有 daemon（競態）→ skip
    const warm = await rpc(JSON.stringify({ id: 0, method: 'status', params: {} }));
    if (warm.status === 403) {
      t.skip('127.0.0.1:9772 由其他 daemon 佔用（token 不符），跳過');
      return;
    }
    assert.equal(warm.status, 200, `合法 RPC 應回 200，實得 ${warm.status}: ${warm.text}`);
    assert.equal(warm.json?.ok, true, `合法 RPC 應 ok:true，實得：${warm.text}`);

    // --- Bug 1：body 是合法 JSON 但不是物件 ---
    for (const body of ['null', '[]', '[1,2]', 'true', '42', '"text"']) {
      const r = await rpc(body);
      assert.equal(r.status, 400, `body=${body} 應回 400，實得 ${r.status}: ${r.text}`);
      assert.equal(r.json?.ok, false, `body=${body} 應回 ok:false，實得：${r.text}`);
      assert.equal(r.json?.error?.name, 'BadRequest', `body=${body} 應回 BadRequest，實得：${r.text}`);

      // 關鍵：daemon 不能因為這個請求而死掉
      const h = await healthOk();
      assert.equal(h.status, 200, `body=${body} 之後 /health 應為 200，實得 ${h.status}（daemon 可能已崩潰）`);
    }

    // --- Bug 2：body 超過 1 MiB ---
    const bigBody = JSON.stringify({ id: 7, method: 'status', params: {}, pad: 'a'.repeat(2 * ONE_MIB) });
    assert.ok(bigBody.length > ONE_MIB, '測試 body 必須大於 1 MiB');

    const large = await rpc(bigBody);
    assert.equal(large.status, 413, `2 MiB body 應回 413，實得 ${large.status}: ${large.text}`);
    assert.equal(large.json?.ok, false, `413 應回 ok:false，實得：${large.text}`);
    assert.equal(large.json?.error?.name, 'PayloadTooLarge', `413 應回 PayloadTooLarge，實得：${large.text}`);

    const after = await healthOk();
    assert.equal(after.status, 200, `413 之後 /health 應為 200，實得 ${after.status}`);
    assert.equal(JSON.parse(after.body).ok, true, `/health 應回 ok:true，實得：${after.body}`);
  } finally {
    await stopChild();
    rmSync(home, { recursive: true, force: true });
  }
});
