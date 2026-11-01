// tests/fmb_w6_s01_cdp_handler_snapshot.test.mjs
// 回歸測試：daemon/cdp.js 的事件分派必須以「分派開始時的快照」迭代 handlers／closeHandlers。
//
// 修掉的兩個缺陷：
//   1. _recv 直接 `for (const fn of this.handlers)` 迭代 Set。Set 迭代器會走訪迭代期間
//      新增的元素，因此 handler 在分派中途註冊的監聽器（最典型是 once()）會吃到「觸發
//      它的那一個事件」：once(cdp, 'Page.frameNavigated') 在第一次 Page.frameNavigated
//      就被 resolve 成該事件的 params（過期事件）。同理，handler 若在分派中途 off() 後
//      重新註冊同一個函式，同一輪會被呼叫兩次（重複呼叫）。
//   2. ws.onclose 也直接迭代 closeHandlers：close handler 在分派中途 off() 另一個
//      close handler 時，後者會被跳過（漏呼叫）。
//
// 全部以 fake WebSocket／直接呼叫 _recv 驅動：零網路、不接觸任何正式服務、零憑證
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
    this.onopen = null;
    this.onerror = null;
    this.onclose = null;
    this.onmessage = null;
    FakeWebSocket.instances.push(this);
  }

  send() {
    if (this.readyState !== 1) throw new Error('fake ws: not open');
  }

  close() {
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
}

async function connectedCdp(t, label) {
  const original = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => { globalThis.WebSocket = original; });

  const cdp = new Cdp(FAKE_WS_URL, label);
  const opening = cdp.connect(1000);
  const ws = FakeWebSocket.instances.at(-1);
  ws.simulateOpen();
  await opening;
  return { cdp, ws };
}

const recv = (cdp, method, params = {}) => cdp._recv(JSON.stringify({ method, params }));

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test('_recv：分派中途註冊的 once() 不會被觸發它的同一個事件 resolve', async () => {
  const cdp = new Cdp(FAKE_WS_URL, 'w6-s01');
  let waiting = null;
  cdp.onEvent((ev) => {
    if (ev.method === 'Page.frameNavigated' && waiting === null) {
      waiting = once(cdp, 'Page.frameNavigated', { timeout: 5000 });
    }
  });

  // 第一個事件：observer 在分派途中註冊 once()。修正後 once() 不在本輪快照內，
  // 因此不得拿到 { n: 1 }。
  recv(cdp, 'Page.frameNavigated', { n: 1 });
  let firstResult = null;
  const tracked = waiting.then((value) => { firstResult = value; return value; });

  await flushMicrotasks();
  assert.equal(firstResult, null, 'once() 不應吃到觸發它的那一個事件');
  assert.equal(cdp.handlers.size, 2, 'observer 與 once() 的監聽器都仍在等待');
  assert.equal(cdp.closeHandlers.size, 1, 'once() 等待期間應保留 close 訂閱');

  // 第二個事件才輪到 once()。
  recv(cdp, 'Page.frameNavigated', { n: 2 });
  assert.deepEqual(await tracked, { n: 2 }, '第二個事件才應 resolve');
  assert.equal(cdp.handlers.size, 1, 'once() 解析後應解除事件訂閱');
  assert.equal(cdp.closeHandlers.size, 0, 'once() 解析後應解除 close 訂閱');
});

test('_recv：分派中途 off() 其他 handler 不會漏呼叫，也不會重複呼叫', () => {
  const cdp = new Cdp(FAKE_WS_URL, 'w6-s01');
  const calls = [];
  let offSecond = () => false;
  cdp.onEvent(() => { calls.push('first'); offSecond(); });
  offSecond = cdp.onEvent(() => { calls.push('second'); });
  cdp.onEvent(() => { calls.push('third'); });

  recv(cdp, 'Page.loadEventFired');
  assert.deepEqual(calls, ['first', 'second', 'third'], '本輪開始時已註冊的 handler 都必須被呼叫恰好一次');
  assert.equal(cdp.handlers.size, 2, '被 off() 的 handler 應自集合移除');

  recv(cdp, 'Page.loadEventFired');
  assert.deepEqual(calls, ['first', 'second', 'third', 'first', 'third'], '已移除的 handler 不再收到後續事件');
});

test('_recv：handler 分派中途 off() 自己，仍恰好被呼叫一次且不再收到後續事件', () => {
  const cdp = new Cdp(FAKE_WS_URL, 'w6-s01');
  const calls = [];
  let offSelf = () => false;
  offSelf = cdp.onEvent(() => { calls.push('self'); assert.equal(offSelf(), true, '第一次 off() 應成功'); });
  cdp.onEvent(() => { calls.push('keep'); });

  recv(cdp, 'Page.lifecycleEvent');
  assert.deepEqual(calls, ['self', 'keep']);
  assert.equal(cdp.handlers.size, 1);

  recv(cdp, 'Page.lifecycleEvent');
  assert.deepEqual(calls, ['self', 'keep', 'keep'], '自我移除後不應再收到事件');
});

test('_recv：分派中途 off() 後重新註冊同一函式，同一事件不會被呼叫兩次', () => {
  const cdp = new Cdp(FAKE_WS_URL, 'w6-s01');
  const calls = [];
  let off = () => false;
  const fn = () => {
    calls.push('fn');
    off();
    off = cdp.onEvent(fn); // 中途重新註冊（Set 會把它排到最後）
  };
  off = cdp.onEvent(fn);

  recv(cdp, 'Target.targetInfoChanged');
  assert.deepEqual(calls, ['fn'], '快照迭代下同一輪只能被呼叫一次');

  recv(cdp, 'Target.targetInfoChanged');
  assert.deepEqual(calls, ['fn', 'fn']);
  assert.equal(cdp.handlers.size, 1);
});

test('_recv：分派中途新增的一般 onEvent 只收到後續事件，不會回溯本次事件', () => {
  const cdp = new Cdp(FAKE_WS_URL, 'w6-s01');
  const seen = [];
  let registered = false;
  cdp.onEvent((ev) => {
    seen.push(`observer:${ev.params.n ?? '-'}`);
    if (!registered) {
      registered = true;
      cdp.onEvent((e) => seen.push(`late:${e.params.n ?? '-'}`));
    }
  });

  recv(cdp, 'Runtime.consoleAPICalled', { n: 1 });
  assert.deepEqual(seen, ['observer:1'], '中途註冊的 handler 不應收到本次事件');
  assert.equal(cdp.handlers.size, 2);

  recv(cdp, 'Runtime.consoleAPICalled', { n: 2 });
  assert.deepEqual(seen, ['observer:1', 'observer:2', 'late:2']);
});

test('onclose：分派中途 off() 其他 close handler 不會漏呼叫，也不會重複呼叫', async (t) => {
  const { cdp, ws } = await connectedCdp(t, 'w6-s01');
  const calls = [];
  let offSecond = () => false;
  const first = () => { calls.push('first'); offSecond(); };
  const second = () => { calls.push('second'); };
  const third = () => { calls.push('third'); };

  cdp.onClose(first);
  offSecond = cdp.onClose(second);
  cdp.onClose(third);

  assert.doesNotThrow(() => ws.simulatePeerClose());
  assert.deepEqual(calls, ['first', 'second', 'third'], '本輪開始時已註冊的 close handler 都必須被呼叫恰好一次');
  assert.equal(cdp.closeHandlers.has(second), false, '被 off() 的 close handler 應自集合移除');
  assert.equal(cdp.closeHandlers.size, 2);
});

test('onclose：分派中途註冊的 close handler 不會在同一輪被走訪到，且只補呼叫一次', async (t) => {
  const { cdp, ws } = await connectedCdp(t, 'w6-s01');
  const calls = [];
  let lateCalls = 0;

  cdp.onClose(() => {
    calls.push('first');
    cdp.onClose(() => { lateCalls += 1; });
  });
  cdp.onClose(() => calls.push('second'));

  ws.simulatePeerClose();
  assert.deepEqual(calls, ['first', 'second'], '同一輪不得走訪中途註冊的 close handler');
  assert.equal(lateCalls, 0, '中途註冊的 close handler 不應被同一輪同步呼叫');
  assert.equal(cdp.closeHandlers.size, 2, '關閉後註冊走補呼叫路徑，不會被塞回 closeHandlers');

  await flushMicrotasks();
  assert.equal(lateCalls, 1, '連線已關閉，補呼叫應恰好發生一次（不能重複）');

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(lateCalls, 1, '補呼叫只發生一次');
});
