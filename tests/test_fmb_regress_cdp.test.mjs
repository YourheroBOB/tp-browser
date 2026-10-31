// tests/test_fmb_regress_cdp.test.mjs
// 回歸測試：daemon/cdp.js 的錯誤處理與逾時路徑（不需要真的連 CDP，也不連任何網路服務）。
//
// 對應的防禦性痕跡（cdp.js 內）：
//   - send() 在 closed／readyState !== 1 時直接 reject（曾經會把請求掛在 pending 裡永遠不回來）。
//   - _recv() 以 try/catch 吞掉壞 JSON，且 `if (!p) return;` 忽略未知 id
//     → 曾經在請求逾時後「遲到的回應」讓 client 直接爆掉。
//   - 回應成功時 clearTimeout，pending.delete → 曾經計時器沒清，事後冒出未處理 rejection。
//   - 事件分派用 try/catch 包住每個 handler → 曾經一個 handler 拋錯就讓整個事件流中斷。
//   - once() 只認指定 method／sessionId，resolve 後自行解除訂閱。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Cdp, CdpError, once } from '../daemon/cdp.js';

const FAKE_WS_URL = 'ws://127.0.0.1:0/regress-cdp-fake';

function fakeWs() {
  const frames = [];
  return {
    readyState: 1,
    frames,
    send(raw) { frames.push(JSON.parse(raw)); },
    close() { this.readyState = 3; },
  };
}

function connectedCdp() {
  const cdp = new Cdp(FAKE_WS_URL);
  cdp.ws = fakeWs();
  return cdp;
}

const reply = (cdp, msg) => cdp._recv(typeof msg === 'string' ? msg : JSON.stringify(msg));

test('cdp：尚未連線或已關閉時送出請求會立即 reject，不得靜默卡住', async () => {
  const notConnected = new Cdp(FAKE_WS_URL);
  await assert.rejects(notConnected.send('Page.enable'), /CDP connection closed/);
  assert.equal(notConnected.pending.size, 0);

  const closed = connectedCdp();
  closed.close();
  await assert.rejects(closed.send('Page.enable'), /CDP connection closed/);
  assert.equal(closed.pending.size, 0);
});

test('cdp：請求框含 id/method/params/sessionId，成功回應會 resolve 並清空 pending', async () => {
  const cdp = connectedCdp();
  const p = cdp.send('Page.navigate', { url: 'about:blank' }, { sessionId: 'S-1' });

  assert.equal(cdp.ws.frames.length, 1);
  assert.deepEqual(cdp.ws.frames[0], {
    id: 1,
    method: 'Page.navigate',
    params: { url: 'about:blank' },
    sessionId: 'S-1',
  });

  reply(cdp, { id: 1, result: { frameId: 'F-1' } });
  assert.deepEqual(await p, { frameId: 'F-1' });
  assert.equal(cdp.pending.size, 0);
});

test('cdp：錯誤回應會轉成 CdpError，保留 cdpError 內容與方法名', async () => {
  const cdp = connectedCdp();
  const p = cdp.send('Page.goto');

  reply(cdp, { id: 1, error: { code: -32601, message: 'method not found' } });

  await assert.rejects(p, (err) => {
    assert.ok(err instanceof CdpError, '應為 CdpError');
    assert.equal(err.name, 'CdpError');
    assert.equal(err.message, 'Page.goto: method not found');
    assert.equal(err.cdpError.code, -32601);
    return true;
  });
  assert.equal(cdp.pending.size, 0);
});

test('cdp：壞 JSON 與未知 id 的回應被忽略，不影響等待中的請求', async () => {
  const cdp = connectedCdp();
  const p = cdp.send('Page.reload', {});
  const id = cdp.ws.frames.at(-1).id;

  assert.doesNotThrow(() => reply(cdp, 'this is not json'));
  assert.doesNotThrow(() => reply(cdp, { id: id + 999, result: { ignored: true } }));
  assert.equal(cdp.pending.size, 1, '未知 id 不得動到既有 pending');

  reply(cdp, { id, result: { ok: true } });
  assert.deepEqual(await p, { ok: true });
});

test('cdp：請求逾時會 reject 並清掉 pending，之後遲到的回應是安全的', async () => {
  const cdp = connectedCdp();
  const p = cdp.send('Slow.method', {}, { timeout: 20 });
  const id = cdp.ws.frames.at(-1).id;

  await assert.rejects(p, /Slow\.method timed out after 20ms/);
  assert.equal(cdp.pending.size, 0);

  assert.doesNotThrow(() => reply(cdp, { id, result: { late: true } }));
  assert.equal(cdp.pending.size, 0);
});

test('cdp：成功回應後計時器已清除，不會事後冒出未處理的 rejection', async () => {
  const cdp = connectedCdp();
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const p = cdp.send('Page.enable', {}, { timeout: 20 });
    reply(cdp, { id: cdp.ws.frames.at(-1).id, result: {} });
    assert.deepEqual(await p, {});
    await new Promise((r) => setTimeout(r, 60));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, []);
});

test('cdp：事件處理器拋錯不會中斷其他處理器，也不會漏記 session', () => {
  const cdp = connectedCdp();
  const seen = [];
  cdp.onEvent(() => { throw new Error('handler boom'); });
  cdp.onEvent((ev) => seen.push(`${ev.method}:${ev.sessionId}`));

  const orig = console.error;
  console.error = () => {};
  try {
    reply(cdp, { method: 'Page.loadEventFired', params: {}, sessionId: 'S-1' });
    reply(cdp, { method: 'Page.frameNavigated', params: {}, sessionId: 'S-1' });
  } finally {
    console.error = orig;
  }

  assert.deepEqual(seen, ['Page.loadEventFired:S-1', 'Page.frameNavigated:S-1']);
  assert.ok(cdp.sessions.has('S-1'));
});

test('cdp：onEvent 回傳的取消函式可停止收到後續事件', () => {
  const cdp = connectedCdp();
  const seen = [];
  const off = cdp.onEvent((ev) => seen.push(ev.method));

  reply(cdp, { method: 'A.one', params: {} });
  off();
  reply(cdp, { method: 'A.two', params: {} });

  assert.deepEqual(seen, ['A.one']);
  assert.equal(cdp.handlers.size, 0);
});

test('cdp：once() 只認指定 method 與 sessionId，resolve 後自行解除訂閱', async () => {
  const cdp = connectedCdp();
  const wait = once(cdp, 'Page.loadEventFired', { sessionId: 'S-1', timeout: 1000 });

  reply(cdp, { method: 'Page.frameNavigated', params: {}, sessionId: 'S-1' });
  reply(cdp, { method: 'Page.loadEventFired', params: { n: 1 }, sessionId: 'S-2' });
  reply(cdp, { method: 'Page.loadEventFired', params: { n: 2 }, sessionId: 'S-1' });

  assert.deepEqual(await wait, { n: 2 });
  assert.equal(cdp.handlers.size, 0, 'resolve 後必須解除訂閱');

  assert.doesNotThrow(() =>
    reply(cdp, { method: 'Page.loadEventFired', params: { n: 3 }, sessionId: 'S-1' }));
});

test('cdp：once() 未指定 sessionId 時接受任一 session；逾時會 reject', async () => {
  const cdp = connectedCdp();

  const wait = once(cdp, 'Inspector.detached', { timeout: 1000 });
  reply(cdp, { method: 'Inspector.detached', params: { reason: 'target_closed' }, sessionId: null });
  assert.deepEqual(await wait, { reason: 'target_closed' });

  await assert.rejects(
    once(cdp, 'Never.Happens', { timeout: 20 }),
    /Never\.Happens event timed out after 20ms/,
  );
  assert.equal(cdp.handlers.size, 0);
});
