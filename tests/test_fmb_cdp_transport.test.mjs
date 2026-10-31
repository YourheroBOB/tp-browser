// tests/test_fmb_cdp_transport.test.mjs
// daemon/cdp.js 的傳輸層測試。以假的 WebSocket 類別取代 globalThis.WebSocket，
// 因此完全不建立真實連線（不連任何服務、不需要 Chrome、不需要憑證）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Cdp, CdpError, once } from '../daemon/cdp.js';

class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.sent = [];
    this.closedByClient = false;
    FakeWebSocket.instances.push(this);
  }
  send(data) { this.sent.push(data); }
  close() { this.closedByClient = true; this.readyState = 3; }
}

function withFakeWebSocket(t) {
  const original = globalThis.WebSocket;
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => { globalThis.WebSocket = original; });
  return FakeWebSocket;
}

async function connectedCdp(t) {
  const Fake = withFakeWebSocket(t);
  const cdp = new Cdp('ws://127.0.0.1:1/devtools/browser/fake-for-test', 'unit');
  const connecting = cdp.connect(1000);
  const ws = Fake.instances.at(-1);
  ws.readyState = 1; // OPEN
  ws.onopen();
  await connecting;
  return { cdp, ws, Fake };
}

test('connect：逾時會關閉 socket 並 reject，不會留下可用的 ws', async (t) => {
  const Fake = withFakeWebSocket(t);
  const cdp = new Cdp('ws://127.0.0.1:1/devtools/browser/fake-for-test');
  const pending = cdp.connect(10);
  const ws = Fake.instances.at(-1);
  await assert.rejects(pending, /CDP connect timeout/);
  assert.equal(ws.closedByClient, true);
  assert.equal(cdp.ws, null);
});

test('connect：socket 錯誤會 reject 並回報連線失敗', async (t) => {
  const Fake = withFakeWebSocket(t);
  const cdp = new Cdp('ws://127.0.0.1:1/devtools/browser/fake-for-test');
  const pending = cdp.connect(1000);
  const ws = Fake.instances.at(-1);
  const expectation = assert.rejects(pending, /CDP connect failed/);
  ws.onerror();
  await expectation;
  assert.equal(cdp.ws, null);
});

test('connect：成功後 ws 就緒；close() 之後一律拒絕傳送', async (t) => {
  const { cdp, ws } = await connectedCdp(t);
  assert.equal(cdp.ws, ws);
  assert.equal(cdp.closed, false);

  cdp.close();
  assert.equal(ws.closedByClient, true);
  await assert.rejects(cdp.send('Runtime.evaluate'), /CDP connection closed/);

  const idle = new Cdp('ws://127.0.0.1:1/devtools/browser/fake-for-test');
  await assert.rejects(idle.send('Runtime.evaluate'), /CDP connection closed/);
});

test('send／_recv：請求與回應依 id 配對，sessionId 只在有值時帶入', async (t) => {
  const { cdp, ws } = await connectedCdp(t);

  const withSession = cdp.send('Runtime.evaluate', { expression: '1+1' }, { sessionId: 'S-1', timeout: 1000 });
  assert.equal(ws.sent.length, 1);
  assert.deepEqual(JSON.parse(ws.sent[0]), {
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression: '1+1' },
    sessionId: 'S-1',
  });
  cdp._recv(JSON.stringify({ id: 1, sessionId: 'S-1', result: { result: { value: 2 } } }));
  assert.deepEqual(await withSession, { result: { value: 2 } });
  assert.equal(cdp.pending.size, 0);

  const noSession = cdp.send('Target.getTargets', {});
  const msg2 = JSON.parse(ws.sent[1]);
  assert.equal('sessionId' in msg2, false);
  assert.equal(msg2.id, 2);
  cdp._recv(JSON.stringify({ id: 2, result: { targetInfos: [] } }));
  assert.deepEqual(await noSession, { targetInfos: [] });
  assert.equal(cdp.pending.size, 0);
});

test('_recv：CDP error 轉成 CdpError 並清掉 pending', async (t) => {
  const { cdp, ws } = await connectedCdp(t);
  const pending = cdp.send('Page.navigate', { url: 'about:blank' }, { timeout: 1000 });
  const id = JSON.parse(ws.sent[0]).id;
  const expectation = assert.rejects(pending, (err) => {
    assert.ok(err instanceof CdpError);
    assert.equal(err.name, 'CdpError');
    assert.match(err.message, /Page\.navigate: boom/);
    assert.deepEqual(err.cdpError, { code: -32000, message: 'boom' });
    return true;
  });
  cdp._recv(JSON.stringify({ id, error: { code: -32000, message: 'boom' } }));
  await expectation;
  assert.equal(cdp.pending.size, 0);
});

test('send：逾時會 reject 並清掉 pending', async (t) => {
  const { cdp } = await connectedCdp(t);
  await assert.rejects(
    cdp.send('Runtime.evaluate', {}, { timeout: 20 }),
    /Runtime\.evaluate timed out after 20ms/,
  );
  assert.equal(cdp.pending.size, 0);
});

test('_recv：壞 JSON、未知 id 都被安全忽略，字串與 Buffer 皆可解析', async (t) => {
  const { cdp } = await connectedCdp(t);
  const seen = [];
  cdp.onEvent((ev) => seen.push(ev.method));

  assert.doesNotThrow(() => cdp._recv('not-json'));
  assert.doesNotThrow(() => cdp._recv(JSON.stringify({ id: 9999, result: {} })));
  assert.doesNotThrow(() => cdp._recv(Buffer.from(JSON.stringify({ method: 'Page.loadEventFired' }))));

  assert.deepEqual(seen, ['Page.loadEventFired']);
});

test('事件分派：sessionId 會被記錄，handler 收到正規化欄位並可退訂', async (t) => {
  const { cdp } = await connectedCdp(t);
  const events = [];
  const off = cdp.onEvent((ev) => events.push(ev));

  cdp._recv(JSON.stringify({ method: 'Page.loadEventFired', sessionId: 'S-1', params: { timestamp: 1 } }));
  cdp._recv(JSON.stringify({ method: 'Target.targetCreated' }));

  assert.deepEqual(events, [
    { sessionId: 'S-1', method: 'Page.loadEventFired', params: { timestamp: 1 } },
    { sessionId: null, method: 'Target.targetCreated', params: {} },
  ]);
  assert.equal(cdp.sessions.has('S-1'), true);

  off();
  cdp._recv(JSON.stringify({ method: 'Page.frameNavigated' }));
  assert.equal(events.length, 2);
});

test('事件 handler 丟錯會被隔離，不影響其他 handler', (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const cdp = new Cdp('ws://127.0.0.1:1/devtools/browser/fake-for-test');
  const seen = [];
  cdp.onEvent(() => { throw new Error('handler boom'); });
  cdp.onEvent(() => seen.push('second'));

  cdp._recv(JSON.stringify({ method: 'Page.loadEventFired' }));

  assert.deepEqual(seen, ['second']);
  assert.equal(errors.mock.callCount(), 1);
});

test('連線關閉：pending 全部 reject、標記 closed 並通知 onClose', async (t) => {
  const { cdp, ws } = await connectedCdp(t);
  let closeCalls = 0;
  cdp.onClose(() => { closeCalls++; });

  const pending = cdp.send('Runtime.evaluate', {}, { timeout: 50 });
  const expectation = assert.rejects(pending, /CDP connection closed/);
  ws.onclose();
  await expectation;

  assert.equal(closeCalls, 1);
  assert.equal(cdp.closed, true);
  assert.equal(cdp.pending.size, 0);
  await assert.rejects(cdp.send('Runtime.evaluate'), /CDP connection closed/);
});

test('once：等待指定事件、支援 sessionId 過濾、逾時後移除 handler', async () => {
  const cdp = new Cdp('ws://127.0.0.1:1/devtools/browser/fake-for-test');

  const anySession = once(cdp, 'Target.targetCreated', { timeout: 200 });
  cdp._recv(JSON.stringify({ method: 'Target.targetCreated', sessionId: 'S-1', params: { a: 1 } }));
  assert.deepEqual(await anySession, { a: 1 });
  assert.equal(cdp.handlers.size, 0);

  const filtered = once(cdp, 'Page.loadEventFired', { sessionId: 'S-9', timeout: 200 });
  cdp._recv(JSON.stringify({ method: 'Page.loadEventFired', sessionId: 'S-other', params: { n: 1 } }));
  cdp._recv(JSON.stringify({ method: 'Page.loadEventFired', sessionId: 'S-9', params: { n: 2 } }));
  assert.deepEqual(await filtered, { n: 2 });
  assert.equal(cdp.handlers.size, 0);

  await assert.rejects(
    once(cdp, 'Never.happens', { timeout: 20 }),
    /Never\.happens event timed out after 20ms/,
  );
  assert.equal(cdp.handlers.size, 0);
});
