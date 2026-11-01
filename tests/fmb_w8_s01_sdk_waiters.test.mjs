// tests/fmb_w8_s01_sdk_waiters.test.mjs
// lib/sdk.js 兩個 bug 的回歸測試（零網路、零檔案讀寫、零真實憑證；token 用明顯假值）。
//
//  1.【回歸，修正前會失敗】page.waitForURL() 的 RegExp matcher。
//     修正前直接用 `matcher.test(urlStr)`：matcher 帶 g／y 旗標時 lastIndex 有狀態，
//     同一個 URL 連續輪詢會一次 true、一次 false；呼叫端若重用同一個 RegExp，
//     上一輪留下的 lastIndex 會讓已符合的 URL 被漏掉（/y 更嚴重：sticky 永遠從 0
//     開始比對，URL 開頭不是 match 就永遠不命中，只能等到 timeout）。
//     修正後：比對用的是一份去掉 g／y 的無狀態複本，呼叫端傳入的 RegExp 不被改動。
//
//  2.【回歸，修正前會失敗】createClient() 的 /events（SSE）串流。
//     修正前串流被伺服器正常關閉（reader done）只把 sseStarted 設回 false：還在等待的
//     waitPush 不會重新訂閱、也不會被拒絕，只能等到整個 timeout。
//     修正後：串流結束時若還有等待者就重新連線（有次數上限與遞增退避）；
//     重連次數用盡或重連被拒（403／非 2xx）時立刻以 EgoError 拒絕等待者。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSdk, createClient, EgoError } from '../lib/sdk.js';

const TOKEN = 'FAKE_VALUE_FOR_TEST';
const enc = new TextEncoder();

// 由字串片段組出真正的 ReadableStream；片段用盡後自動關閉（模擬伺服器正常關閉串流）。
function sseStream(chunks) {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) { controller.close(); return; }
      controller.enqueue(enc.encode(chunks[i++]));
    },
  });
}
const dataChunk = (msg) => `data: ${JSON.stringify(msg)}\n\n`;
const okRes = (chunks) => ({ status: 200, ok: true, body: sseStream(chunks) });

// ---- 1. page.waitForURL 的 RegExp matcher ----------------------------------

function makePage({ urls = ['https://a.test/x'] } = {}) {
  const calls = [];
  const pages = [{ label: 'p1', targetId: 'T1' }];
  let urlIdx = 0;
  const rpc = async (method, params = {}) => {
    calls.push({ method, params });
    if (method === 'space.use') return { id: 7, name: 'w8-s01', ownership: 'agent', state: 'active', pages };
    if (method === 'page.call' && params.method === 'url') {
      const u = urls[Math.min(urlIdx, urls.length - 1)];
      urlIdx += 1;
      return u;
    }
    return { ok: true };
  };
  const waitPush = () => { throw new Error('這個測試不該用到 waitPush'); };
  const sdk = buildSdk({ rpc, waitPush });
  const space = new sdk.TaskSpace({ id: 7, name: 'w8-s01', ownership: 'agent', state: 'active', pages });
  return { sdk, space, page: space.page('p1'), calls };
}
const urlCalls = (calls) => calls.filter((c) => c.method === 'page.call' && c.params.method === 'url');

test('waitForURL：/g matcher 不會因 lastIndex 翻轉而漏掉已符合的 URL', async () => {
  const { page, calls } = makePage({ urls: ['https://a.test/x'] });
  const matcher = /a\.test/g;
  // 模擬呼叫端先前用過同一個 RegExp，留下非 0 的 lastIndex。
  assert.equal(matcher.test('https://a.test/x'), true);
  const lastIndexBefore = matcher.lastIndex;
  assert.ok(lastIndexBefore > 0, '前置條件：lastIndex 已被推進');

  const u = await page.waitForURL(matcher, { timeout: 1000 });

  assert.equal(u, 'https://a.test/x');
  assert.equal(urlCalls(calls).length, 1, '應在第一輪輪詢就命中，不該因 lastIndex 翻轉多輪詢幾輪');
  assert.equal(matcher.lastIndex, lastIndexBefore, '不得改動呼叫端傳入的 RegExp');
});

test('waitForURL：/y（sticky）matcher 不會永遠不命中（修正前會一路等到 timeout）', async () => {
  const { page, calls } = makePage({ urls: ['https://a.test/x'] });

  const u = await page.waitForURL(/a\.test/y, { timeout: 1000 });

  assert.equal(u, 'https://a.test/x');
  assert.equal(urlCalls(calls).length, 1, 'sticky 不該因為從 index 0 開始比對而每輪都失敗');
});

test('waitForURL：字串／function matcher 與不符時的 TimeoutError 語意不變', async () => {
  const exact = makePage({ urls: ['https://a.test/x'] });
  assert.equal(await exact.page.waitForURL('https://a.test/x', { timeout: 500 }), 'https://a.test/x');

  const fn = makePage({ urls: ['https://a.test/x'] });
  assert.equal(
    await fn.page.waitForURL((parsed) => parsed.hostname === 'a.test', { timeout: 500 }),
    'https://a.test/x',
  );

  // 不相符時仍應逾時（不因修改而放寬成永遠命中）。
  const miss = makePage({ urls: ['https://b.test/x'] });
  await assert.rejects(
    miss.page.waitForURL(/a\.test/g, { timeout: 60 }),
    (e) => e instanceof EgoError && e.name === 'TimeoutError',
  );
});

// ---- 2. /events 串流中斷後的重連 -------------------------------------------

test('SSE 串流正常關閉後會重連：等待者不必等到 timeout', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      // 送出一個不相符的事件後由伺服器正常關閉串流。
      return okRes([dataChunk({ type: 'push', kind: 'noise', payload: {} })]);
    }
    return okRes([dataChunk({ type: 'push', kind: 'popup', payload: { targetId: 'T-2' } })]);
  };
  const client = createClient({ port: 9772, token: TOKEN, fetchImpl });

  const t0 = Date.now();
  const msg = await client.waitPush((m) => m.kind === 'popup', 2000);

  assert.equal(msg.payload.targetId, 'T-2');
  assert.equal(calls, 2, '串流結束後必須重新連線');
  assert.ok(Date.now() - t0 < 1500, `重連後應盡快收到事件，實際 ${Date.now() - t0}ms`);
});

test('SSE 重連時 /events 被拒（403）：立刻以 AuthError 失敗，不等 timeout', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return okRes([dataChunk({ type: 'push', kind: 'noise', payload: {} })]);
    return { status: 403, ok: false, body: null };
  };
  const client = createClient({ port: 9772, token: TOKEN, fetchImpl });

  // matcher 不可写成 () => true：那會在第一條串流的噪音事件上就 resolve，
  // 根本走不到重連。要讓第一條串流確實「沒有相符事件就關閉」，才會觸發重連。
  const t0 = Date.now();
  await assert.rejects(
    client.waitPush((m) => m.kind === 'popup', 5000),
    (e) => e instanceof EgoError && e.name === 'AuthError' && /rejected the token/.test(e.message),
  );

  assert.equal(calls, 2, '第一條串流結束後必須重連一次 /events');
  assert.ok(Date.now() - t0 < 1000, `重連被拒應立刻失敗，實際 ${Date.now() - t0}ms`);
});

test('SSE 反覆關閉、重連次數用盡：立刻以 EventStreamError 拒絕，不等 timeout', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    // 每次都只送一個不相符的事件就關閉串流。
    return okRes([dataChunk({ type: 'push', kind: 'noise', payload: {} })]);
  };
  const client = createClient({ port: 9772, token: TOKEN, fetchImpl });

  const t0 = Date.now();
  await assert.rejects(
    client.waitPush((m) => m.kind === 'popup', 30000),
    (e) => e instanceof EgoError && e.name === 'EventStreamError' && /reconnect/i.test(e.message),
  );
  const elapsed = Date.now() - t0;

  assert.ok(elapsed < 5000, `應在重連用盡後立刻失敗，實際 ${elapsed}ms`);
  assert.ok(calls >= 2 && calls <= 6, `重連次數應有上限，實際呼叫 /events ${calls} 次`);
});
