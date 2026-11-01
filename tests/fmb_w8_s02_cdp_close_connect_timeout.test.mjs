// tests/fmb_w8_s02_cdp_close_connect_timeout.test.mjs
// 回歸測試：daemon/cdp.js 的兩個缺陷。
//
// 1. close() 在 connect() 握手期間抵達時，舊版只設 closed=true，沒有關任何 socket；
//    之後 onopen 照樣把 ws 掛上去並 resolve，留下一條永遠不會被關閉的連線。
// 2. send()/once()/connect() 收到 Infinity 或大於 2^31-1 的 timeout 時，舊版直接交給
//    setTimeout，被 Node 夾成 1ms 並觸發 TimeoutOverflowWarning，請求幾乎立刻逾時。
//
// 全部以假的 globalThis.WebSocket 驅動：零網路、不接觸任何正式服務、零憑證
// （URL 一律使用 FAKE_VALUE_FOR_TEST 這類明顯假值）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Cdp, once } from '../daemon/cdp.js';

const FAKE_WS_URL = 'ws://127.0.0.1:1/devtools/browser/FAKE_VALUE_FOR_TEST';
const MAX_TIMEOUT_MS = 2_147_483_647;
const OVERSIZE_TIMEOUT_MS = MAX_TIMEOUT_MS + 1;

const timeouts = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

class FakeWebSocket {
  static instances = [];

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
    // 刻意不呼叫 onclose：模擬「本地關閉後對端尚未回 close frame」的狀態，
    // 讓測試能分辨「程式自己收拾」與「等 socket 事件」兩種路徑。
    this.closeCalls += 1;
    this.readyState = 3;
  }

  // --- 測試輔助，模擬對端行為 ---
  simulateOpen() {
    this.readyState = 1;
    this.onopen?.();
  }

  simulatePeerClose() {
    this.readyState = 3;
    this.onclose?.();
  }

  simulateMessage(payload) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

function useFakeWebSocket(t) {
  const original = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => { globalThis.WebSocket = original; });
}

async function connectedCdp(t) {
  useFakeWebSocket(t);
  const cdp = new Cdp(FAKE_WS_URL, 'w8-s02');
  const opening = cdp.connect(1000);
  const ws = FakeWebSocket.instances.at(-1);
  ws.simulateOpen();
  await opening;
  return { cdp, ws };
}

test('close() 先於 connect()：不建立 socket，connect 以 closed 拒絕', async (t) => {
  useFakeWebSocket(t);
  const cdp = new Cdp(FAKE_WS_URL, 'w8-s02');

  cdp.close();

  await assert.rejects(
    cdp.connect(1000),
    (err) => err instanceof Error && err.message === `CDP connect closed: ${FAKE_WS_URL}`,
  );
  assert.equal(FakeWebSocket.instances.length, 0, 'closed 之後不應再建立 WebSocket');
});

test('close() 在 connect 握手期間：晚到的 socket 被關閉，connect 以 closed 拒絕', async (t) => {
  useFakeWebSocket(t);
  const cdp = new Cdp(FAKE_WS_URL, 'w8-s02');

  const before = timeouts();
  const connecting = cdp.connect(1000);
  assert.equal(timeouts(), before + 1, '握手期間應恰好有一個 connect 計時器');

  const rejection = assert.rejects(connecting, (err) => {
    assert.ok(err instanceof Error);
    assert.equal(err.message, `CDP connect closed: ${FAKE_WS_URL}`);
    assert.doesNotMatch(err.message, /CDP connect timeout|CDP connect failed/);
    return true;
  });

  const ws = FakeWebSocket.instances.at(-1);
  cdp.close();

  assert.equal(cdp.closed, true);
  assert.ok(ws.closeCalls >= 1, 'close() 應主動關閉握手中的 socket');
  assert.equal(timeouts(), before, 'close() 應清掉握手計時器');

  await rejection;

  ws.simulateOpen(); // 晚到的 open

  assert.equal(cdp.ws, null, '握手已失敗，晚到的 open 不得讓 client 看似可用');
  assert.ok(ws.closeCalls >= 2, '晚到的 open 也必須再關一次 socket');
  await assert.rejects(cdp.send('Page.enable'), /CDP connection closed/);
});

test('connect：timeout: Infinity 不建立逾時計時器；延遲的 open 仍可 resolve', async (t) => {
  useFakeWebSocket(t);
  const cdp = new Cdp(FAKE_WS_URL, 'w8-s02');

  const before = timeouts();
  const opening = cdp.connect(Infinity);
  assert.equal(timeouts(), before, 'Infinity 不應留下 Timeout 資源');

  const ws = FakeWebSocket.instances.at(-1);
  await delay(30);
  ws.simulateOpen();

  assert.equal(await opening, cdp);
  assert.equal(cdp.ws, ws);
  cdp.close();
});

test('send：timeout: Infinity 不會被 Node 當成 1ms；延遲回應仍可 resolve', async (t) => {
  const { cdp, ws } = await connectedCdp(t);

  const before = timeouts();
  const pending = cdp.send('Page.enable', {}, { timeout: Infinity });
  assert.equal(timeouts(), before, 'Infinity 不應留下 Timeout 資源');

  const frame = JSON.parse(ws.sentFrames.at(-1));
  await delay(30);
  ws.simulateMessage({ id: frame.id, result: { ok: true } });

  assert.deepEqual(await pending, { ok: true });
  assert.equal(cdp.pending.size, 0);
  assert.equal(timeouts(), before);
  cdp.close();
});

test('send：timeout 大於 2^31-1 不會被 Node 當成 1ms；回應後清掉夾位計時器', async (t) => {
  const { cdp, ws } = await connectedCdp(t);

  const before = timeouts();
  const pending = cdp.send('Page.enable', {}, { timeout: OVERSIZE_TIMEOUT_MS });
  assert.equal(timeouts(), before + 1, '超大值應夾到 2^31-1，不可被當成 1ms');

  const frame = JSON.parse(ws.sentFrames.at(-1));
  await delay(30);
  ws.simulateMessage({ id: frame.id, result: { ok: true } });

  assert.deepEqual(await pending, { ok: true });
  assert.equal(cdp.pending.size, 0);
  assert.equal(timeouts(), before, '回應到達後計時器應被清掉');
  cdp.close();
});

test('send：timeout: Infinity 沒有逾時計時器，但連線關閉仍立即拒絕', async (t) => {
  const { cdp, ws } = await connectedCdp(t);

  const before = timeouts();
  const settled = cdp.send('Page.enable', {}, { timeout: Infinity }).then(
    () => 'resolved',
    (err) => err.message,
  );
  assert.equal(timeouts(), before, 'Infinity 不應留下 Timeout 資源');

  ws.simulatePeerClose();

  assert.equal(await settled, 'CDP connection closed');
  assert.equal(cdp.pending.size, 0);
  assert.equal(timeouts(), before);
});

test('once：timeout: Infinity 不會被 Node 當成 1ms；延遲事件仍可 resolve', async (t) => {
  const { cdp, ws } = await connectedCdp(t);

  const before = timeouts();
  const waiting = once(cdp, 'Page.loadEventFired', { timeout: Infinity });
  assert.equal(timeouts(), before, 'Infinity 不應留下 Timeout 資源');

  await delay(30);
  ws.simulateMessage({ method: 'Page.loadEventFired', params: { n: 1 } });

  assert.deepEqual(await waiting, { n: 1 });
  assert.equal(cdp.handlers.size, 0);
  assert.equal(cdp.closeHandlers.size, 0);
  cdp.close();
});

test('once：timeout 大於 2^31-1 不會被 Node 當成 1ms；回應後清掉夾位計時器', async (t) => {
  const { cdp, ws } = await connectedCdp(t);

  const before = timeouts();
  const waiting = once(cdp, 'Page.frameNavigated', { timeout: OVERSIZE_TIMEOUT_MS });
  assert.equal(timeouts(), before + 1, '超大值應夾到 2^31-1，不可被當成 1ms');

  await delay(30);
  ws.simulateMessage({ method: 'Page.frameNavigated', params: { frameId: 'FAKE_FRAME' } });

  assert.deepEqual(await waiting, { frameId: 'FAKE_FRAME' });
  assert.equal(cdp.handlers.size, 0);
  assert.equal(cdp.closeHandlers.size, 0);
  assert.equal(timeouts(), before, '事件到達後計時器應被清掉');
  cdp.close();
});
