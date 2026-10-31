// 針對 daemon/cdp.js 的 CDP 用戶端行為測試。
// 只用假的 WebSocket 物件（完全不連線），另外用 loopback HTTP 伺服器驗證
// 「連到非 WebSocket 端點」時的失敗路徑（不接觸任何外部服務）。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { Cdp, CdpError, once } from '../daemon/cdp.js';

function fakeSocket() {
  const sent = [];
  return {
    readyState: 1,
    sent,
    closed: false,
    send(raw) { sent.push(JSON.parse(raw)); },
    close() { this.closed = true; this.readyState = 3; },
  };
}

// 建立一個「已連線」的 Cdp：直接塞入假 socket，繞過真正的 WebSocket 握手。
function attachedCdp() {
  const cdp = new Cdp('ws://127.0.0.1:1/devtools/browser/FAKE_VALUE_FOR_TEST', 'unit');
  cdp.ws = fakeSocket();
  return cdp;
}

test('Cdp 建構子的預設狀態', () => {
  const cdp = new Cdp('ws://127.0.0.1:1/devtools/browser/x');
  assert.equal(cdp.label, 'cdp');
  assert.equal(cdp.id, 0);
  assert.equal(cdp.closed, false);
  assert.equal(cdp.pending.size, 0);
  assert.equal(cdp.handlers.size, 0);
  assert.equal(cdp.sessions.size, 0);
});

test('CdpError 會保留 CDP 原始錯誤物件', () => {
  const err = new CdpError('Page.navigate', { code: -32000, message: 'boom' });
  assert.equal(err.name, 'CdpError');
  assert.equal(err.message, 'Page.navigate: boom');
  assert.deepEqual(err.cdpError, { code: -32000, message: 'boom' });
  assert.ok(err instanceof Error);

  // 沒有 message 時退回 JSON 字串
  assert.equal(new CdpError('Runtime.evaluate', { code: -32601 }).message, 'Runtime.evaluate: {"code":-32601}');
});

test('未連線時 send() 立即拒絕（不建立 pending）', async () => {
  const cdp = new Cdp('ws://127.0.0.1:1/devtools/browser/x');
  await assert.rejects(cdp.send('Page.enable'), /CDP connection closed/);
  assert.equal(cdp.pending.size, 0);
});

test('send() 會遞增 id、帶上 sessionId，並在收到 result 後 resolve', async () => {
  const cdp = attachedCdp();

  const first = cdp.send('Page.enable');
  const second = cdp.send('Runtime.evaluate', { expression: '1+1' }, { sessionId: 'SESSION-1' });

  assert.equal(cdp.ws.sent.length, 2);
  assert.deepEqual(cdp.ws.sent[0], { id: 1, method: 'Page.enable', params: {} });
  assert.deepEqual(cdp.ws.sent[1], {
    id: 2, method: 'Runtime.evaluate', params: { expression: '1+1' }, sessionId: 'SESSION-1',
  });
  assert.equal(cdp.pending.size, 2);

  cdp._recv(JSON.stringify({ id: 1, result: { ok: true } }));
  cdp._recv(JSON.stringify({ id: 2, result: { result: { value: 2 } }, sessionId: 'SESSION-1' }));

  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(await second, { result: { value: 2 } });
  assert.equal(cdp.pending.size, 0);
});

test('CDP error 回應會以 CdpError 拒絕並清掉 pending', async () => {
  const cdp = attachedCdp();
  const p = cdp.send('Runtime.evaluate', { expression: 'throw 1' }, { timeout: 5000 });
  const id = cdp.ws.sent[0].id;

  cdp._recv(JSON.stringify({ id, error: { code: -32000, message: 'Evaluation failed' } }));

  await assert.rejects(p, (err) => {
    assert.ok(err instanceof CdpError);
    assert.equal(err.message, 'Runtime.evaluate: Evaluation failed');
    assert.equal(err.cdpError.code, -32000);
    return true;
  });
  assert.equal(cdp.pending.size, 0);
});

test('send() 逾時會拒絕並清掉 pending（避免洩漏計時器）', async () => {
  const cdp = attachedCdp();
  await assert.rejects(cdp.send('Slow.command', {}, { timeout: 20 }), /Slow\.command timed out after 20ms/);
  assert.equal(cdp.pending.size, 0);
});

test('事件分派：sessionId/params 正規化、onEvent 可退訂、sessions 會被記錄', () => {
  const cdp = attachedCdp();
  const seen = [];
  const off = cdp.onEvent((ev) => seen.push(ev));

  cdp._recv(JSON.stringify({ method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: 'S9' }));
  cdp._recv(JSON.stringify({ method: 'Target.detachedFromTarget' }));

  assert.equal(cdp.sessions.has('S9'), true);
  assert.deepEqual(seen[0], { sessionId: 'S9', method: 'Page.loadEventFired', params: { timestamp: 1 } });
  assert.deepEqual(seen[1], { sessionId: null, method: 'Target.detachedFromTarget', params: {} });

  off();
  assert.equal(cdp.handlers.size, 0);
  cdp._recv(JSON.stringify({ method: 'Page.frameNavigated', params: {} }));
  assert.equal(seen.length, 2, '退訂後不應再收到事件');
});

test('單一 handler 拋錯不會影響其他 handler', () => {
  const cdp = attachedCdp();
  const log = [];
  const original = console.error;
  console.error = (...args) => log.push(args.map((a) => String(a)).join(' '));
  try {
    let secondCalls = 0;
    cdp.onEvent(() => { throw new Error('handler boom'); });
    cdp.onEvent(() => { secondCalls += 1; });
    cdp._recv(JSON.stringify({ method: 'Page.anything', params: {} }));
    assert.equal(secondCalls, 1);
    assert.ok(log.some((line) => line.includes('handler boom')), `應記錄 handler 錯誤：${JSON.stringify(log)}`);
  } finally {
    console.error = original;
  }
});

test('無法解析的訊息與未知 id 會被安全忽略', () => {
  const cdp = attachedCdp();
  assert.doesNotThrow(() => cdp._recv('not-json-at-all'));
  assert.doesNotThrow(() => cdp._recv(JSON.stringify({ id: 999, result: {} })));
  assert.equal(cdp.closed, false);
  assert.equal(cdp.pending.size, 0);
});

test('close() 會標記關閉、關掉 socket，之後 send() 直接拒絕', async () => {
  const cdp = attachedCdp();
  cdp.close();
  assert.equal(cdp.closed, true);
  assert.equal(cdp.ws.closed, true);
  await assert.rejects(cdp.send('Page.enable'), /CDP connection closed/);
});

test('once() 等到對應事件才 resolve，並自動解除訂閱', async () => {
  const cdp = attachedCdp();
  const wait = once(cdp, 'Page.frameNavigated', { timeout: 2000 });

  cdp._recv(JSON.stringify({ method: 'Other.event', params: {} }));
  cdp._recv(JSON.stringify({ method: 'Page.frameNavigated', params: { frame: { id: 'F1' } } }));

  assert.deepEqual(await wait, { frame: { id: 'F1' } });
  assert.equal(cdp.handlers.size, 0);
});

test('once() 會依 sessionId 過濾事件', async () => {
  const cdp = attachedCdp();
  const wait = once(cdp, 'Runtime.consoleAPICalled', { sessionId: 'S1', timeout: 2000 });

  cdp._recv(JSON.stringify({ method: 'Runtime.consoleAPICalled', params: { n: 1 }, sessionId: 'S2' }));
  cdp._recv(JSON.stringify({ method: 'Runtime.consoleAPICalled', params: { n: 2 }, sessionId: 'S1' }));

  assert.deepEqual(await wait, { n: 2 });
  assert.equal(cdp.handlers.size, 0);
});

test('once() 逾時會拒絕並解除訂閱', async () => {
  const cdp = attachedCdp();
  await assert.rejects(once(cdp, 'Never.happens', { timeout: 20 }), /Never\.happens event timed out after 20ms/);
  assert.equal(cdp.handlers.size, 0);
});

test('connect() 對「不是 WebSocket」的端點會拒絕而非卡死', async (t) => {
  if (typeof WebSocket === 'undefined') {
    t.skip('此 Node 版本沒有全域 WebSocket（本專案要求 Node >= 22）');
    return;
  }

  let server;
  try {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('not a websocket endpoint');
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (err) {
    t.skip(`無法在 127.0.0.1 綁定測試用 HTTP 伺服器：${err.message}`);
    return;
  }

  try {
    const { port } = server.address();
    const cdp = new Cdp(`ws://127.0.0.1:${port}/devtools/browser/FAKE_VALUE_FOR_TEST`, 'connect-test');
    await assert.rejects(cdp.connect(3000), /CDP connect failed/);
    assert.equal(cdp.ws, null, '失敗後不應留下半連線的 socket');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
