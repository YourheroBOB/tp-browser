// tests/fmb_integration_cdp_error_paths.test.mjs — daemon/cdp.js 錯誤路徑整合測試
//
// 本版修正重點：上一版的「TCP 接受連線但永不完成 WebSocket 握手」測試會留下
// 未關閉的 socket handle，讓 `node --test` 在測試全部跑完後無法結束（rc=124 TIMEOUT）。
// 現在只有第一項使用真實 loopback socket；其餘一律以「全域 WebSocket 替身」驅動，
// 零 socket、零殘留 handle，且完全決定性。每個替身都在 try/finally 中還原。
//
// 覆蓋：
//   - 連線到無人監聽的 127.0.0.1 埠：connect() 拒絕且不掛起
//   - 握手未完成 → connect() 以 CDP connect timeout 拒絕，並嘗試關閉底層連線
//   - 握手失敗（WebSocket error）→ connect() 以 CDP connect failed 拒絕
//   - 未連線時 send() 立即拒絕（CDP connection closed）
//   - _recv 行為：success 回應、error 回應（CdpError）、事件派送與 session 記錄
//   - once() 逾時拒絕、事件送達時解析並自動解除訂閱
//   - CdpError 形狀與 onEvent 解除訂閱
//
// 測試特性：零外部依賴、絕不連線任何正式服務、零真實憑證
// （URL 與 sessionId 一律使用 FAKE_VALUE_FOR_TEST 這類明顯假值）。
// 假設 Node >= 22（WebSocket 為內建全域，與 package.json engines 一致）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';

import { Cdp, CdpError, once } from '../daemon/cdp.js';

const listen = (srv) =>
  new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
  });

test('cdp：連線到無人監聽的 127.0.0.1 埠會拒絕且不掛起', { timeout: 10_000 }, async () => {
  // 先佔一個埠再釋放，取得「保證空閒」的本機埠，避免撞到環境中的既有服務
  const probe = createServer();
  probe.unref();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));

  const cdp = new Cdp(`ws://127.0.0.1:${port}/devtools/page/FAKE_VALUE_FOR_TEST`);
  try {
    await assert.rejects(
      () => cdp.connect(3000),
      (err) => err instanceof Error && /CDP connect/.test(err.message)
    );
  } finally {
    cdp.close();
  }
});

test('cdp：握手未完成 → connect 以逾時拒絕，並嘗試關閉連線（零 socket）', { timeout: 10_000 }, async () => {
  const real = globalThis.WebSocket;
  let instance = null;
  class SilentWs {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.closedByClient = false;
      instance = this;
    }
    close() { this.closedByClient = true; this.readyState = 3; }
    send() { throw new Error('must not send before open'); }
  }
  globalThis.WebSocket = SilentWs;
  try {
    const cdp = new Cdp('ws://127.0.0.1:1/devtools/browser/FAKE_VALUE_FOR_TEST');
    await assert.rejects(() => cdp.connect(50), /CDP connect timeout/);
    assert.equal(instance.closedByClient, true);
  } finally {
    globalThis.WebSocket = real;
  }
});

test('cdp：握手失敗（WebSocket error）→ connect 以連線失敗拒絕（零 socket）', { timeout: 10_000 }, async () => {
  const real = globalThis.WebSocket;
  class FailingWs {
    constructor() {
      this.readyState = 0;
      queueMicrotask(() => { this.onerror?.(new Error('handshake rejected')); });
    }
    close() { this.readyState = 3; }
    send() {}
  }
  globalThis.WebSocket = FailingWs;
  try {
    const cdp = new Cdp('ws://127.0.0.1:1/devtools/page/FAKE_VALUE_FOR_TEST');
    await assert.rejects(() => cdp.connect(3000), /CDP connect failed/);
  } finally {
    globalThis.WebSocket = real;
  }
});

test('cdp：未連線時 send() 立即以「CDP connection closed」拒絕', async () => {
  const cdp = new Cdp('ws://127.0.0.1:1/devtools/page/FAKE_VALUE_FOR_TEST');
  await assert.rejects(() => cdp.send('Target.getTargets'), /CDP connection closed/);
});

test('cdp：已連線後 _recv 的 success／CdpError／事件派送行為（零 socket）', { timeout: 10_000 }, async () => {
  const real = globalThis.WebSocket;
  let instance = null;
  class OpenWs {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.sent = [];
      instance = this;
      queueMicrotask(() => this.onopen?.());
    }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; }
  }
  globalThis.WebSocket = OpenWs;
  try {
    const cdp = new Cdp('ws://127.0.0.1:1/devtools/page/FAKE_VALUE_FOR_TEST');
    await cdp.connect(1000);
    const ws = instance;

    // a) 成功回應 → 解析 result
    const ok = cdp.send('Browser.getVersion');
    const req1 = ws.sent[0];
    assert.equal(req1.method, 'Browser.getVersion');
    ws.onmessage({ data: JSON.stringify({ id: req1.id, result: { product: 'Fake/1.0' } }) });
    assert.deepEqual(await ok, { product: 'Fake/1.0' });

    // b) 錯誤回應 → 轉成 CdpError
    const bad = cdp.send('Target.getTargets');
    const req2 = ws.sent[1];
    ws.onmessage({ data: JSON.stringify({ id: req2.id, error: { code: -32000, message: 'boom FAKE' } }) });
    await assert.rejects(
      () => bad,
      (err) => err instanceof CdpError && /Target\.getTargets: boom FAKE/.test(err.message)
    );

    // c) 事件派送 + session 記錄 + once() 解析
    const seen = [];
    const off = cdp.onEvent((ev) => seen.push(ev));
    const waiting = once(cdp, 'Page.loadEventFired', { timeout: 1000 });
    ws.onmessage({
      data: JSON.stringify({
        sessionId: 'S-FAKE_VALUE_FOR_TEST',
        method: 'Page.loadEventFired',
        params: { timestamp: 42 },
      }),
    });
    assert.deepEqual(await waiting, { timestamp: 42 });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].sessionId, 'S-FAKE_VALUE_FOR_TEST');
    assert.equal(cdp.sessions.has('S-FAKE_VALUE_FOR_TEST'), true);
    off();
    assert.equal(cdp.handlers.size, 0);

    cdp.close();
  } finally {
    globalThis.WebSocket = real;
  }
});

test('cdp：once() 在 timeout 內等不到事件會拒絕', async () => {
  const fakeEmitter = { onEvent() { return () => {}; } };
  await assert.rejects(
    () => once(fakeEmitter, 'Page.loadEventFired', { timeout: 60 }),
    /Page\.loadEventFired event timed out/
  );
});

test('cdp：once() 事件送達時解析並自動解除訂閱', async () => {
  let handler = null;
  const fake = {
    onEvent(fn) { handler = fn; return () => { handler = null; }; },
  };
  const p = once(fake, 'Runtime.consoleAPICalled', { timeout: 2000 });
  handler({ sessionId: null, method: 'Runtime.consoleAPICalled', params: { hello: 1 } });
  assert.deepEqual(await p, { hello: 1 });
  assert.equal(handler, null); // 已透過 off() 解除訂閱
});

test('cdp：CdpError 保留 method 與原始錯誤；onEvent 可解除訂閱', () => {
  const e = new CdpError('Target.getTargets', { code: -32000, message: 'boom FAKE' });
  assert.equal(e.name, 'CdpError');
  assert.match(e.message, /Target\.getTargets: boom FAKE/);
  assert.deepEqual(e.cdpError, { code: -32000, message: 'boom FAKE' });

  const cdp = new Cdp('ws://127.0.0.1:1/devtools/page/FAKE_VALUE_FOR_TEST');
  const off = cdp.onEvent(() => {});
  assert.equal(cdp.handlers.size, 1);
  off();
  assert.equal(cdp.handlers.size, 0);
});
