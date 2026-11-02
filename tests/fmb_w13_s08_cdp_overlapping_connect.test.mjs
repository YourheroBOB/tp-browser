// tests/fmb_w13_s08_cdp_overlapping_connect.test.mjs
// 回歸測試：daemon/cdp.js 的 connect() 在「上一次握手尚未完成」時被再次呼叫。
//
// 修掉的缺陷：同一 client 上再次 connect() 時，舊版只在 this.ws 已經掛上現役
// socket 才把舊連線關掉。握手期間 this.ws 仍是 null，於是兩次重疊的 connect()：
//   1. 舊 socket 永遠沒人關閉（長期執行的 daemon 每重疊一次就多洩漏一條連線）；
//   2. 誰先 onopen 誰寫入 this.ws，較舊的握手可以在較新的連線開始後把現役 socket
//      搶回去；已經排隊的 onmessage 仍會把失效連線的事件送進 handlers；
//   3. 較早那次 connect() 的 promise 與計時器一直留到自己的逾時才拒絕。
// 修正後較早的握手會立刻以 "CDP connect failed" 定案、解除回呼並關閉；client
// 不會被標成 closed，較新的 connect() 仍可成功。遲到的 open／message／close
// 即使拿著當初的函式參照，也不得接管現役連線。
//
// 全部以假的 globalThis.WebSocket 驅動：零網路、不接觸任何正式服務、零憑證
// （URL 一律使用 FAKE_VALUE_FOR_TEST 這類明顯假值）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Cdp } from '../daemon/cdp.js';

const FAKE_WS_URL = 'ws://127.0.0.1:1/devtools/browser/FAKE_VALUE_FOR_TEST';
const FAILED = `CDP connect failed: ${FAKE_WS_URL}`;
const CLOSED = `CDP connect closed: ${FAKE_WS_URL}`;

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

  // 刻意不派送 onclose：讓測試能分辨「程式自己關閉」與「等 socket 事件」。
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

const settledMessage = (promise) => promise.then(
  () => 'resolved',
  (err) => err.message,
);

test('重疊 connect()：進行中的握手被中止，遲到的 open／message／close 不得接管 client', async (t) => {
  useFakeWebSocket(t);
  const cdp = new Cdp(FAKE_WS_URL, 'w13-s08');
  try {
    const baseline = timeouts();
    const first = cdp.connect(1000);
    const firstWs = FakeWebSocket.instances.at(-1);
    const savedOpen = firstWs.onopen;
    const savedMessage = firstWs.onmessage;
    const savedClose = firstWs.onclose;
    const firstResult = settledMessage(first);

    assert.equal(timeouts(), baseline + 1, '第一次握手應持有一個計時器');

    const second = cdp.connect(1000);
    const secondWs = FakeWebSocket.instances.at(-1);

    assert.notEqual(secondWs, firstWs);
    assert.equal(firstWs.closeCalls, 1, '被取代的握手 socket 應被關閉恰好一次');
    assert.equal(firstWs.onopen, null, '舊 socket 的 open 回呼應被解除');
    assert.equal(firstWs.onmessage, null, '舊 socket 的 message 回呼應被解除');
    assert.equal(firstWs.onclose, null, '舊 socket 的 close 回呼應被解除');
    assert.equal(cdp.connectSockets.size, 1);
    assert.equal(cdp.connectSockets.has(secondWs), true);
    assert.equal(cdp.connectSockets.has(firstWs), false);
    assert.equal(timeouts(), baseline + 1, '舊握手計時器應清掉，只留新的');
    assert.equal(cdp.closed, false, '重疊 connect 不是關閉 client');
    assert.equal(cdp.ws, null, '新握手完成前不應留下半掛載的 socket');
    assert.equal(await firstResult, FAILED);

    const seen = [];
    let closeNotices = 0;
    cdp.onEvent((ev) => seen.push(ev.params));
    cdp.onClose(() => { closeNotices += 1; });

    const stale = { data: JSON.stringify({ method: 'Page.loadEventFired', params: { stale: true } }) };
    savedOpen();
    savedMessage(stale);
    savedClose();

    assert.equal(cdp.ws, null, '舊握手的遲到 open 不得把 socket 掛回 client');
    assert.equal(cdp.closed, false, '舊握手的遲到 close 不得把 client 標成 closed');
    assert.equal(closeNotices, 0, '從未成為現役的握手不應通知 close handler');
    assert.deepEqual(seen, [], '舊握手的遲到事件不得派送');

    secondWs.simulateOpen();
    assert.equal(await second, cdp);
    assert.equal(cdp.ws, secondWs);
    assert.equal(cdp.connectSockets.size, 0, '握手成功後不應殘留握手追蹤');

    savedOpen();
    savedMessage(stale);
    savedClose();
    assert.equal(cdp.ws, secondWs, '現役連線建立後，舊 open 不得把 socket 搶回去');
    assert.equal(cdp.closed, false);
    assert.equal(closeNotices, 0);
    assert.deepEqual(seen, []);

    secondWs.simulateMessage({ method: 'Page.loadEventFired', params: { fresh: true } });
    assert.deepEqual(seen, [{ fresh: true }], '新連線的事件仍應正常派送');

    const pending = cdp.send('Page.enable', {}, { timeout: 1000 });
    const frame = secondWs.lastFrame();
    secondWs.simulateMessage({ id: frame.id, result: { ok: true } });
    assert.deepEqual(await pending, { ok: true });
    assert.equal(cdp.pending.size, 0);

    cdp.close();
    secondWs.simulatePeerClose();
    assert.equal(closeNotices, 1, '現役連線的 close 仍應通知 close handler 一次');
    assert.equal(cdp.closed, true);
    assert.equal(timeouts(), baseline, '收尾後不應留下計時器');
  } finally {
    cdp.close();
  }
});

test('重疊 connect() 之後 close()：較新的握手以 closed 拒絕，舊的維持 failed', async (t) => {
  useFakeWebSocket(t);
  const cdp = new Cdp(FAKE_WS_URL, 'w13-s08');
  try {
    const baseline = timeouts();
    const first = cdp.connect(1000);
    const firstWs = FakeWebSocket.instances.at(-1);
    const firstResult = settledMessage(first);

    const second = cdp.connect(1000);
    const secondWs = FakeWebSocket.instances.at(-1);
    const secondResult = settledMessage(second);

    assert.equal(firstWs.closeCalls, 1);
    assert.equal(secondWs.closeCalls, 0);

    cdp.close();

    assert.equal(timeouts(), baseline, 'close() 應清掉仍在握手的計時器');
    assert.equal(cdp.connectSockets.size, 0);
    assert.equal(cdp.connectRejects.size, 0);
    assert.equal(cdp.ws, null);
    assert.equal(await firstResult, FAILED, '被取代的那一次應維持 failed，不被 close 改寫成 closed');
    assert.equal(await secondResult, CLOSED);
    assert.equal(secondWs.closeCalls, 1);
    assert.equal(cdp.closed, true);

    firstWs.simulateOpen();
    secondWs.simulateOpen();
    assert.equal(cdp.ws, null, 'close() 之後遲到的 open 不得讓 client 復活');

    await assert.rejects(
      cdp.connect(1000),
      (err) => err instanceof Error && err.message === CLOSED,
    );
    assert.equal(FakeWebSocket.instances.length, 2, 'closed 之後不應再建立 WebSocket');
  } finally {
    cdp.close();
  }
});

test('連續三次重疊 connect()：只有最後一次留下握手，前兩次都以失敗定案', async (t) => {
  useFakeWebSocket(t);
  const cdp = new Cdp(FAKE_WS_URL, 'w13-s08');
  try {
    const baseline = timeouts();
    const results = [];
    const start = () => {
      const promise = cdp.connect(1000);
      results.push(settledMessage(promise));
      return promise;
    };

    start();
    const ws1 = FakeWebSocket.instances.at(-1);
    start();
    const ws2 = FakeWebSocket.instances.at(-1);
    const third = start();
    const ws3 = FakeWebSocket.instances.at(-1);

    assert.equal(ws1.closeCalls, 1);
    assert.equal(ws2.closeCalls, 1);
    assert.equal(ws3.closeCalls, 0, '最後一次握手不應被自己中止');
    assert.equal(cdp.connectSockets.size, 1);
    assert.equal(cdp.connectSockets.has(ws3), true);
    assert.equal(timeouts(), baseline + 1, '三次重疊只應留下一個握手計時器');
    assert.deepEqual(await Promise.all(results.slice(0, 2)), [FAILED, FAILED]);

    ws1.simulateOpen();
    ws2.simulateOpen();
    assert.equal(cdp.ws, null, '已中止的握手即使後來 open 也不得掛回 client');

    ws3.simulateOpen();
    assert.equal(await third, cdp);
    assert.equal(cdp.ws, ws3);
    assert.equal(cdp.closed, false);
    assert.equal(timeouts(), baseline, '握手成功後計時器應清掉');
  } finally {
    cdp.close();
  }
});
