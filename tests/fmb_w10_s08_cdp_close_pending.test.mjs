// tests/fmb_w10_s08_cdp_close_pending.test.mjs
// 回歸測試：daemon/cdp.js 的 close() 必須同步收拾 in-flight 請求。
//
// 修掉的缺陷：舊版 close() 只設 closed 旗標並呼叫 ws.close()，把 pending 的收拾
// 完全交給 ws.onclose。但本地 close() 之後對端不一定會（立刻）回 close frame：
// socket 已半死、關閉握手卡住、或實作要等到內部關閉逾時才 fire onclose。這段空窗期
// 內每個未完成的 send() 都要一路等到自己的 timeout（預設 30 秒）才失敗——
// 呼叫端卡住、計時器把事件迴圈多撐住、pending 也繼續留在 Map 裡。
//
// 全部以假的 globalThis.WebSocket 驅動：零網路、不接觸任何正式服務、零憑證
// （URL／sessionId 一律使用 FAKE_VALUE_FOR_TEST 這類明顯假值）。
//
// 計時器洩漏的量測方式與 tests/fmb_w1_s03_cdp_timers.test.mjs 相同：只在同一段
// 同步程式碼的窗口內比較 process.getActiveResourcesInfo() 的 Timeout 數量，結果決定性。
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

  close() {
    // 刻意不呼叫 onclose：模擬「本地 close() 後對端尚未回 close frame」的狀態，
    // 用來分辨「close() 自己收拾」與「等 socket 事件」兩條路徑。
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
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

async function connectedCdp(t) {
  const original = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => { globalThis.WebSocket = original; });

  const cdp = new Cdp(FAKE_WS_URL, 'w10-s08');
  const opening = cdp.connect(1000);
  const ws = FakeWebSocket.instances.at(-1);
  ws.simulateOpen();
  await opening;
  return { cdp, ws };
}

test('close()：in-flight 請求立即以 CDP connection closed 拒絕，並清掉 pending 與計時器', async (t) => {
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
  assert.equal(timeouts(), baseline + 3, '每個 pending 請求都應對應一個計時器');

  cdp.close();

  assert.equal(cdp.closed, true);
  assert.ok(ws.closeCalls >= 1, 'close() 應關閉底層 socket');
  assert.equal(cdp.pending.size, 0, 'close() 後 pending 必須清空（不可只等 onclose）');
  assert.equal(timeouts(), baseline, 'close() 應同步清掉 pending 計時器，不可留到逾時');
  assert.deepEqual(await Promise.all(settled), [
    'CDP connection closed',
    'CDP connection closed',
    'CDP connection closed',
  ]);

  // 遲到的回應（對端在本機 close() 之後才送出）必須被安全忽略，不可拋錯或復活請求。
  const staleId = JSON.parse(ws.sentFrames.at(-1)).id;
  assert.doesNotThrow(() => ws.simulateMessage({ id: staleId, result: { ok: true } }));
  assert.equal(cdp.pending.size, 0);
});

test('close()：重複呼叫安全，其後才到的 onclose 不會重複拒絕或重複通知', async (t) => {
  const { cdp, ws } = await connectedCdp(t);

  let closeHandlerCalls = 0;
  cdp.onClose(() => { closeHandlerCalls += 1; });

  const settled = cdp.send('Page.enable', {}, { timeout: 30_000 }).then(
    () => 'resolved',
    (err) => err.message,
  );

  cdp.close();
  assert.doesNotThrow(() => cdp.close(), 'close() 應可被重複呼叫');
  assert.equal(await settled, 'CDP connection closed');
  assert.equal(cdp.pending.size, 0);
  assert.equal(closeHandlerCalls, 0, 'close handler 仍由 onclose 通知，不在 close() 內提前派送');

  assert.doesNotThrow(() => ws.simulatePeerClose());
  assert.equal(closeHandlerCalls, 1, 'onclose 只會通知一輪，且 pending 已空不會再拒絕');
  assert.equal(cdp.pending.size, 0);
});

test('close()：timeout 為 Infinity 的 in-flight 請求（沒有計時器）同樣立即拒絕', async (t) => {
  const { cdp, ws } = await connectedCdp(t);

  const baseline = timeouts();
  const settled = cdp.send('Page.enable', {}, { timeout: Infinity }).then(
    () => 'resolved',
    (err) => err.message,
  );
  assert.equal(timeouts(), baseline, 'Infinity 不應建立計時器');
  assert.equal(cdp.pending.size, 1);

  cdp.close();

  assert.equal(await settled, 'CDP connection closed');
  assert.equal(cdp.pending.size, 0);
  assert.equal(timeouts(), baseline);

  // 連線已關閉：後續送出一律立即拒絕，且不排入 pending、不建立計時器。
  await assert.rejects(cdp.send('Page.navigate'), /CDP connection closed/);
  assert.equal(cdp.pending.size, 0);
  assert.equal(timeouts(), baseline);
  assert.ok(ws.closeCalls >= 1);
});
