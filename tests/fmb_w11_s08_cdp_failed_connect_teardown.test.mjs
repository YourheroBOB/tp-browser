// tests/fmb_w11_s08_cdp_failed_connect_teardown.test.mjs
// 回歸測試：daemon/cdp.js 的 ws.onclose 只能處理「本 client 現役 socket」的關閉。
//
// 修掉的缺陷：connect() 逾時或握手失敗後被中止（ws.close()）的 socket，真實 WebSocket
// 仍會派送 close 事件（Node 內建實作在 abort 握手時就是如此）。舊版 ws.onclose 只看
// settled，一旦 settled 就無條件進入「連線結束」分支，於是：
//   1. 從未連上的 client 被永久標成 closed=true，之後重試 connect() 一律以
//      "CDP connect closed: <url>" 失敗——一次暫時性失敗就讓 client 報廢。
//   2. 對「從未建立」的連線誤發 close handler（daemon 的重新附掛邏輯因此被誤觸發）。
//   3. 被較新 connect() 取代的舊 socket，其 close 事件會拆掉現役連線。
//
// 全部以假的 globalThis.WebSocket 驅動：零網路、不接觸任何正式服務、零憑證
// （URL／sessionId 一律使用 FAKE_VALUE_FOR_TEST 這類明顯假值）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Cdp } from '../daemon/cdp.js';

const FAKE_WS_URL = 'ws://127.0.0.1:1/devtools/browser/FAKE_VALUE_FOR_TEST';

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
    // 刻意不主動回呼 onclose：真實 WebSocket 中止握手後是「非同步」派送 close，
    // 因此測試用 simulatePeerClose() 明確控制派送時機。
    this.closeCalls += 1;
    this.readyState = 3;
  }

  // --- 測試輔助，模擬對端／底層行為 ---
  simulateOpen() {
    this.readyState = 1;
    this.onopen?.();
  }

  simulateError() {
    this.onerror?.(new Error('handshake failed FAKE_VALUE_FOR_TEST'));
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
  const cdp = new Cdp(FAKE_WS_URL, 'w11-s08');
  const opening = cdp.connect(1000);
  const ws = FakeWebSocket.instances.at(-1);
  ws.simulateOpen();
  await opening;
  return { cdp, ws };
}

test('connect 逾時後被中止的 socket 送出 close：不得把 client 永久標成 closed，重試必須可行', async (t) => {
  useFakeWebSocket(t);
  const cdp = new Cdp(FAKE_WS_URL, 'w11-s08');

  const opening = cdp.connect(20);
  const aborted = FakeWebSocket.instances.at(-1);
  await assert.rejects(opening, /CDP connect timeout/);
  assert.equal(cdp.ws, null);

  let closeHandlerCalls = 0;
  cdp.onClose(() => { closeHandlerCalls += 1; });

  // 真實 WebSocket 中止握手後仍會派送 close。
  aborted.simulatePeerClose();

  assert.equal(cdp.closed, false, '握手失敗不應把 client 標成 closed，否則重試永遠失敗');
  assert.equal(closeHandlerCalls, 0, '從未建立的連線不應通知 close handler');
  assert.equal(cdp.ws, null);
  await assert.rejects(cdp.send('Page.enable'), /CDP connection closed/);

  // 重試：一次暫時性失敗之後仍必須能連上並正常使用。
  const retry = cdp.connect(1000);
  const ws2 = FakeWebSocket.instances.at(-1);
  assert.notEqual(ws2, aborted, '重試應建立新的 socket');
  ws2.simulateOpen();
  assert.equal(await retry, cdp);
  assert.equal(cdp.ws, ws2);
  assert.equal(cdp.closed, false);

  const pending = cdp.send('Page.enable', {}, { timeout: 1000 });
  const frame = JSON.parse(ws2.sentFrames.at(-1));
  ws2.simulateMessage({ id: frame.id, result: { ok: true } });
  assert.deepEqual(await pending, { ok: true });

  // 舊的 aborted socket 再派送一次 close，也不得拆掉現役連線。
  aborted.simulatePeerClose();
  assert.equal(cdp.closed, false, '舊 socket 的 close 不得影響較新的現役連線');
  assert.equal(closeHandlerCalls, 0);

  const stillWorks = cdp.send('Page.navigate', { url: 'about:blank' }, { timeout: 1000 });
  const frame2 = JSON.parse(ws2.sentFrames.at(-1));
  ws2.simulateMessage({ id: frame2.id, result: { frameId: 'FAKE_FRAME' } });
  assert.deepEqual(await stillWorks, { frameId: 'FAKE_FRAME' });

  cdp.close();
});

test('connect 以 onerror 失敗後 socket 的 close：同樣不得標成 closed，也不得誤發 close handler', async (t) => {
  useFakeWebSocket(t);
  const cdp = new Cdp(FAKE_WS_URL, 'w11-s08');

  const opening = cdp.connect(1000);
  const ws = FakeWebSocket.instances.at(-1);
  const rejection = assert.rejects(opening, /CDP connect failed/);
  let closeHandlerCalls = 0;
  cdp.onClose(() => { closeHandlerCalls += 1; });

  ws.simulateError(); // 握手被拒
  await rejection;

  ws.simulatePeerClose(); // 底層隨後派送 close

  assert.equal(cdp.closed, false, '失敗的握手不應讓 client 變成 closed');
  assert.equal(closeHandlerCalls, 0, '從未建立的連線不應通知 close handler');
  assert.equal(cdp.ws, null);

  // 之後仍可重試。
  const retry = cdp.connect(1000);
  const ws2 = FakeWebSocket.instances.at(-1);
  ws2.simulateOpen();
  assert.equal(await retry, cdp);
  assert.equal(cdp.ws, ws2);

  cdp.close();
});

test('現役 socket 的 close 仍會標記 closed、拒絕 pending 並通知 close handler（修正不影響正常路徑）', async (t) => {
  const { cdp, ws } = await connectedCdp(t);

  let closeHandlerCalls = 0;
  cdp.onClose(() => { closeHandlerCalls += 1; });

  const settled = cdp.send('Page.enable', {}, { timeout: 30_000 }).then(
    () => 'resolved',
    (err) => err.message,
  );

  ws.simulatePeerClose();

  assert.equal(cdp.closed, true);
  assert.equal(closeHandlerCalls, 1);
  assert.equal(await settled, 'CDP connection closed');
  assert.equal(cdp.pending.size, 0);
  await assert.rejects(cdp.send('Page.enable'), /CDP connection closed/);
});

test('呼叫端已 close() 時，握手 socket 的 close 仍會通知已註冊的 close handler', async (t) => {
  useFakeWebSocket(t);
  const cdp = new Cdp(FAKE_WS_URL, 'w11-s08');

  let closeHandlerCalls = 0;
  cdp.onClose(() => { closeHandlerCalls += 1; });

  const opening = cdp.connect(1000);
  const ws = FakeWebSocket.instances.at(-1);
  const rejection = assert.rejects(opening, /CDP connect closed/);

  cdp.close();
  ws.simulatePeerClose(); // 真實 WebSocket 關閉握手中的 socket 後會派送 close

  await rejection;
  assert.equal(cdp.closed, true);
  assert.equal(closeHandlerCalls, 1, '呼叫端主動 close() 時仍應通知 close handler 一次');
  assert.equal(cdp.ws, null);
});

test('close() 冪等：握手期間 close() 會清空追蹤集合，重複 close() 不再關同一個 socket', async (t) => {
  useFakeWebSocket(t);
  const cdp = new Cdp(FAKE_WS_URL, 'w11-s08');

  const opening = cdp.connect(1000);
  const ws = FakeWebSocket.instances.at(-1);
  const rejection = assert.rejects(opening, /CDP connect closed/);

  assert.equal(cdp.connectSockets.size, 1, '握手期間應追蹤該 socket');
  assert.equal(cdp.connectRejects.size, 1, '握手期間應追蹤該 reject 回呼');

  cdp.close();
  await rejection;

  // 集合若未清空，長期執行的 daemon 會累積永不釋放的 socket 與回呼參照。
  assert.equal(cdp.connectSockets.size, 0, 'close() 後不應殘留握手中的 socket 參照');
  assert.equal(cdp.connectRejects.size, 0, 'close() 後不應殘留 connect reject 回呼');
  assert.equal(ws.closeCalls, 1, 'close() 應恰好關閉該 socket 一次');

  // close() 必須可重複呼叫（daemon 的關閉路徑可能來自多個來源）。
  assert.doesNotThrow(() => cdp.close());
  assert.equal(ws.closeCalls, 1, '第二次 close() 不應重複關閉同一個 socket');
  assert.equal(cdp.closed, true);
});
