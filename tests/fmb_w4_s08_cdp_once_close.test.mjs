// tests/fmb_w4_s08_cdp_once_close.test.mjs
// 回歸測試：daemon/cdp.js 的 once() 生命週期，以及 connect() 的「恰好 settle 一次」契約。
//
// 修掉的兩個缺陷：
//   1. once() 完全不理會連線關閉：等待中的事件永遠不會到，呼叫端卻要一路等到 timeout
//      （預設 30 秒），期間計時器與事件 handler 全部留著（daemon／CLI 因此卡住）。
//   2. connect() 的逾時回呼「先 ws.close() 才 reject」：關閉正在握手的 socket 會先觸發
//      onerror，對外訊息因此變成誤導性的「CDP connect failed」（真正原因是逾時）；
//      而且逾時之後才完成的握手會把半死的 socket 掛回 this.ws，讓已失敗的 client
//      看起來可用。
//
// 全部以假的 globalThis.WebSocket 驅動：零網路、不接觸任何正式服務、零憑證
// （URL／sessionId 一律使用 FAKE_VALUE_FOR_TEST 這類明顯假值）。
//
// 計時器洩漏的量測方式與 tests/fmb_w1_s03_cdp_timers.test.mjs 相同：只在同一段
// 同步程式碼的窗口內比較 process.getActiveResourcesInfo() 的 Timeout 數量，結果決定性。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Cdp, once } from '../daemon/cdp.js';

const FAKE_WS_URL = 'ws://127.0.0.1:1/devtools/browser/FAKE_VALUE_FOR_TEST';
const FAKE_SESSION = 'S-FAKE_VALUE_FOR_TEST';

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
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.onmessage?.({ data });
  }
}

async function connectedCdp(t) {
  const original = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => { globalThis.WebSocket = original; });

  const cdp = new Cdp(FAKE_WS_URL, 'w4-s08');
  const opening = cdp.connect(1000);
  const ws = FakeWebSocket.instances.at(-1);
  ws.simulateOpen();
  await opening;
  return { cdp, ws };
}

test('once：等待期間連線關閉時立即拒絕，並清掉 handler 與 30 秒計時器', async (t) => {
  const { cdp, ws } = await connectedCdp(t);

  const baseline = timeouts();
  const waiting = once(cdp, 'Page.loadEventFired', { timeout: 30_000 });
  const withTimer = timeouts();

  assert.equal(cdp.handlers.size, 1);
  assert.equal(withTimer, baseline + 1, '等待事件時應恰好持有一個計時器');

  ws.simulatePeerClose(); // 對端斷線：事件永遠不會再來

  assert.equal(timeouts(), baseline, '斷線後應同步清掉計時器');
  await assert.rejects(
    waiting,
    /CDP connection closed while waiting for Page\.loadEventFired/,
  );
  assert.equal(cdp.handlers.size, 0, '事件 handler 應被解除訂閱');
  assert.equal(cdp.closeHandlers.size, 0, 'close handler 也應被解除訂閱');
});

test('once：對已關閉的連線註冊時，下一個 microtask 就拒絕，不必等逾時', async (t) => {
  const { cdp, ws } = await connectedCdp(t);

  ws.simulatePeerClose();
  assert.equal(cdp.closed, true);

  const started = Date.now();
  await assert.rejects(
    once(cdp, 'Page.frameNavigated', { timeout: 10_000 }),
    /CDP connection closed while waiting for Page\.frameNavigated/,
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, `應立即拒絕而非等逾時（實際 ${elapsed}ms）`);
  assert.equal(cdp.handlers.size, 0);
});

test('once：sessionId 過濾與成功路徑不受影響，成功後不留下 close 訂閱', async (t) => {
  const { cdp, ws } = await connectedCdp(t);

  const waiting = once(cdp, 'Page.loadEventFired', { sessionId: FAKE_SESSION, timeout: 5000 });
  assert.equal(cdp.handlers.size, 1);
  assert.equal(cdp.closeHandlers.size, 1, '等待期間應有 close 訂閱以偵測斷線');

  ws.simulateMessage({ sessionId: 'S-other', method: 'Page.loadEventFired', params: { n: 1 } });
  ws.simulateMessage({ sessionId: FAKE_SESSION, method: 'Page.loadEventFired', params: { n: 2 } });

  assert.deepEqual(await waiting, { n: 2 });
  assert.equal(cdp.handlers.size, 0);
  assert.equal(cdp.closeHandlers.size, 0);

  // 已 settle 的 promise 不會因為之後才斷線而被再次拒絕（沒有未處理的 rejection）。
  assert.doesNotThrow(() => ws.simulatePeerClose());
});

test('once：只提供 onEvent 的極簡 emitter 仍可運作（不需 onClose）', async () => {
  let emit = null;
  const fake = {
    onEvent(fn) { emit = fn; return () => { emit = null; }; },
  };
  const p = once(fake, 'Page.domContentEventFired', { timeout: 2000 });
  emit({ sessionId: null, method: 'Page.domContentEventFired', params: { ts: 1 } });
  assert.deepEqual(await p, { ts: 1 });
  assert.equal(emit, null, '解析後應自動解除訂閱');
});

test('connect：逾時自行關閉 socket 所誘發的 error 不得覆蓋 timeout 訊息', async (t) => {
  const original = globalThis.WebSocket;
  class AbortEchoesErrorWs {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.onopen = null;
      this.onerror = null;
      this.onclose = null;
      this.onmessage = null;
    }
    send() {}
    // 模擬「中止握手 → 先丟 onerror」的實作（Node 內建 WebSocket 中止握手時的行為）。
    close() {
      this.readyState = 3;
      this.onerror?.(new Error('handshake aborted FAKE_VALUE_FOR_TEST'));
    }
  }
  globalThis.WebSocket = AbortEchoesErrorWs;
  t.after(() => { globalThis.WebSocket = original; });

  const cdp = new Cdp(FAKE_WS_URL, 'w4-s08');
  await assert.rejects(
    cdp.connect(30),
    (err) => err instanceof Error && err.message === `CDP connect timeout: ${FAKE_WS_URL}`,
  );
  assert.equal(cdp.ws, null, '失敗後不應留下任何 socket');
});

test('connect：逾時後才完成的握手不會把 socket 掛回 this.ws', async (t) => {
  const original = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => { globalThis.WebSocket = original; });

  const cdp = new Cdp(FAKE_WS_URL, 'w4-s08');
  await assert.rejects(cdp.connect(20), /CDP connect timeout/);

  const ws = FakeWebSocket.instances.at(-1);
  assert.equal(ws.closeCalls, 1, '逾時時應嘗試關閉底層 socket');

  ws.simulateOpen(); // 晚到的 open

  assert.equal(cdp.ws, null, 'connect 已以逾時失敗，晚到的 open 不得讓 client 看似可用');
  assert.equal(ws.closeCalls, 2, '晚到的 socket 應被關閉，避免洩漏一條無人持有的連線');
  await assert.rejects(cdp.send('Page.enable'), /CDP connection closed/);
});
