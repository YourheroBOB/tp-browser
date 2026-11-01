// tests/test_fmb_edge_cdp.test.mjs
// 邊界與錯誤情境：daemon/cdp.js 的協議錯誤處理、逾時、斷線與 once() 過濾。
//
// 以假的 WebSocket 類別取代 globalThis.WebSocket，完全不建立網路連線；
// 所有「對端」行為都以 simulate* 輔助方法在本程序內模擬。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { Cdp, CdpError, once } from '../daemon/cdp.js';

const FAKE_WS_URL = 'ws://127.0.0.1:0/devtools/page/FAKE_VALUE_FOR_TEST';

class FakeWebSocket {
  static instances = [];

  static reset() {
    FakeWebSocket.instances = [];
  }

  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.sentFrames = [];
    this.closeCalls = 0;
    this.onopen = null;
    this.onerror = null;
    this.onclose = null;
    this.onmessage = null;
    FakeWebSocket.instances.push(this);
  }

  send(data) {
    if (this.readyState !== 1) throw new Error('fake ws: not open');
    this.sentFrames.push(data);
  }

  close() {
    this.closeCalls += 1;
    this.readyState = 3;
    this.onclose?.();
  }

  // --- 測試輔助 ---
  simulateOpen() {
    this.readyState = 1;
    this.onopen?.();
  }

  simulateError() {
    this.onerror?.();
  }

  simulateMessage(payload) {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.onmessage?.({ data });
  }

  simulatePeerClose() {
    this.readyState = 3;
    this.onclose?.();
  }

  lastFrame() {
    return JSON.parse(this.sentFrames.at(-1));
  }
}

const realWebSocket = globalThis.WebSocket;
globalThis.WebSocket = FakeWebSocket;
after(() => {
  globalThis.WebSocket = realWebSocket;
});

async function connectedCdp(label = 'edge') {
  FakeWebSocket.reset();
  const cdp = new Cdp(FAKE_WS_URL, label);
  const opening = cdp.connect(2000);
  const ws = FakeWebSocket.instances[0];
  ws.simulateOpen();
  await opening;
  return { cdp, ws };
}

test('connect：對端沒有回應時以 CDP connect timeout 拒絕', async () => {
  FakeWebSocket.reset();
  const cdp = new Cdp(FAKE_WS_URL);
  const started = Date.now();
  await assert.rejects(cdp.connect(10), /CDP connect timeout/);
  assert.ok(Date.now() - started >= 5, '應等逾時後才拒絕');
  assert.equal(cdp.ws, null);
});

test('connect：WebSocket 錯誤時以 CDP connect failed 拒絕', async () => {
  FakeWebSocket.reset();
  const cdp = new Cdp(FAKE_WS_URL);
  const opening = cdp.connect(2000);
  FakeWebSocket.instances[0].simulateError();
  await assert.rejects(opening, /CDP connect failed/);
});

test('send：尚未連線或已關閉時立即拒絕，不會排入 pending', async () => {
  const idle = new Cdp(FAKE_WS_URL);
  await assert.rejects(idle.send('Page.enable'), /CDP connection closed/);
  assert.equal(idle.pending.size, 0);

  const { cdp, ws } = await connectedCdp();
  cdp.close();
  assert.equal(ws.closeCalls, 1);
  await assert.rejects(cdp.send('Page.enable'), /CDP connection closed/);
  assert.equal(cdp.pending.size, 0);
});

test('send：帶 sessionId 時寫進 frame，不帶時不應出現該欄位', async () => {
  const { cdp, ws } = await connectedCdp();

  const withSession = cdp.send('Runtime.evaluate', { expression: '1' }, { sessionId: 'S9' });
  const frameA = ws.lastFrame();
  assert.equal(frameA.method, 'Runtime.evaluate');
  assert.equal(frameA.sessionId, 'S9');
  ws.simulateMessage({ id: frameA.id, result: {} });
  await withSession;

  const withoutSession = cdp.send('Runtime.evaluate', { expression: '2' });
  const frameB = ws.lastFrame();
  assert.equal('sessionId' in frameB, false);
  ws.simulateMessage({ id: frameB.id, result: {} });
  await withoutSession;
});

test('_recv：非 JSON、未知 id 與空物件訊息都被忽略，已知 id 正確解析', async () => {
  const { cdp, ws } = await connectedCdp();

  assert.doesNotThrow(() => ws.simulateMessage('<html>not json</html>'));
  assert.doesNotThrow(() => ws.simulateMessage({ id: 99999, result: {} }));
  assert.doesNotThrow(() => ws.simulateMessage({}));

  const pending = cdp.send('Page.navigate', { url: 'http://127.0.0.1:8765/' }, { timeout: 1000 });
  const frame = ws.lastFrame();
  assert.deepEqual(frame.params, { url: 'http://127.0.0.1:8765/' });
  ws.simulateMessage({ id: frame.id, result: { frameId: 'FAKE_FRAME' } });
  assert.deepEqual(await pending, { frameId: 'FAKE_FRAME' });
  assert.equal(cdp.pending.size, 0);
});

test('_recv：CDP error 會轉成 CdpError 並保留原始 payload', async () => {
  const { cdp, ws } = await connectedCdp();
  const pending = cdp.send('Runtime.evaluate', { expression: '1' });
  const frame = ws.lastFrame();
  const payload = { code: -32000, message: 'Cannot find context with specified id' };
  ws.simulateMessage({ id: frame.id, error: payload });

  await assert.rejects(pending, (err) => {
    assert.ok(err instanceof CdpError, '錯誤應為 CdpError');
    assert.equal(err.name, 'CdpError');
    assert.equal(err.message, `Runtime.evaluate: ${payload.message}`);
    assert.deepEqual(err.cdpError, payload);
    return true;
  });
  assert.equal(cdp.pending.size, 0);
});

test('CdpError：缺少 message 時退回 JSON 字串，不會再拋錯', () => {
  const withData = new CdpError('Target.closeTarget', { code: -1 });
  assert.equal(withData.message, 'Target.closeTarget: {"code":-1}');

  const empty = new CdpError('Foo.bar');
  assert.equal(empty.message, 'Foo.bar: undefined');
  assert.equal(empty.cdpError, undefined);
});

test('事件：sessionId 會被記錄，單一 handler 丟錯不影響其他 handler', async () => {
  const { cdp, ws } = await connectedCdp();
  const seen = [];
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.map(String).join(' '));
  try {
    cdp.onEvent(() => { throw new Error('handler boom'); });
    cdp.onEvent((ev) => seen.push(ev));
    ws.simulateMessage({ sessionId: 'S1', method: 'Page.loadEventFired', params: { timestamp: 1 } });
  } finally {
    console.error = originalError;
  }

  assert.ok(cdp.sessions.has('S1'));
  assert.deepEqual(seen, [{ sessionId: 'S1', method: 'Page.loadEventFired', params: { timestamp: 1 } }]);
  assert.ok(errors.some((m) => m.includes('handler error')), errors.join(' | ') || '(無)');
});

test('事件：params 缺省補成空物件，取消訂閱後不再收到事件', async () => {
  const { cdp, ws } = await connectedCdp();
  const seen = [];
  const off = cdp.onEvent((ev) => seen.push(ev));
  ws.simulateMessage({ method: 'Page.frameDetached' });
  off();
  ws.simulateMessage({ method: 'Page.frameDetached' });

  assert.deepEqual(seen, [{ sessionId: null, method: 'Page.frameDetached', params: {} }]);
});

test('send：逾時會拒絕並清掉 pending，之後遲到的回應不會改變結果', async () => {
  const { cdp, ws } = await connectedCdp();
  const settled = cdp.send('Page.captureScreenshot', {}, { timeout: 20 }).then(
    () => 'resolved',
    (err) => err.message,
  );
  const frame = ws.lastFrame();
  assert.match(await settled, /Page\.captureScreenshot timed out after 20ms/);
  assert.equal(cdp.pending.size, 0);
  assert.doesNotThrow(() => ws.simulateMessage({ id: frame.id, result: { data: 'FAKE' } }));
});

test('斷線：pending 全部被拒絕、onClose 回呼觸發、之後送出不排入 pending', async () => {
  const { cdp, ws } = await connectedCdp();
  const closedEvents = [];
  cdp.onClose(() => closedEvents.push('closed'));

  const settled = cdp.send('Page.enable', {}, { timeout: 5000 }).then(
    () => 'resolved',
    (err) => err.message,
  );
  ws.simulatePeerClose();

  assert.match(await settled, /CDP connection closed/);
  assert.equal(cdp.pending.size, 0);
  assert.equal(cdp.closed, true);
  assert.deepEqual(closedEvents, ['closed']);
  await assert.rejects(cdp.send('Page.enable'), /CDP connection closed/);
});

test('once：只匹配指定事件，其他事件與 sessionId 不符者都會被忽略', async () => {
  const { cdp, ws } = await connectedCdp();
  const waiting = once(cdp, 'Page.loadEventFired', { sessionId: 'S1', timeout: 1000 });

  ws.simulateMessage({ method: 'Page.loadEventFired', params: { timestamp: 1 } });
  ws.simulateMessage({ sessionId: 'S2', method: 'Page.loadEventFired', params: { timestamp: 2 } });
  ws.simulateMessage({ sessionId: 'S1', method: 'Page.loadEventFired', params: { timestamp: 3 } });

  assert.deepEqual(await waiting, { timestamp: 3 });
});

test('once：等不到事件時逾時拒絕，且逾時後不再攔截事件', async () => {
  const { cdp, ws } = await connectedCdp();
  const seen = [];
  cdp.onEvent((ev) => seen.push(ev.method));

  await assert.rejects(once(cdp, 'Page.never', { timeout: 10 }), /Page\.never event timed out after 10ms/);

  // 逾時後 once 的監聽器已解除；一般 onEvent 仍照常收到事件。
  ws.simulateMessage({ method: 'Page.never', params: {} });
  assert.deepEqual(seen, ['Page.never']);
});
