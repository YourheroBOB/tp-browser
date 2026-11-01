// 回歸測試：once() 在 CDP 連線關閉時立即拒絕並清理訂閱與計時器。
// 全程使用假的 WebSocket，不建立網路連線。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Cdp, once } from '../daemon/cdp.js';

const FAKE_WS_URL = 'ws://127.0.0.1:1/devtools/browser/FAKE_VALUE_FOR_TEST';
const WATCHDOG = Symbol('watchdog');

class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    FakeWebSocket.instances.push(this);
  }

  send() {}

  close() {
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
  t.after(() => {
    globalThis.WebSocket = original;
  });

  const cdp = new Cdp(FAKE_WS_URL, 'w2-s02');
  const opening = cdp.connect(1000);
  const ws = FakeWebSocket.instances.at(-1);
  ws.simulateOpen();
  await opening;
  return { cdp, ws };
}

const activeTimeouts = () =>
  process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;

async function raceWithWatchdog(promise, timeoutMs = 100) {
  let watchdog;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        watchdog = setTimeout(() => resolve(WATCHDOG), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(watchdog);
  }
}

test('once：WebSocket 關閉後 100ms 內拒絕並清除事件、關閉訂閱及計時器', async (t) => {
  const { cdp, ws } = await connectedCdp(t);
  const baseline = activeTimeouts();
  const settled = once(cdp, 'Page.loadEventFired', { timeout: 30_000 }).then(
    () => ({ type: 'resolved' }),
    (error) => ({ type: 'rejected', message: error.message }),
  );

  assert.equal(cdp.handlers.size, 1);
  assert.equal(cdp.closeHandlers.size, 1);
  ws.simulatePeerClose();

  const timeoutsAfterClose = activeTimeouts();
  const startedAt = Date.now();
  const result = await raceWithWatchdog(settled);
  const elapsedMs = Date.now() - startedAt;

  // 若回歸導致仍在等待事件，送出假事件以免留下 30 秒計時器。
  if (result === WATCHDOG) {
    cdp._recv(JSON.stringify({ method: 'Page.loadEventFired', params: {} }));
    await settled;
  }

  assert.notEqual(result, WATCHDOG, '關閉後應在 100ms 內完成');
  assert.equal(result.type, 'rejected');
  assert.match(result.message, /^CDP connection closed/);
  assert.ok(elapsedMs < 100, `應在 100ms 內拒絕（實際 ${elapsedMs}ms）`);
  assert.equal(timeoutsAfterClose, baseline, '關閉後應清除 once 計時器');
  assert.equal(cdp.handlers.size, 0, '關閉後不應殘留事件 handler');
  assert.equal(cdp.closeHandlers.size, 0, '關閉後不應殘留 onClose handler');
});

test('once：呼叫時連線已關閉，立即拒絕且不建立任何訂閱或計時器', async (t) => {
  const { cdp, ws } = await connectedCdp(t);
  ws.simulatePeerClose();

  const baseline = activeTimeouts();
  const settled = once(cdp, 'Page.loadEventFired', { timeout: 30_000 }).then(
    () => ({ type: 'resolved' }),
    (error) => ({ type: 'rejected', message: error.message }),
  );
  const timeoutsAfterCall = activeTimeouts();
  const handlersAfterCall = cdp.handlers.size;
  // cdp.closeHandlers 只有在 onClose() 曾被呼叫過才會建立（Cdp 以 ??= 延遲初始化），
  // 因此這裡不能用 cdp.closeHandlers.size，否則會在「完全沒人註冊 onClose」時爆 TypeError。
  const closeHandlersAfterCall = cdp.closeHandlers?.size ?? 0;

  const startedAt = Date.now();
  const result = await raceWithWatchdog(settled);
  const elapsedMs = Date.now() - startedAt;

  // 舊行為會等到事件或逾時；假事件讓失敗案例也能及時清理計時器。
  if (result === WATCHDOG) {
    cdp._recv(JSON.stringify({ method: 'Page.loadEventFired', params: {} }));
    await settled;
  }

  assert.notEqual(result, WATCHDOG, '已關閉的連線應立即拒絕');
  assert.equal(result.type, 'rejected');
  assert.match(result.message, /^CDP connection closed/);
  assert.ok(elapsedMs < 100, `應立即拒絕（實際 ${elapsedMs}ms）`);
  assert.equal(timeoutsAfterCall, baseline, '已關閉時不應建立計時器');
  assert.equal(handlersAfterCall, 0, '已關閉時不應註冊事件 handler');
  assert.equal(closeHandlersAfterCall, 0, '已關閉時不應註冊 onClose handler');
});

test('once：正常 resolve 或逾時後都會解除 onClose 訂閱', async (t) => {
  const { cdp } = await connectedCdp(t);

  const waiting = once(cdp, 'Page.loadEventFired', { timeout: 1000 });
  assert.equal(cdp.closeHandlers.size, 1);
  cdp._recv(JSON.stringify({ method: 'Page.loadEventFired', params: { timestamp: 1 } }));
  assert.deepEqual(await waiting, { timestamp: 1 });
  assert.equal(cdp.handlers.size, 0);
  assert.equal(cdp.closeHandlers.size, 0);

  await assert.rejects(
    once(cdp, 'Never.happens', { timeout: 10 }),
    /Never\.happens event timed out after 10ms/,
  );
  assert.equal(cdp.handlers.size, 0);
  assert.equal(cdp.closeHandlers.size, 0);
});
