// tests/fmb_w14_s08_cdp_close_notifies_once.test.mjs
// 回歸測試：daemon/cdp.js 的 close() 必須自己通知 close handler。
//
// 修掉的缺陷：close() 會立刻拒絕 pending send，但 onClose／once() 仍只掛在
// ws.onclose 上。對端不完成關閉握手時 onclose 會晚到或不到（TCP 半開、程序已死、
// 握手卡住），once() 就停到自己的 timeout；timeout 為 Infinity 時永遠不 settle。
// 尚未建立 socket 就 close() 時，已註冊的 onClose 完全不會跑。
// 另外，同一條已關閉的 client 若再收到一次 close 事件，handler 會再被叫一次。
//
// 全部以假的 globalThis.WebSocket 驅動：零網路、不接觸任何正式服務、零憑證
// （URL 一律使用 FAKE_VALUE_FOR_TEST 這類明顯假值）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Cdp, once } from '../daemon/cdp.js';

const FAKE_WS_URL = 'ws://127.0.0.1:1/devtools/browser/FAKE_VALUE_FOR_TEST';

const timeouts = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// 修正前 once() 會停到 timeout（Infinity 則永遠不停）。用 race 讓失敗在數百毫秒內
// 變成斷言失敗，而不是把 node --test 掛住。
function settleSoon(promise, ms = 300) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve('still-pending'), ms); }),
  ]).finally(() => clearTimeout(timer));
}

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

  // 刻意不派送 onclose：模擬「本地關閉後對端尚未回 close frame」。
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

async function connectedCdp(t) {
  useFakeWebSocket(t);
  const cdp = new Cdp(FAKE_WS_URL, 'w14-s08');
  t.after(() => { cdp.close(); });
  const opening = cdp.connect(1000);
  const ws = FakeWebSocket.instances.at(-1);
  ws.simulateOpen();
  await opening;
  return { cdp, ws };
}

test('close()：尚未連線就關閉時，已註冊的 onClose 同步呼叫恰好一次', { timeout: 5_000 }, async () => {
  assert.doesNotThrow(() => new Cdp(FAKE_WS_URL, 'w14-s08').close());

  const cdp = new Cdp(FAKE_WS_URL, 'w14-s08');
  const calls = [];
  cdp.onClose(() => calls.push('kept'));
  const offDropped = cdp.onClose(() => calls.push('dropped'));
  assert.equal(offDropped(), true);

  cdp.close();
  assert.deepEqual(calls, ['kept']);
  assert.equal(cdp.closed, true);
  assert.equal(cdp.closeNotified, true);

  cdp.close();
  assert.deepEqual(calls, ['kept'], '重複 close() 不得再通知');

  let late = 0;
  const offLate = cdp.onClose(() => { late += 1; });
  assert.equal(late, 0, '關閉後註冊仍排到 microtask');
  assert.equal(offLate(), true, '補呼叫前取消應成功');
  await flushMicrotasks();
  assert.equal(late, 0, '取消掉的補呼叫不應執行');

  cdp.onClose(() => { late += 1; });
  await flushMicrotasks();
  assert.equal(late, 1);
  await delay(10);
  assert.equal(late, 1, '補呼叫只發生一次');
});

test('close()：不等 onclose，清掉 send／once 計時器，handler 看到已清空的 pending', { timeout: 5_000 }, async (t) => {
  const { cdp, ws } = await connectedCdp(t);

  const baseline = timeouts();
  let handlerCalls = 0;
  let pendingSeenByHandler = null;
  let closedSeenByHandler = null;
  cdp.onClose(() => {
    handlerCalls += 1;
    pendingSeenByHandler = cdp.pending.size;
    closedSeenByHandler = cdp.closed;
    cdp.close(); // 重入不得再通知，也不得爆堆疊
  });

  const sendSettled = cdp.send('Page.enable', {}, { timeout: 1000 }).then(
    () => 'resolved',
    (err) => err.message,
  );
  const onceSettled = once(cdp, 'Page.loadEventFired', { timeout: 1000 }).then(
    () => 'resolved',
    (err) => err.message,
  );

  assert.equal(cdp.pending.size, 1);
  assert.equal(cdp.handlers.size, 1);
  assert.equal(timeouts(), baseline + 2, 'send 與 once 各持有一個計時器');

  cdp.close();

  assert.equal(handlerCalls, 1);
  assert.equal(pendingSeenByHandler, 0, 'close handler 觀察到的 pending 必須已清空');
  assert.equal(closedSeenByHandler, true);
  assert.equal(cdp.pending.size, 0);
  assert.equal(cdp.handlers.size, 0, 'once() 應解除事件訂閱');
  assert.equal(cdp.closeHandlers.size, 1, '一般 onClose 仍留在集合，與 onclose 路徑相同');
  assert.equal(timeouts(), baseline, 'send 與 once 的計時器都應清掉');
  assert.equal(ws.closeCalls, 2, 'handler 重入 close() 會再關一次 socket，且不會無限重入');

  const [sendOutcome, onceOutcome] = await Promise.all([
    sendSettled,
    settleSoon(onceSettled),
  ]);
  assert.equal(sendOutcome, 'CDP connection closed');
  assert.equal(onceOutcome, 'CDP connection closed while waiting for Page.loadEventFired');

  ws.simulatePeerClose();
  cdp.close();
  assert.equal(handlerCalls, 1, '遲到的 onclose 與重複 close() 不得再通知');
  await assert.rejects(cdp.send('Page.enable'), /CDP connection closed/);
});

test('close()：底層 socket.close 丟錯時，handler 與 once() 仍立即收尾', { timeout: 5_000 }, async (t) => {
  const { cdp, ws } = await connectedCdp(t);
  ws.close = () => { throw new Error('close failed FAKE_VALUE_FOR_TEST'); };

  const baseline = timeouts();
  let handlerCalls = 0;
  cdp.onClose(() => { handlerCalls += 1; });
  const onceSettled = once(cdp, 'Page.frameNavigated', { timeout: Infinity }).then(
    () => 'resolved',
    (err) => err.message,
  );
  assert.equal(timeouts(), baseline, 'Infinity 不應建立計時器');

  assert.doesNotThrow(() => cdp.close());
  assert.equal(handlerCalls, 1);
  assert.equal(cdp.closed, true);
  assert.equal(cdp.handlers.size, 0);
  assert.equal(
    await settleSoon(onceSettled),
    'CDP connection closed while waiting for Page.frameNavigated',
  );
  assert.equal(timeouts(), baseline);
});

test('close()：前一個 handler 丟錯不影響 once() 與後續 handler', { timeout: 5_000 }, async (t) => {
  const { cdp } = await connectedCdp(t);
  const calls = [];
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args.map((a) => String(a)).join(' '));
  try {
    cdp.onClose(() => {
      calls.push('first');
      throw new Error('close handler boom FAKE_VALUE_FOR_TEST');
    });
    const onceSettled = once(cdp, 'Page.loadEventFired', { timeout: Infinity }).then(
      () => 'resolved',
      (err) => err.message,
    );
    cdp.onClose(() => { calls.push('third'); });

    assert.doesNotThrow(() => cdp.close());
    assert.deepEqual(calls, ['first', 'third']);
    assert.equal(logged.length, 1, `丟錯的 handler 應記錄一次：${logged.join(' | ') || '(無)'}`);
    assert.match(logged[0], /close handler error/);
    assert.match(logged[0], /close handler boom FAKE_VALUE_FOR_TEST/);
    assert.equal(
      await settleSoon(onceSettled),
      'CDP connection closed while waiting for Page.loadEventFired',
    );
    assert.equal(cdp.handlers.size, 0);
  } finally {
    console.error = originalError;
  }
});

test('close()：通知途中註冊的 onClose 不在本輪執行，microtask 補恰好一次', { timeout: 5_000 }, async () => {
  const cdp = new Cdp(FAKE_WS_URL, 'w14-s08');
  let late = 0;
  cdp.onClose(() => {
    cdp.onClose(() => { late += 1; });
  });

  cdp.close();
  assert.equal(late, 0, '本輪不得走訪中途註冊的 handler');
  assert.equal(cdp.closeHandlers.size, 1, '已關閉後的註冊走補呼叫，不塞回 closeHandlers');

  await flushMicrotasks();
  assert.equal(late, 1);
  await delay(10);
  assert.equal(late, 1, '補呼叫只發生一次');
});

test('onclose：現役 socket 斷線仍通知一次；重複 close 事件不再通知', { timeout: 5_000 }, async (t) => {
  const { cdp, ws } = await connectedCdp(t);
  let calls = 0;
  cdp.onClose(() => { calls += 1; });
  const settled = once(cdp, 'Page.loadEventFired', { timeout: 1000 }).then(
    () => 'resolved',
    (err) => err.message,
  );

  ws.simulatePeerClose();
  assert.equal(calls, 1);
  assert.equal(cdp.closed, true);
  assert.equal(cdp.closeNotified, true);
  assert.equal(await settled, 'CDP connection closed while waiting for Page.loadEventFired');
  assert.equal(cdp.handlers.size, 0);

  ws.simulatePeerClose();
  assert.equal(calls, 1, '同一條 client 的第二次 close 事件不得再通知');
});

test('握手失敗後的 close 事件不通知；之後 close() 不必等 onclose 也會通知', { timeout: 5_000 }, async (t) => {
  useFakeWebSocket(t);
  const cdp = new Cdp(FAKE_WS_URL, 'w14-s08');
  t.after(() => { cdp.close(); });

  let calls = 0;
  cdp.onClose(() => { calls += 1; });

  const opening = cdp.connect(30);
  const aborted = FakeWebSocket.instances.at(-1);
  await assert.rejects(opening, /CDP connect timeout/);
  aborted.simulatePeerClose();

  assert.equal(calls, 0, '從未連上的 socket 不得通知 close handler');
  assert.equal(cdp.closed, false);
  assert.equal(cdp.closeNotified, false);

  const retry = cdp.connect(1000);
  const ws2 = FakeWebSocket.instances.at(-1);
  assert.notEqual(ws2, aborted);
  ws2.simulateOpen();
  assert.equal(await retry, cdp);
  assert.equal(calls, 0, '重試成功不是關閉');

  cdp.close();
  assert.equal(calls, 1, '主動 close() 應同步通知，不必等 onclose');
  aborted.simulatePeerClose();
  ws2.simulatePeerClose();
  cdp.close();
  assert.equal(calls, 1);
});
