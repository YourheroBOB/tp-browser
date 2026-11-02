// close() 必須自己通知 onClose 並結束 once()。
// 對端不回應關閉握手時，WebSocket 不會立刻派送 onclose；舊版只在 onclose 裡
// 呼叫 close handler，因此 once() 會一直 pending（Infinity 則永遠不 settle），
// 事件訂閱與計時器也留著。
// 假 WebSocket 的 close() 故意不派送 onclose。不連網、不使用真實憑證。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Cdp, once } from '../daemon/cdp.js';

const FAKE_WS_URL = 'ws://127.0.0.1:1/devtools/browser/FAKE_VALUE_FOR_TEST';

const timeouts = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.closeCalls = 0;
    this.onopen = null;
    this.onerror = null;
    this.onclose = null;
    this.onmessage = null;
    FakeWebSocket.instances.push(this);
  }

  send() {
    if (this.readyState !== 1) throw new Error('fake ws: not open');
  }

  // 模擬「本地已 close、對端不回 close frame」：不派送 onclose。
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
}

async function connectedCdp(t) {
  const original = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => { globalThis.WebSocket = original; });

  const cdp = new Cdp(FAKE_WS_URL, 'bug-close-once');
  const opening = cdp.connect(1000);
  const ws = FakeWebSocket.instances.at(-1);
  ws.simulateOpen();
  await opening;
  return { cdp, ws };
}

test('close()：沒有 peer close frame 時仍立刻通知 onClose 並拒絕 Infinity 的 once()', async (t) => {
  const { cdp, ws } = await connectedCdp(t);

  let notified = 0;
  cdp.onClose(() => { notified += 1; });

  const settled = once(cdp, 'Page.loadEventFired', { timeout: Infinity }).then(
    () => 'resolved',
    (err) => err.message,
  );
  assert.equal(cdp.handlers.size, 1);

  cdp.close();

  assert.equal(ws.closeCalls, 1);
  assert.equal(notified, 1, 'close() 應立刻通知 onClose，而不是等 peer close frame');
  assert.equal(cdp.handlers.size, 0, 'once() 應在 close() 時解除事件訂閱');
  assert.equal(cdp.closed, true);

  let timer;
  const outcome = await Promise.race([
    settled,
    new Promise((resolve) => { timer = setTimeout(() => resolve('still-pending'), 200); }),
  ]);
  clearTimeout(timer);
  assert.equal(outcome, 'CDP connection closed while waiting for Page.loadEventFired');

  ws.simulatePeerClose();
  assert.equal(notified, 1, '遲到的 close frame 不得再通知一次');
  assert.equal(cdp.handlers.size, 0);
});

test('close()：once() 的有限計時器在沒有 peer close frame 時也被清掉', async (t) => {
  const { cdp } = await connectedCdp(t);

  const baseline = timeouts();
  const settled = once(cdp, 'Page.frameNavigated', { timeout: 400 }).then(
    () => 'resolved',
    (err) => err.message,
  );
  assert.equal(timeouts(), baseline + 1, '等待事件時應持有一個計時器');

  cdp.close();

  assert.equal(timeouts(), baseline, 'close() 應清掉 once() 的計時器');
  assert.equal(await settled, 'CDP connection closed while waiting for Page.frameNavigated');
  assert.equal(cdp.handlers.size, 0);
  assert.equal(cdp.closeHandlers.size, 0);
});
