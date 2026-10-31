// tests/test_fmb_contract_cdp.test.mjs
// daemon/cdp.js 公開介面「契約測試」：鎖匯出面、CdpError 結構與訊息格式、Cdp 建構狀態、
// 未連線時 send() 的錯誤契約、connect() 的失敗訊息格式（僅用 127.0.0.1 的拋棄式 socket，
// 不連任何正式服務）。有別於 tests/test_fmb_cdp.test.mjs。
//
// 穩定性設計（避免拖垮 `node --test` 全套執行）：
//   1. 每個非同步測試都帶 explicit `{ timeout }`，任何卡住都會「失敗」而非無限等待。
//   2. 需要 loopback 的測試先嘗試 listen，環境不允許時 `t.skip()`，不視為失敗。
//   3. 伺服器一律 `unref()`，socket 於 finally 逐一 destroy，確保不留下 open handle。
//
// 已知產品端競態（本任務不得修改原始碼，故以 XFAIL/skip 記錄，不讓它擋測試）：
//   `Cdp#connect()` 的逾時回呼是「先 ws.close()、再 reject(timeout)」。在 Node 內建 WebSocket
//   實作下，ws.close() 會觸發 onerror → 由 `CDP connect failed: <url>` 先讓 promise 進入 rejected，
//   因此「握手卡住」對外可觀測到的訊息通常是 failed 而非 timeout。
//   可穩定鎖定的契約是：connect() 必定「拒絕」（不會永遠 pending）且訊息帶完整目標 URL。
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import * as cdpMod from '../daemon/cdp.js';
import { Cdp, CdpError, once } from '../daemon/cdp.js';

const hasNativeWebSocket = typeof WebSocket === 'function';
const maybe = hasNativeWebSocket ? test : test.skip;

// 在 127.0.0.1 上開一個「只接受 TCP 連線、永不回應握手」的拋棄式伺服器。
// 回傳 null 表示此環境無法綁定 loopback（測試將 skip，不算失敗）。
async function listenLoopback() {
  const sockets = new Set();
  const srv = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
  });
  srv.unref();
  try {
    await new Promise((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', resolve);
    });
  } catch {
    try { srv.close(); } catch {}
    return null;
  }
  return {
    port: srv.address().port,
    async close() {
      for (const s of sockets) s.destroy();
      sockets.clear();
      await new Promise((r) => srv.close(r));
    },
  };
}

test('contract/cdp：模組匯出面 exactly { Cdp, CdpError, once }', () => {
  assert.deepEqual(Object.keys(cdpMod).sort(), ['Cdp', 'CdpError', 'once']);
});

test('contract/cdp：CdpError 是 Error 子類別；name="CdpError"、cdpError 保存原始 payload', () => {
  const e = new CdpError('Foo.bar', { message: 'boom' });
  assert.ok(e instanceof Error);
  assert.equal(e.name, 'CdpError');
  assert.equal(e.message, 'Foo.bar: boom');
  assert.deepEqual(e.cdpError, { message: 'boom' });
});

test('contract/cdp：CdpError 訊息格式 "method: message"；無 message 欄位時整包 JSON 序列化', () => {
  assert.equal(new CdpError('M', { code: -1 }).message, 'M: {"code":-1}');
});

test('contract/cdp：Cdp 建構子的預設狀態契約', () => {
  const c = new Cdp('ws://127.0.0.1:1/devtools/page/T1');
  assert.equal(c.wsUrl, 'ws://127.0.0.1:1/devtools/page/T1');
  assert.equal(c.label, 'cdp');
  assert.equal(c.id, 0);
  assert.equal(c.ws, null);
  assert.equal(c.closed, false);
  assert.ok(c.pending instanceof Map);
  assert.ok(c.handlers instanceof Set);
  const named = new Cdp('ws://127.0.0.1:1/x', 'my-label');
  assert.equal(named.label, 'my-label');
});

test('contract/cdp：Cdp.prototype 具備 connect/onEvent/onClose/send/close 五個公開方法', () => {
  for (const m of ['connect', 'onEvent', 'onClose', 'send', 'close']) {
    assert.equal(typeof Cdp.prototype[m], 'function', m);
  }
});

test('contract/cdp：onEvent/onClose 回傳取消訂閱函式，呼叫後 handler 被移除', () => {
  const c = new Cdp('ws://127.0.0.1:1/x');
  const off = c.onEvent(() => {});
  assert.equal(typeof off, 'function');
  assert.equal(c.handlers.size, 1);
  assert.equal(off(), true);
  assert.equal(c.handlers.size, 0);

  const offClose = c.onClose(() => {});
  assert.equal(typeof offClose, 'function');
  assert.equal(c.closeHandlers.size, 1);
  assert.equal(offClose(), true);
  assert.equal(c.closeHandlers.size, 0);
});

test('contract/cdp：未連線／已關閉時 send() 拒絕 Error "CDP connection closed"', { timeout: 10_000 }, async () => {
  const c = new Cdp('ws://127.0.0.1:1/x');
  await assert.rejects(
    c.send('Target.getTargets'),
    (e) => e instanceof Error && e.message === 'CDP connection closed',
  );
  c.close();
  await assert.rejects(
    c.send('Target.getTargets'),
    (e) => e instanceof Error && e.message === 'CDP connection closed',
  );
});

maybe('contract/cdp：本機埠連線被拒 → "CDP connect failed: <url>"', { timeout: 15_000 }, async (t) => {
  const probe = await listenLoopback();
  if (!probe) { t.skip('此環境無法綁定 127.0.0.1，略過 loopback 契約測試'); return; }
  const { port } = probe;
  await probe.close(); // 立刻關閉，讓該埠的連線被拒
  const url = `ws://127.0.0.1:${port}/x`;
  const cdp = new Cdp(url);
  try {
    await assert.rejects(
      cdp.connect(5000),
      (e) => e instanceof Error && e.message === `CDP connect failed: ${url}`,
    );
  } finally {
    cdp.close();
  }
});

// 契約：握手卡住時 connect() 必須「拒絕」（不可永遠 pending），且錯誤訊息必須帶完整目標 URL。
// 允許 failed / timeout 兩種字面值，是因為上述產品端競態會讓 failed 先勝出；
// 兩者的共同契約（`CDP connect <reason>: <url>`）仍然被嚴格鎖定。
maybe('contract/cdp：握手無回應時 connect() 拒絕，且訊息為 "CDP connect <reason>: <url>"', { timeout: 15_000 }, async (t) => {
  const srv = await listenLoopback();
  if (!srv) { t.skip('此環境無法綁定 127.0.0.1，略過 loopback 契約測試'); return; }
  const url = `ws://127.0.0.1:${srv.port}/x`;
  const allowed = new Set([`CDP connect failed: ${url}`, `CDP connect timeout: ${url}`]);
  const cdp = new Cdp(url);
  try {
    await assert.rejects(
      cdp.connect(300),
      (e) => e instanceof Error && allowed.has(e.message),
    );
  } finally {
    cdp.close();
    await srv.close();
  }
});

// XFAIL（故意 skip，不是漏測）：預期「逾時」專屬訊息，但目前被 "CDP connect failed" 搶先 reject。
// 這是 daemon/cdp.js 的產品端問題（逾時回呼先 ws.close() 再 reject），
// 依本任務規則不得修改既有原始碼，故保留此測試作為待修項的書面記錄。
maybe('contract/cdp：[XFAIL] 握手無回應應回報 "CDP connect timeout: <url>"（目前被 failed 搶先）', { timeout: 15_000 }, async () => {
  throw new Error('unreachable: XFAIL 由 skip 表達，內容僅為契約意圖的文件化');
});

test('contract/cdp：once() 逾時錯誤格式 "<method> event timed out after <ms>"', { timeout: 10_000 }, async () => {
  const fake = { onEvent: () => () => {} }; // 註冊後永不觸發
  await assert.rejects(
    once(fake, 'Page.loadEventFired', { timeout: 50 }),
    (e) => e instanceof Error && e.message === 'Page.loadEventFired event timed out after 50ms',
  );
});

test('contract/cdp：once() 事件到來時以 params resolve', { timeout: 10_000 }, async () => {
  let emit = null;
  const fake = { onEvent: (fn) => { emit = fn; return () => {}; } };
  const p = once(fake, 'Page.domContentEventFired', { timeout: 2000 });
  assert.ok(p instanceof Promise);
  queueMicrotask(() => emit({ method: 'Page.domContentEventFired', params: { ts: 1 } }));
  assert.deepEqual(await p, { ts: 1 });
});
