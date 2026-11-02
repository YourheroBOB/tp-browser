// tests/muse1103_test_daemon_cdp.test.mjs — daemon/cdp.js 邊界與錯誤路徑補充測試
//
// 覆蓋既有測試未觸及的重要行為（全零 socket、全 FakeWebSocket、決定性）：
//   - send 逾時訊息與 pending 清理；Infinity send 不設 timer、靠 close() 收尾
//   - ws.send 同步丟錯時立即拒絕且不殘留 pending／timer
//   - _recv 忽略損毀 JSON 與非物件訊息（null／陣列／純量）且不派送
//   - onEvent 派送隔離：handler 丟錯不影響他人；派送中註冊的不吃當輪事件
//   - 已 close 後註冊 onClose：microtask 補呼叫、可取消、只通知一次、丟錯隔離
//   - 重複 connect() 解除掛載舊 socket（回呼清空＋close＋舊事件不再派送）
//   - 握手失敗後的 close frame 不污染 client（仍可重試並成功）
//   - once() 的 method／sessionId 過濾
//   - 負數 timeout 正規化為 0（立即逾時）
//
// 零外部依賴、不連線任何服務、URL 與 sessionId 皆為明顯假值。
import test from 'node:test';
import assert from 'node:assert/strict';

import { Cdp, CdpError, once } from '../daemon/cdp.js';

const FAKE_URL = 'ws://127.0.0.1:1/devtools/page/FAKE_VALUE_FOR_TEST';

class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.closeCalls = 0;
    this.onopen = null;
    this.onerror = null;
    this.onclose = null;
    this.onmessage = null;
    FakeWebSocket.instances.push(this);
  }
  send(data) {
    if (this.readyState !== 1) throw new Error('fake ws: not open');
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closeCalls += 1;
    this.readyState = 3;
  }
  simulateOpen() {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(data) {
    this.onmessage?.({ data });
  }
}

function useFakeWs(t) {
  const original = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => { globalThis.WebSocket = original; });
  return () => FakeWebSocket.instances.at(-1);
}

async function connectedCdp(t, label = 'muse1103') {
  const last = useFakeWs(t);
  const cdp = new Cdp(FAKE_URL, label);
  const opening = cdp.connect(1000);
  last().simulateOpen();
  await opening;
  return { cdp, ws: last() };
}

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
const timeoutCount = () =>
  process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

test('send 逾時：以 method 標示拒絕並清掉 pending', async (t) => {
  const { cdp } = await connectedCdp(t);
  t.after(() => cdp.close());
  await assert.rejects(
    () => cdp.send('Target.getTargets', {}, { timeout: 20 }),
    (err) => err instanceof Error && /Target\.getTargets timed out after 20ms/.test(err.message),
  );
  assert.equal(cdp.pending.size, 0);
});

test('send timeout Infinity：不設 timer，close() 時以 connection closed 收尾', async (t) => {
  const { cdp } = await connectedCdp(t);
  const baseline = timeoutCount();
  const p = cdp.send('Browser.getVersion', {}, { timeout: Infinity }).then(
    () => 'resolved',
    (err) => err.message,
  );
  assert.equal(timeoutCount(), baseline, 'Infinity 不應持有計時器');
  cdp.close();
  assert.equal(await p, 'CDP connection closed');
  assert.equal(cdp.pending.size, 0);
});

test('send 時 ws.send 同步丟錯：立即拒絕且不殘留 pending／timer', async (t) => {
  const { cdp, ws } = await connectedCdp(t);
  t.after(() => cdp.close());
  const baseline = timeoutCount();
  ws.send = () => { throw new Error('fake ws: closing race'); };
  await assert.rejects(() => cdp.send('Page.navigate'), /fake ws: closing race/);
  assert.equal(cdp.pending.size, 0);
  assert.equal(timeoutCount(), baseline);
});

test('_recv 忽略損毀 JSON 與非物件訊息', async (t) => {
  const { cdp, ws } = await connectedCdp(t);
  t.after(() => cdp.close());
  let calls = 0;
  const off = cdp.onEvent(() => { calls += 1; });
  t.after(off);
  for (const raw of ['not json{', '', 'null', '[1,2]', '"str"', '42', 'true']) {
    ws.emit(raw); // 不可丟錯
  }
  ws.emit(JSON.stringify({ id: 9999, result: {} })); // 無人等待的 id：忽略
  assert.equal(calls, 0);
  assert.equal(cdp.pending.size, 0);
});

test('onEvent 派送隔離：丟錯不中斷他人；派送中註冊的不吃當輪事件', async (t) => {
  const { cdp, ws } = await connectedCdp(t);
  t.after(() => cdp.close());
  const seen = [];
  const errors = [];
  const origError = console.error;
  console.error = (...args) => { errors.push(args); };
  t.after(() => { console.error = origError; });
  let lateCalls = 0;
  const late = () => { lateCalls += 1; };
  cdp.onEvent(() => { throw new Error('boom FAKE'); });
  cdp.onEvent(() => { seen.push('second'); });
  cdp.onEvent(() => { cdp.onEvent(late); seen.push('registrar'); });
  ws.emit(JSON.stringify({ method: 'Page.loadEventFired', params: {} }));
  assert.deepEqual(seen, ['second', 'registrar']);
  assert.equal(lateCalls, 0, '派送中註冊的 handler 不可吃到當輪事件');
  assert.equal(errors.length, 1);
  ws.emit(JSON.stringify({ method: 'Page.loadEventFired', params: {} }));
  assert.equal(lateCalls, 1, '下一輪事件應送達後註冊者');
});

test('已 close 後註冊 onClose：microtask 補呼叫、可取消、只一次、丟錯隔離', async (t) => {
  const cdp = new Cdp(FAKE_URL, 'muse1103-onclose');
  cdp.close();
  let cancelled = 0;
  const offCancelled = cdp.onClose(() => { cancelled += 1; });
  assert.equal(offCancelled(), true, '補呼叫前取消應回傳 true');
  assert.equal(offCancelled(), false, '已取消後再 off 應回傳 false');

  const order = [];
  cdp.onClose(() => { throw new Error('close boom FAKE'); });
  cdp.onClose(() => { order.push('second'); });
  const errors = [];
  const origError = console.error;
  console.error = (...args) => { errors.push(args); };
  try {
    await tick();
  } finally {
    console.error = origError;
  }
  assert.equal(cancelled, 0, '已取消的 handler 不可被呼叫');
  assert.deepEqual(order, ['second']);
  assert.equal(errors.length, 1, '丟錯的 close handler 應被記錄且不中斷後續');
});

test('重複 connect()：舊 socket 回呼清空＋被關閉＋舊事件不再派送', async (t) => {
  const last = useFakeWs(t);
  const cdp = new Cdp(FAKE_URL, 'muse1103-reconnect');
  t.after(() => cdp.close());
  const first = cdp.connect(1000);
  const oldWs = last();
  oldWs.simulateOpen();
  await first;

  const seen = [];
  const off = cdp.onEvent((ev) => seen.push(ev.method));
  t.after(off);

  const second = cdp.connect(1000);
  const newWs = last();
  assert.notEqual(newWs, oldWs);
  newWs.simulateOpen();
  await second;

  assert.equal(oldWs.closeCalls, 1, '舊 socket 應被關閉');
  assert.equal(oldWs.onopen, null);
  assert.equal(oldWs.onmessage, null);
  assert.equal(oldWs.onerror, null);
  assert.equal(oldWs.onclose, null);

  oldWs.emit(JSON.stringify({ method: 'Page.loadEventFired', params: {} }));
  assert.equal(seen.length, 0, '舊連線的事件不可混進新連線');
  newWs.emit(JSON.stringify({ method: 'Page.loadEventFired', params: {} }));
  assert.deepEqual(seen, ['Page.loadEventFired']);
});

test('握手失敗後的 close frame 不污染 client：仍可重試並成功', async (t) => {
  const last = useFakeWs(t);
  const cdp = new Cdp(FAKE_URL, 'muse1103-retry');
  t.after(() => cdp.close());
  const bad = cdp.connect(1000);
  const badWs = last();
  badWs.onerror?.(new Error('handshake rejected FAKE'));
  await assert.rejects(() => bad, /CDP connect failed/);
  badWs.onclose?.(); // 真實 socket 稍後仍會派送 close
  assert.equal(cdp.closed, false, '從未連上的 client 不可被標成 closed');

  const retry = cdp.connect(1000);
  last().simulateOpen();
  await retry;
  assert.equal(cdp.closed, false);
  const ok = cdp.send('Browser.getVersion');
  const req = last().sent[0];
  last().emit(JSON.stringify({ id: req.id, result: { product: 'Fake/1.0' } }));
  assert.deepEqual(await ok, { product: 'Fake/1.0' });
});

test('once() 只接受 method 與 sessionId 都相符的事件', async (t) => {
  const { cdp, ws } = await connectedCdp(t);
  t.after(() => cdp.close());
  const p = once(cdp, 'Page.frameNavigated', { sessionId: 'S-FAKE', timeout: 1000 });
  ws.emit(JSON.stringify({ method: 'Runtime.consoleAPICalled', params: { a: 1 } }));
  ws.emit(JSON.stringify({ sessionId: 'S-OTHER', method: 'Page.frameNavigated', params: { b: 2 } }));
  let settled = false;
  void p.then(() => { settled = true; });
  await tick();
  assert.equal(settled, false, '不相符的事件不可提前解析');
  ws.emit(JSON.stringify({ sessionId: 'S-FAKE', method: 'Page.frameNavigated', params: { b: 3 } }));
  assert.deepEqual(await p, { b: 3 });
  assert.equal(cdp.handlers.size, 0, '解析後應自動解除訂閱');
});

test('負數 send timeout 正規化為 0：立即逾時', async (t) => {
  const { cdp } = await connectedCdp(t);
  t.after(() => cdp.close());
  await assert.rejects(
    () => cdp.send('Page.navigate', {}, { timeout: -5 }),
    /Page\.navigate timed out after 0ms/,
  );
  assert.equal(cdp.pending.size, 0);
});

test('CdpError 在 data 缺少 message 時以後備字串組成訊息', () => {
  const e = new CdpError('Target.attachToTarget', undefined);
  assert.equal(e.name, 'CdpError');
  assert.match(e.message, /Target\.attachToTarget/);
});
