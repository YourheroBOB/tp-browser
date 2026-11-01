// tests/fmb_w3_s02_cdp_close_handlers.test.mjs
// 回歸測試：daemon/cdp.js 的 close handler 派送與「關閉後才註冊」的生命週期。
//
// 修掉的兩個缺陷：
//   1. ws.onclose 以裸 for 迴圈呼叫 closeHandlers，任一 handler 丟錯就讓後面的
//      handler（例如 daemon 的重新附錨邏輯）完全不執行，錯誤還會從事件回呼往外冒。
//   2. 連線已 closed 之後才呼叫 onClose(fn)，fn 永遠不會被呼叫，呼叫端因此不知道
//      連線已死。
//
// 全部以假的 globalThis.WebSocket 驅動：不建立任何網路連線、不接觸正式服務、
// 不需要憑證（URL／sessionId 一律是 FAKE_VALUE_FOR_TEST 這類明顯假值）。
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

async function connectedCdp(t) {
  const original = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => {
    globalThis.WebSocket = original;
  });

  const cdp = new Cdp(FAKE_WS_URL, 'w3-s02');
  const opening = cdp.connect(1000);
  const ws = FakeWebSocket.instances.at(-1);
  ws.simulateOpen();
  await opening;
  return { cdp, ws };
}

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test('close：前一個 handler 丟錯後，後面的 handler 照常執行且錯誤不會往外冒', async (t) => {
  const { cdp, ws } = await connectedCdp(t);

  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args.map((a) => String(a)).join(' '));
  try {
    const calls = [];
    cdp.onClose(() => {
      calls.push('first');
      throw new Error('close handler boom FAKE_VALUE_FOR_TEST');
    });
    cdp.onClose(() => { calls.push('second'); });
    cdp.onClose(() => {
      calls.push('third');
      throw new Error('close handler boom again FAKE_VALUE_FOR_TEST');
    });
    cdp.onClose(() => { calls.push('fourth'); });

    assert.doesNotThrow(() => ws.simulatePeerClose(), 'close handler 的錯誤不應從事件回呼冒出');

    assert.deepEqual(calls, ['first', 'second', 'third', 'fourth'], '所有 handler 都必須被執行');
    assert.equal(cdp.closed, true);
    assert.equal(logged.length, 2, `每個丟錯的 close handler 都應各記錄一次：${logged.join(' | ') || '(無)'}`);
    for (const line of logged) {
      assert.match(line, /close handler error/);
      assert.match(line, /close handler boom/);
    }
  } finally {
    console.error = originalError;
  }
});

test('close：連線關閉後才註冊的 onClose 會在下一個 microtask 被呼叫恰好一次', async (t) => {
  const { cdp, ws } = await connectedCdp(t);

  ws.simulatePeerClose();
  assert.equal(cdp.closed, true);

  let calls = 0;
  const off = cdp.onClose(() => { calls += 1; });
  assert.equal(typeof off, 'function', '關閉後註冊仍須回傳可取消的 off 函式');
  assert.equal(calls, 0, '不應同步呼叫，而是排到下一個 microtask');

  await flushMicrotasks();
  assert.equal(calls, 1, 'microtask 後應恰好被呼叫一次');

  // 再等一下，確認不會被重複呼叫（例如誤用 timer 或重複排程）。
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 1, '補呼叫只發生一次');

  // 已經觸發過的 off() 回傳 false（沒有東西可取消），且不會再改變任何狀態。
  assert.equal(off(), false);
  assert.equal(calls, 1);
});

test('close：註冊後立即 off 的 handler 不會被呼叫（連線中與關閉後皆然）', async (t) => {
  const { cdp, ws } = await connectedCdp(t);

  // (a) 連線中註冊、關閉前取消
  const live = [];
  cdp.onClose(() => live.push('kept'));
  const offDropped = cdp.onClose(() => live.push('dropped'));
  assert.equal(offDropped(), true, '取消成功應回傳 true');
  assert.equal(cdp.closeHandlers.size, 1, '被取消的 handler 應自集合移除');

  ws.simulatePeerClose();
  assert.deepEqual(live, ['kept'], '已取消的 handler 不應被呼叫');

  // (b) 關閉後才註冊、但在 microtask 之前取消
  const late = [];
  const offLate = cdp.onClose(() => late.push('late'));
  assert.equal(offLate(), true, '補呼叫前取消應回傳 true');
  assert.equal(offLate(), false, '重複取消應回傳 false');

  await flushMicrotasks();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(late, [], '關閉後註冊但立即取消的 handler 不應被呼叫');
});
