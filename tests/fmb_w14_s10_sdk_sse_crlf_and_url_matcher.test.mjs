// tests/fmb_w14_s10_sdk_sse_crlf_and_url_matcher.test.mjs
// lib/sdk.js 回歸測試。零網路、零檔案讀寫；token 只用明顯假值。
//
//  1. createClient 的 SSE 解析只認 `\n\n`。text/event-stream 允許以 CRLF 或 CR
//     空行分隔事件；`\r\n\r\n` 裡兩個 LF 中間還有 CR，indexOf('\\n\\n') 對不上，
//     推播會留在 buffer，waitPush 最後只得到 TimeoutError。CR 斷行的註解列也會
//     和 data 列黏成一行，JSON.parse 失敗後被靜默跳過。
//  2. page.waitForURL 對非法 matcher（數字、null、普通物件）會每 150ms 輪詢到
//     timeout，真正的型別錯誤被包成 TimeoutError。函式 matcher 自己丟出的例外
//     也被當成「這一輪不符合」。
//  3. TaskSpace.userPage 在 space.use 回 null 時讀 view.pages，丟 TypeError。
//     同檔 _refresh 已改走 view?.pages。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSdk, createClient, EgoError } from '../lib/sdk.js';

const TOKEN = 'FAKE_VALUE_FOR_TEST';
const enc = new TextEncoder();

function sseStream(chunks) {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) { controller.close(); return; }
      controller.enqueue(enc.encode(chunks[i++]));
    },
  });
}

function clientWithBody(body) {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    assert.match(String(url), /^http:\/\/127\.0\.0\.1:\d+\/events$/);
    return { status: 200, ok: true, body };
  };
  const client = createClient({ port: 9772, token: TOKEN, fetchImpl });
  return { client, calls: () => calls };
}

const popup = (targetId) => ({ type: 'push', kind: 'popup', payload: { targetId } });

test('CRLF 空行分隔的 SSE 推播必須送達，而不是等到逾時', async () => {
  const msg = popup('T-crlf');
  const { client } = clientWithBody(sseStream([`data: ${JSON.stringify(msg)}\r\n\r\n`]));
  const t0 = Date.now();
  const got = await client.waitPush((m) => m.kind === 'popup', 1000);
  assert.ok(Date.now() - t0 < 800, 'CRLF 事件應在訂閱後立刻送達');
  assert.equal(got.payload.targetId, 'T-crlf');
});

test('CRLF 邊界拆成兩個 chunk 時仍能組成一則推播', async () => {
  const msg = { type: 'push', kind: 'download', targetId: 'T-1', payload: { kind: 'begin', guid: 'g-9' } };
  const raw = `data: ${JSON.stringify(msg)}\r\n\r\n`;
  const cut = raw.indexOf('\r\n\r\n');
  const { client } = clientWithBody(sseStream([raw.slice(0, cut + 2), raw.slice(cut + 2)]));
  const got = await client.waitPush((m) => m.kind === 'download', 1000);
  assert.equal(got.payload.guid, 'g-9');
});

test('僅 CR 斷行、且含註解列的 SSE 推播必須送達', async () => {
  const msg = { type: 'push', kind: 'fileChooser', targetId: 'T-3', payload: { backendNodeId: 11, mode: 'selectSingle' } };
  const frame = `: keep-alive\rdata: ${JSON.stringify(msg)}\r\r`;
  const { client } = clientWithBody(sseStream([frame]));
  const got = await client.waitPush((m) => m.kind === 'fileChooser', 1000);
  assert.equal(got.payload.backendNodeId, 11);
  assert.equal(got.payload.mode, 'selectSingle');
});

test('同一條 CRLF 串流的兩則推播分別喚醒兩個已在等待的 waiter', async () => {
  const frame = `data: ${JSON.stringify(popup('A'))}\r\n\r\ndata: ${JSON.stringify(popup('B'))}\r\n\r\n`;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode(frame));
      controller.close();
    },
  });
  const { client, calls } = clientWithBody(body);
  const p1 = client.waitPush((m) => m.payload && m.payload.targetId === 'A', 1000);
  const p2 = client.waitPush((m) => m.payload && m.payload.targetId === 'B', 1000);
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.payload.targetId, 'A');
  assert.equal(r2.payload.targetId, 'B');
  assert.equal(calls(), 1, '兩個 waiter 應共用同一條 /events');
});

test('LF 註解事件會被跳過，下一則 data 仍送達（回歸）', async () => {
  const msg = popup('T-lf');
  const frame = `: ping\n\ndata: ${JSON.stringify(msg)}\n\n`;
  const { client } = clientWithBody(sseStream([frame]));
  const got = await client.waitPush((m) => m.kind === 'popup', 1000);
  assert.equal(got.payload.targetId, 'T-lf');
});

test('含 event 欄位的 CRLF 事件仍取出 data 行', async () => {
  const msg = popup('T-ev');
  const frame = `event: push\r\ndata: ${JSON.stringify(msg)}\r\n\r\n`;
  const { client } = clientWithBody(sseStream([frame]));
  const got = await client.waitPush((m) => m.kind === 'popup', 1000);
  assert.equal(got.payload.targetId, 'T-ev');
});

function makePage({ urls }) {
  const calls = [];
  let i = 0;
  const rpc = async (method, params = {}) => {
    calls.push({ method, params });
    if (method === 'page.call' && params.method === 'url') {
      const u = urls[Math.min(i, urls.length - 1)];
      i += 1;
      return u;
    }
    return {};
  };
  const sdk = buildSdk({
    rpc,
    waitPush: () => { throw new Error('這個測試不該用到 waitPush'); },
  });
  const space = new sdk.TaskSpace({
    id: 3,
    name: 'w14-s10',
    ownership: 'agent',
    state: 'active',
    pages: [{ label: 'p1', targetId: 'T1' }],
  });
  return { page: space.page('p1'), calls };
}

const urlCalls = (calls) => calls.filter((c) => c.method === 'page.call' && c.params.method === 'url');

test('waitForURL 非法 matcher 在呼叫 url() 之前就以 InvalidArgumentError 拒絕', async () => {
  const cases = [
    [1, 'number'],
    [null, 'null'],
    [undefined, 'undefined'],
    [{ test: () => true }, 'object'],
    [true, 'boolean'],
  ];
  for (const [matcher, kind] of cases) {
    const { page, calls } = makePage({ urls: ['http://127.0.0.1/ready'] });
    const t0 = Date.now();
    await assert.rejects(
      page.waitForURL(matcher, { timeout: 5000 }),
      (e) => e instanceof EgoError && e.name === 'InvalidArgumentError' && e.message.includes(kind),
      `kind=${kind}`,
    );
    assert.ok(Date.now() - t0 < 100, `kind=${kind} 應立刻拒絕`);
    assert.equal(urlCalls(calls).length, 0, `kind=${kind} 不該打 url()`);
  }
});

test('waitForURL：空字串、完全相等、RegExp、函式 matcher 命中即回傳該 URL', async () => {
  const ready = 'http://127.0.0.1/ready';
  {
    const { page, calls } = makePage({ urls: [''] });
    assert.equal(await page.waitForURL('', { timeout: 200 }), '');
    assert.equal(urlCalls(calls).length, 1);
  }
  {
    const { page, calls } = makePage({ urls: [ready] });
    assert.equal(await page.waitForURL(ready, { timeout: 200 }), ready);
    assert.equal(urlCalls(calls).length, 1);
  }
  {
    const { page } = makePage({ urls: [ready] });
    assert.equal(await page.waitForURL(/\/ready$/, { timeout: 200 }), ready);
  }
  {
    const { page } = makePage({ urls: [ready] });
    assert.equal(await page.waitForURL((u) => u.pathname === '/ready', { timeout: 200 }), ready);
  }
});

test('函式 matcher 自己丟出的錯誤要立刻外傳，不可輪詢到逾時', async () => {
  const { page, calls } = makePage({ urls: ['http://127.0.0.1/ready'] });
  const t0 = Date.now();
  await assert.rejects(
    page.waitForURL(() => { throw new Error('matcher blew up'); }, { timeout: 5000 }),
    (e) => e instanceof Error && e.message === 'matcher blew up',
  );
  assert.ok(Date.now() - t0 < 200);
  assert.equal(urlCalls(calls).length, 1);
});

test('無法解析的 URL 不呼叫函式 matcher，並以 TimeoutError 結束', async () => {
  let matcherCalls = 0;
  const { page } = makePage({ urls: ['not a url'] });
  await assert.rejects(
    page.waitForURL(() => { matcherCalls += 1; return true; }, { timeout: 40 }),
    (e) => e instanceof EgoError && e.name === 'TimeoutError',
  );
  assert.equal(matcherCalls, 0);
});

function spaceWith(rpcResult) {
  const sdk = buildSdk({
    rpc: async () => rpcResult,
    waitPush: () => { throw new Error('這個測試不該用到 waitPush'); },
  });
  const space = new sdk.TaskSpace({
    id: 7,
    name: 'w14-s10',
    ownership: 'agent',
    state: 'active',
    pages: [],
  });
  return space;
}

test('userPage：space.use 回 null 時回傳 null，不丟 TypeError', async () => {
  const space = spaceWith(null);
  assert.equal(await space.userPage(), null);
});

test('userPage：view 沒有 pages 時回傳 null（回歸）', async () => {
  const space = spaceWith({ id: 7 });
  assert.equal(await space.userPage(), null);
});

test('userPage：回傳 pages[0] 的 Page（回歸）', async () => {
  const space = spaceWith({
    id: 7,
    pages: [{ label: 'p9', targetId: 'T9' }, { label: 'p1', targetId: 'T1' }],
  });
  const page = await space.userPage();
  assert.equal(page.label, 'p9');
  assert.equal(page.targetId, 'T9');
  assert.equal(page.spaceId, 7);
});
