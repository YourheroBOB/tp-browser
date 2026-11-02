// tests/bug_cdp_overlapping_connect_stale_handshake.test.mjs
// 回歸測試：同一個 Cdp 在握手完成前再次 connect()，必須把前一次握手收掉。
//
// 修掉的缺陷：connect() 只在 this.ws 已存在時才關閉舊 socket。握手期間 this.ws
// 仍是 null，於是第二次 connect() 會留下前一條 socket：
//   1. 它晚到的 onopen 把 this.ws 搶回去（或自己變成沒人關的連線）；
//   2. 它的 onmessage 繼續把失效連線的事件送進 handlers；
//   3. 第一個 connect() promise 與計時器要一直掛到逾時。
//
// 假的 globalThis.WebSocket，不建立網路連線、不接觸正式服務。
// URL 使用 FAKE_VALUE_FOR_TEST。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Cdp } from '../daemon/cdp.js';

const FAKE_WS_URL = 'ws://127.0.0.1:1/devtools/browser/FAKE_VALUE_FOR_TEST';

const timeouts = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

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

  // 不派送 onclose：用來確認前一個 connect() 是程式自己定案，而不是等 socket 事件。
  close() {
    this.closeCalls += 1;
    this.readyState = 3;
  }

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

test('握手期間再次 connect()：前一條 socket 被關閉且不能搶回現役連線', async (t) => {
  useFakeWebSocket(t);
  const cdp = new Cdp(FAKE_WS_URL, 'overlap-connect');
  try {
    const before = timeouts();
    const firstP = cdp.connect(5000);
    const firstResult = firstP.then(() => 'resolved', (err) => err);
    const first = FakeWebSocket.instances.at(-1);
    assert.equal(timeouts(), before + 1, '第一次握手應有一個逾時計時器');

    const secondP = cdp.connect(5000);
    const secondResult = secondP.then((value) => value, (err) => err);
    const second = FakeWebSocket.instances.at(-1);

    assert.notEqual(second, first);
    assert.equal(FakeWebSocket.instances.length, 2);
    assert.equal(first.closeCalls, 1, '被取代的握手 socket 應被關閉恰好一次');
    assert.equal(first.onopen, null);
    assert.equal(first.onmessage, null);
    assert.equal(first.onerror, null);
    assert.equal(first.onclose, null);
    assert.equal(cdp.connectSockets.size, 1, '只應留下最新一次握手');
    assert.equal(cdp.connectRejects.size, 1);
    assert.equal(cdp.ws, null);
    assert.equal(cdp.closed, false, '取代握手不是關閉 client');
    assert.equal(timeouts(), before + 1, '前一次握手的計時器必須清掉');

    const firstErr = await firstResult;
    assert.ok(firstErr instanceof Error);
    assert.equal(firstErr.message, `CDP connect superseded: ${FAKE_WS_URL}`);

    second.simulateOpen();
    assert.equal(await secondResult, cdp);
    assert.equal(cdp.ws, second);
    assert.equal(cdp.closed, false);
    assert.equal(timeouts(), before, '新握手成功後不應留下 connect 計時器');

    first.simulateOpen();
    assert.equal(first.closeCalls, 1, '已解除的 onopen 不得再動到這條 socket');
    assert.equal(cdp.ws, second, '晚到的舊握手不得搶回 this.ws');

    const seen = [];
    cdp.onEvent((ev) => seen.push(ev.params));
    first.simulateMessage({ method: 'Page.loadEventFired', params: { stale: true } });
    second.simulateMessage({ method: 'Page.loadEventFired', params: { fresh: true } });
    assert.deepEqual(seen, [{ fresh: true }], '失效握手的事件不得混進現役連線');

    let closeHandlerCalls = 0;
    cdp.onClose(() => { closeHandlerCalls += 1; });
    first.simulatePeerClose();
    assert.equal(cdp.closed, false, '舊握手的 close 不得拆掉現役連線');
    assert.equal(closeHandlerCalls, 0);

    const pending = cdp.send('Page.enable', {}, { timeout: 1000 });
    const frame = JSON.parse(second.sentFrames.at(-1));
    second.simulateMessage({ id: frame.id, result: { ok: true } });
    assert.deepEqual(await pending, { ok: true });
    assert.equal(cdp.pending.size, 0);
    assert.equal(timeouts(), before);
  } finally {
    cdp.close();
  }
});
