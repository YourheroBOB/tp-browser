// tests/fmb_w1_s03_cdp_timers.test.mjs
// 回歸測試：daemon/cdp.js 的 pending 計時器生命週期。
//
// 修掉的兩個缺陷：
//   1. ws.onclose 只 reject pending、沒有 clearTimeout，導致每個未完成的 send 把事件迴圈
//      多撐住最多 30 秒（CLI 與測試因此卡住）。
//   2. send() 若遇到 ws.send 同步丟錯（socket 正進入 closing），pending 項目與計時器
//      會一直留著直到逾時，promise 也不會立即失敗。
//
// 全部以假的 globalThis.WebSocket 驅動，不建立任何網路連線、不接觸任何正式服務、
// 不需要憑證（URL／sessionId 一律是 FAKE_VALUE_FOR_TEST 這類明顯假值）。
//
// 計時器洩漏的量測方式：在「同一段同步程式碼」內比較
// process.getActiveResourcesInfo() 的 Timeout 數量。量測窗口內沒有其他程式碼執行，
// 因此不會有無關的計時器被建立或消滅，結果是決定性的。
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
    this.onopen = null;
    this.onerror = null;
    this.onclose = null;
    this.onmessage = null;
    this.sendError = null; // 設值後，下一次 send() 會同步丟出這個錯誤
    FakeWebSocket.instances.push(this);
  }

  send(data) {
    if (this.sendError) throw this.sendError;
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

  const cdp = new Cdp(FAKE_WS_URL, 'w1-s03');
  const opening = cdp.connect(1000);
  const ws = FakeWebSocket.instances.at(-1);
  ws.simulateOpen();
  await opening;
  return { cdp, ws };
}

test('onclose：送出 send 後斷線，pending 計時器歸零且 promise 以 CDP connection closed 拒絕', async (t) => {
  const { cdp, ws } = await connectedCdp(t);

  const baseline = timeouts();
  const settled = [];
  for (let i = 0; i < 3; i += 1) {
    settled.push(
      cdp.send('Page.enable', {}, { timeout: 30_000 }).then(
        () => 'resolved',
        (err) => err.message,
      ),
    );
  }

  assert.equal(cdp.pending.size, 3);
  // 每個未完成的 send 都應持有一個計時器（量測窗口內全為同步程式碼）。
  assert.equal(timeouts(), baseline + 3, '每個 pending 請求都應對應一個計時器');

  ws.simulatePeerClose(); // 觸發 onclose

  assert.equal(timeouts(), baseline, 'onclose 後不應留下任何 pending 計時器');
  assert.equal(cdp.pending.size, 0);
  assert.deepEqual(await Promise.all(settled), [
    'CDP connection closed',
    'CDP connection closed',
    'CDP connection closed',
  ]);
});

test('onclose：單一 send 的重現案例（送出後立即斷線）不會殘留 Timeout', async (t) => {
  const { cdp, ws } = await connectedCdp(t);

  const before = timeouts();
  const settled = cdp.send('X', {}, { timeout: 30_000 }).then(
    () => 'resolved',
    (err) => err.message,
  );

  ws.simulatePeerClose();

  assert.equal(timeouts(), before, '斷線後 Timeout 數量應回到基準值');
  assert.equal(await settled, 'CDP connection closed');
  assert.equal(cdp.pending.size, 0);
  assert.equal(cdp.closed, true);

  // 已關閉後送出一律立即拒絕，且不排入 pending、不建立計時器。
  await assert.rejects(cdp.send('Page.enable'), /CDP connection closed/);
  assert.equal(timeouts(), before);
});

test('send：ws.send 同步丟錯時清掉 pending 與計時器並立即 reject', async (t) => {
  const { cdp, ws } = await connectedCdp(t);

  const baseline = timeouts();
  const boom = new Error('FAKE_VALUE_FOR_TEST: socket is closing');
  ws.sendError = boom;

  const started = Date.now();
  await assert.rejects(
    cdp.send('Page.navigate', { url: 'about:blank' }, { timeout: 300 }),
    (err) => err === boom,
  );
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 150, `應立即拒絕而非等逾時（實際 ${elapsed}ms）`);
  assert.equal(cdp.pending.size, 0, '失敗的請求不應留在 pending');
  assert.equal(timeouts(), baseline, '失敗的請求不應留下計時器');

  // 同一條連線仍可正常送出，id 不會因失敗而錯亂。
  ws.sendError = null;
  const ok = cdp.send('Page.enable', {}, { timeout: 5000 });
  const frame = JSON.parse(ws.sentFrames.at(-1));
  assert.equal(frame.method, 'Page.enable');
  cdp._recv(JSON.stringify({ id: frame.id, result: {} }));
  assert.deepEqual(await ok, {});
  assert.equal(cdp.pending.size, 0);
  assert.equal(timeouts(), baseline);
});
