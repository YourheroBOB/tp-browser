// tests/fmb_w12_s08_cdp_close_pending_teardown.test.mjs
// 回歸測試：daemon/cdp.js 的 close() 必須自己收尾「等待中」的請求。
//
// 修掉的缺陷：舊版 close() 只把 closed 設成 true、關掉 socket，完全沒有處理
// this.pending，把收尾寄望在對端派送的 close frame 上。真實 WebSocket 對「不回應的
// 對端」要等關閉握手逾時才會派送 onclose（TCP 半開、browser 程序已死、握手卡住都是
// 常見情境），因此：
//   1. close() 之後 CLI／daemon 等待中的 RPC 仍會懸置，最長等到自己的 timeout；
//   2. 每個未完成的 send 都留著計時器，把事件迴圈多撐住最多 timeout 毫秒；
//   3. timeout 設為 Infinity（cdp.js 明確支援「不逾時」）的請求沒有任何計時器，
//      一旦對端不派送 close 就永遠不會 settle。
// 修正後 close() 會同步以 "CDP connection closed" 拒絕所有 pending 並清掉計時器；
// 對端稍後才派送的 close 事件與遲到的回應都不再改變任何狀態。
//
// 全部以假的 globalThis.WebSocket 驅動：零網路、不接觸任何正式服務、零憑證
// （URL 一律使用 FAKE_VALUE_FOR_TEST 這類明顯假值）。
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

  // 刻意不派送 onclose：模擬真實 WebSocket 面對「不回應的對端」時，關閉握手要等到
  // 實作層逾時才會派送 close 事件的狀態，讓測試能分辨「程式自己收尾」與「等 socket 事件」。
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
}

function useFakeWebSocket(t) {
  const original = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => { globalThis.WebSocket = original; });
}

async function connectedCdp(t) {
  useFakeWebSocket(t);
  const cdp = new Cdp(FAKE_WS_URL, 'w12-s08');
  const opening = cdp.connect(1000);
  const ws = FakeWebSocket.instances.at(-1);
  ws.simulateOpen();
  await opening;
  return { cdp, ws };
}

test('close()：不等對端 close frame，立即拒絕所有 pending 並清掉計時器', async (t) => {
  const { cdp, ws } = await connectedCdp(t);

  const baseline = timeouts();
  const settled = [
    cdp.send('Page.enable', {}, { timeout: 400 }).then(() => 'resolved', (err) => err.message),
    cdp.send('Page.navigate', { url: 'about:blank' }, { timeout: 400 }).then(
      () => 'resolved',
      (err) => err.message,
    ),
  ];

  assert.equal(cdp.pending.size, 2, '送出後應有兩個等待中的請求');
  assert.equal(timeouts(), baseline + 2, '每個 pending 請求都應對應一個計時器');

  cdp.close();

  assert.equal(cdp.pending.size, 0, 'close() 後不應留下 pending 項目');
  assert.equal(timeouts(), baseline, 'close() 後不應留下 pending 計時器');
  assert.equal(ws.closeCalls, 1, 'close() 仍應關閉底層 socket');
  assert.deepEqual(
    await Promise.all(settled),
    ['CDP connection closed', 'CDP connection closed'],
    '等待中的請求應以 CDP connection closed 立即失敗，而不是等自己的 timeout',
  );
});

test('close()：timeout 為 Infinity 的請求在 close() 後立刻拒絕，不會永遠懸置', async (t) => {
  const { cdp } = await connectedCdp(t);

  const baseline = timeouts();
  const settled = cdp.send('Page.enable', {}, { timeout: Infinity }).then(
    () => 'resolved',
    (err) => err.message,
  );

  assert.equal(cdp.pending.size, 1);
  assert.equal(timeouts(), baseline, 'Infinity 不應建立計時器');

  cdp.close();

  assert.equal(cdp.pending.size, 0, 'close() 後不應留下 pending 項目');
  // 以 race 包住：修正前的版本這個 promise 永遠不 settle，測試必須「失敗」而非卡死。
  const outcome = await Promise.race([
    settled,
    new Promise((resolve) => { setTimeout(() => resolve('still-pending'), 200); }),
  ]);
  assert.equal(outcome, 'CDP connection closed', '沒有計時器的請求只能靠 close() 定案');
});

test('close()：收尾後對端才派送 close 事件與遲到回應，都不會改變狀態', async (t) => {
  const { cdp, ws } = await connectedCdp(t);

  let rejections = 0;
  const settled = cdp.send('Page.enable', {}, { timeout: 400 }).then(
    () => 'resolved',
    (err) => { rejections += 1; return err.message; },
  );

  cdp.close();
  assert.equal(await settled, 'CDP connection closed');
  assert.equal(rejections, 1, '同一個請求只應被拒絕一次');

  // 真實 WebSocket 之後仍會派送 close；對端也可能送出遲到的回應。
  ws.simulatePeerClose();
  ws.simulateMessage({ id: 1, result: { ok: true } });

  assert.equal(rejections, 1, '重複派送不得讓 pending 再被拒絕一次');
  assert.equal(cdp.pending.size, 0);
  assert.equal(cdp.closed, true);
  assert.doesNotThrow(() => cdp.close(), 'close() 必須可重複呼叫');
  assert.equal(cdp.pending.size, 0);
  await assert.rejects(cdp.send('Page.enable'), /CDP connection closed/);
});

test('timeout 正規化：負值視為 0（立即逾時）；NaN 退回預設值且仍會清計時器', async (t) => {
  const { cdp, ws } = await connectedCdp(t);

  const baseline = timeouts();
  await assert.rejects(
    cdp.send('Page.enable', {}, { timeout: -5 }),
    /Page\.enable timed out after 0ms/,
  );
  assert.equal(cdp.pending.size, 0);
  assert.equal(timeouts(), baseline);

  const pending = cdp.send('Page.bringToFront', {}, { timeout: Number.NaN });
  assert.equal(cdp.pending.size, 1, 'NaN 應退回預設值而不是立刻逾時');
  assert.equal(timeouts(), baseline + 1, '退回預設值代表仍會建立計時器');

  const frame = JSON.parse(ws.sentFrames.at(-1));
  ws.simulateMessage({ id: frame.id, result: {} });
  assert.deepEqual(await pending, {});
  assert.equal(cdp.pending.size, 0);
  assert.equal(timeouts(), baseline);

  cdp.close();
});
