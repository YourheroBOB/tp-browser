// tests/fmb_w7_s02_cdp_reconnect.test.mjs
// 回歸測試：daemon/cdp.js 的「同一個實例重新 connect()」生命週期。
//
// 修掉的兩個缺陷：
//   1. 第一次 connect() 失敗（socket 依序觸發 onerror 與 onclose，模擬 Chrome 尚未就緒）
//      時，ws.onclose 把 this.closed 設成 true；之後即使第二次 connect() 成功（onopen）
//      也不會重設 closed，send() 因此永遠以「CDP connection closed」立即拒絕——同一個
//      實例重新連線後完全無法使用。
//   2. 舊 socket 的 onclose 若在第二次 connect() 成功之後才送達，會把 closed 設回 true、
//      拒絕新連線所有 pending 的 send，並觸發 close handlers；舊 socket 的 onmessage 同樣
//      會進入 _recv，以舊連線的 id 配對到新連線的 pending、污染事件派送。
//
// 全部以假的 globalThis.WebSocket 驅動：零網路、不接觸任何正式服務、零憑證
// （URL 一律使用 FAKE_VALUE_FOR_TEST 這類明顯假值）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Cdp, once } from '../daemon/cdp.js';

const FAKE_WS_URL = 'ws://127.0.0.1:1/devtools/browser/FAKE_VALUE_FOR_TEST';

class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.sentFrames = [];
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
    // 刻意不呼叫 onclose：模擬「本地關閉後對端尚未回 close frame」，讓測試能精準控制
    // onclose 的送達時機（晚到的舊 socket 事件正是本題的核心）。
    this.readyState = 3;
  }

  // --- 測試輔助，模擬對端行為 ---
  simulateOpen() {
    this.readyState = 1;
    this.onopen?.();
  }

  simulateError() {
    this.onerror?.();
  }

  simulatePeerClose() {
    this.readyState = 3;
    this.onclose?.();
  }

  simulateMessage(payload) {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.onmessage?.({ data });
  }

  lastFrame() {
    return JSON.parse(this.sentFrames.at(-1));
  }
}

async function withFakeWebSocket(t) {
  const original = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => { globalThis.WebSocket = original; });
}

// 第一次 connect()：Chrome 尚未就緒。lateClose=false 時依序觸發 onerror 與 onclose
// （題目的重現步驟）；true 時只觸發 onerror，把 onclose 留到重連之後才送達。
async function failingConnect(cdp, { lateClose = false } = {}) {
  const opening = cdp.connect(1000);
  const ws = FakeWebSocket.instances.at(-1);
  ws.simulateError();
  await assert.rejects(opening, /CDP connect failed/);
  assert.equal(cdp.ws, null, '失敗後不應留下任何 socket');
  if (!lateClose) ws.simulatePeerClose();
  return ws;
}

async function connectAndOpen(cdp) {
  const opening = cdp.connect(1000);
  const ws = FakeWebSocket.instances.at(-1);
  ws.simulateOpen();
  await opening;
  return ws;
}

test('重連：第一次 connect 失敗（onerror → onclose）後，重連成功即可 send 並收到回應', async (t) => {
  await withFakeWebSocket(t);
  const cdp = new Cdp(FAKE_WS_URL, 'w7-s02');

  await failingConnect(cdp);

  const ws2 = await connectAndOpen(cdp);
  assert.equal(cdp.ws, ws2);
  assert.equal(cdp.closed, false, 'open 成功後 closed 必須被重設為 false');

  const reply = cdp.send('Browser.getVersion');
  const frame = ws2.lastFrame();
  assert.equal(frame.method, 'Browser.getVersion');
  ws2.simulateMessage({ id: frame.id, result: { product: 'Fake/1.0' } });
  assert.deepEqual(await reply, { product: 'Fake/1.0' });
  assert.equal(cdp.pending.size, 0);
});

test('重連：舊 socket 晚到的 onclose／onmessage 不影響新連線', async (t) => {
  await withFakeWebSocket(t);
  const cdp = new Cdp(FAKE_WS_URL, 'w7-s02');

  const ws1 = await failingConnect(cdp, { lateClose: true });
  const ws2 = await connectAndOpen(cdp);

  let closeCalls = 0;
  cdp.onClose(() => { closeCalls += 1; });
  const pending = cdp.send('Page.enable', {}, { timeout: 5000 });
  const frame = ws2.lastFrame();

  // 舊 socket 的關閉事件姍姍來遲：新連線不得被陪葬。
  ws1.simulatePeerClose();
  assert.equal(cdp.closed, false, '舊 socket 的晚到 close 不得把 closed 設回 true');
  assert.equal(cdp.pending.size, 1, '新連線的 pending 不該被舊 socket 的晚到 close 拒絕');
  assert.equal(closeCalls, 0, 'close handler 不該因舊 socket 的晚到 close 而觸發');

  // 舊 socket 遲到的訊息同樣被忽略：不得以舊 id 配對到新連線的 pending，也不得派送事件。
  const seen = [];
  cdp.onEvent((ev) => seen.push(ev.method));
  ws1.simulateMessage({ id: frame.id, result: { stale: true } });
  ws1.simulateMessage({ method: 'Page.loadEventFired', params: { n: 1 } });
  assert.equal(cdp.pending.size, 1, '舊 socket 的回應不得配對到新連線的 pending');
  assert.deepEqual(seen, [], '舊 socket 的晚到事件不應被派送');

  // 新連線照常收到回應。
  ws2.simulateMessage({ id: frame.id, result: { ok: true } });
  assert.deepEqual(await pending, { ok: true });
  assert.equal(cdp.pending.size, 0);
  assert.equal(closeCalls, 0);
});

test('關閉：目前連線真正關閉時，pending 立即被拒、close handlers 恰好觸發一次', async (t) => {
  await withFakeWebSocket(t);
  const cdp = new Cdp(FAKE_WS_URL, 'w7-s02');
  const ws = await connectAndOpen(cdp);

  let closeCalls = 0;
  cdp.onClose(() => { closeCalls += 1; });

  const pending = cdp.send('Page.enable', {}, { timeout: 30_000 });
  const settled = pending.then(() => 'resolved', (err) => err.message);
  const waiting = once(cdp, 'Page.loadEventFired', { timeout: 30_000 });
  assert.equal(cdp.pending.size, 1);

  const started = Date.now();
  ws.simulatePeerClose(); // 目前連線真正關閉

  assert.equal(cdp.closed, true);
  assert.equal(cdp.pending.size, 0);
  assert.equal(await settled, 'CDP connection closed');
  assert.ok(Date.now() - started < 1000, `pending 應立即被拒而非等逾時（實際 ${Date.now() - started}ms）`);
  await assert.rejects(waiting, /CDP connection closed while waiting for Page\.loadEventFired/);
  assert.equal(closeCalls, 1, 'close handler 應恰好觸發一次');

  // 關閉後再 send 一律立即拒絕。
  await assert.rejects(cdp.send('Page.enable'), /CDP connection closed/);
});

test('重連：close() 之後重新 connect() 可恢復可用，舊 socket 晚到的 close 仍被忽略', async (t) => {
  await withFakeWebSocket(t);
  const cdp = new Cdp(FAKE_WS_URL, 'w7-s02');
  const ws1 = await connectAndOpen(cdp);

  cdp.close();
  assert.equal(cdp.closed, true);
  await assert.rejects(cdp.send('Page.enable'), /CDP connection closed/);

  const ws2 = await connectAndOpen(cdp);
  assert.equal(cdp.ws, ws2);
  assert.equal(cdp.closed, false, 'open 成功後 closed 必須被重設為 false');

  let closeCalls = 0;
  cdp.onClose(() => { closeCalls += 1; });

  // 舊 socket（ws1）之後才送達的 onclose 不得影響新連線。
  ws1.simulatePeerClose();
  assert.equal(cdp.closed, false);
  assert.equal(closeCalls, 0);

  const reply = cdp.send('Browser.getVersion');
  const frame = ws2.lastFrame();
  ws2.simulateMessage({ id: frame.id, result: { product: 'Fake/2.0' } });
  assert.deepEqual(await reply, { product: 'Fake/2.0' });
  assert.equal(cdp.pending.size, 0);
});
