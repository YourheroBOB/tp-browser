// tests/fmb_w12_s08_cdp_reconnect_supersedes_socket.test.mjs
// 回歸測試：daemon/cdp.js 的 connect() 在同一 client 上被呼叫第二次時，必須把
// 「舊的現役 socket」關掉並解除回呼。
//
// 修掉的缺陷：舊版第二次 connect() 直接覆寫 this.ws，於是
//   1. 舊 socket 永遠沒有人關閉——長期執行的 daemon 每重連一次就多洩漏一條連線；
//   2. 舊 socket 仍掛著 onmessage，會把「上一條連線」的 CDP 事件繼續派送給
//      this.handlers，呼叫端看到的是已失效連線的事件混進新連線的資料流；
//      它稍後派送的 close 也仍會走進 onclose 的一般路徑。
// 修正後舊 socket 會被關閉一次、回呼全部解除，新連線完全獨立運作。
//
// 全部以假的 globalThis.WebSocket 驅動：零網路、不接觸任何正式服務、零憑證
// （URL 一律使用 FAKE_VALUE_FOR_TEST 這類明顯假值）。
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

  // 刻意不派送 onclose：模擬「本地關閉後對端尚未回 close frame」，讓測試能分辨
  // 「程式自己收拾」與「等 socket 事件」兩種路徑。
  close() {
    this.closeCalls += 1;
    this.readyState = 3;
  }

  // --- 測試輔助，模擬對端／底層行為 ---
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

  lastFrame() {
    return JSON.parse(this.sentFrames.at(-1));
  }
}

function useFakeWebSocket(t) {
  const original = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => { globalThis.WebSocket = original; });
}

async function openCdp(t) {
  const cdp = new Cdp(FAKE_WS_URL, 'w12-s08-reconnect');
  const opening = cdp.connect(1000);
  const ws = FakeWebSocket.instances.at(-1);
  ws.simulateOpen();
  await opening;
  return { cdp, ws };
}

test('再次 connect()：舊的現役 socket 被關閉一次並解除回呼，新連線正常可用', async (t) => {
  useFakeWebSocket(t);
  const { cdp, ws: first } = await openCdp(t);

  const opening = cdp.connect(1000);
  assert.equal(first.closeCalls, 1, '被取代的舊 socket 應被關閉恰好一次');
  assert.equal(first.onmessage, null, '舊 socket 的事件回呼應被解除，不得再派送事件');
  assert.equal(first.onclose, null, '舊 socket 的 close 回呼應被解除');
  assert.equal(cdp.ws, null, '新握手完成前不應留下半掛載的 socket');

  const second = FakeWebSocket.instances.at(-1);
  assert.notEqual(second, first);
  second.simulateOpen();
  assert.equal(await opening, cdp);

  assert.equal(cdp.ws, second, '新 socket 應成為現役連線');
  assert.equal(cdp.closed, false);

  // 舊 socket 的遲到事件完全不得進入 handlers。
  const seen = [];
  cdp.onEvent((ev) => seen.push(ev.params));
  first.simulateMessage({ method: 'Page.loadEventFired', params: { stale: true } });
  assert.deepEqual(seen, [], '已失效連線的事件不得混進新連線的資料流');

  second.simulateMessage({ method: 'Page.loadEventFired', params: { fresh: true } });
  assert.deepEqual(seen, [{ fresh: true }], '新連線的事件仍應正常派送');

  // 舊 socket 的遲到 close 不得把新連線標成 closed，也不得誤發 close handler。
  let closeCalls = 0;
  cdp.onClose(() => { closeCalls += 1; });
  first.simulatePeerClose();
  assert.equal(cdp.closed, false, '舊 socket 的 close 不得拆掉較新的現役連線');
  assert.equal(closeCalls, 0, '舊 socket 的 close 不得通知 close handler');

  // 新連線仍可正常往返。
  const pending = cdp.send('Page.enable', {}, { timeout: 1000 });
  const frame = second.lastFrame();
  second.simulateMessage({ id: frame.id, result: { ok: true } });
  assert.deepEqual(await pending, { ok: true });
  assert.equal(cdp.pending.size, 0);

  cdp.close();
});

test('再次 connect()：舊 socket 上尚未完成的請求不會被連帶影響，之後由新連線回覆', async (t) => {
  useFakeWebSocket(t);
  const { cdp, ws: first } = await openCdp(t);

  const inflight = cdp.send('Page.navigate', { url: 'about:blank' }, { timeout: 1000 });
  const frame = first.lastFrame();
  assert.equal(cdp.pending.size, 1);

  // 重連：舊 socket 被關閉，但請求本身沒有被 reject（重連不是「連線結束」語意）。
  const opening = cdp.connect(1000);
  const second = FakeWebSocket.instances.at(-1);
  second.simulateOpen();
  await opening;

  assert.equal(cdp.pending.size, 1, '重連不應把等待中的請求直接丟掉');
  second.simulateMessage({ id: frame.id, result: { frameId: 'FAKE_FRAME' } });
  assert.deepEqual(await inflight, { frameId: 'FAKE_FRAME' });
  assert.equal(cdp.pending.size, 0);

  cdp.close();
});

test('close() 之後再 connect()：仍以 closed 拒絕，不會先關掉任何 socket（既有契約不變）', async (t) => {
  useFakeWebSocket(t);
  const { cdp, ws } = await openCdp(t);

  cdp.close();
  assert.equal(ws.closeCalls, 1);

  await assert.rejects(
    cdp.connect(1000),
    (err) => err instanceof Error && err.message === `CDP connect closed: ${FAKE_WS_URL}`,
  );
  assert.equal(ws.closeCalls, 1, '不應重複關閉同一條 socket');
  assert.equal(FakeWebSocket.instances.length, 1, 'closed 之後不應再建立 WebSocket');
});
