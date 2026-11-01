// tests/fmb_w1_s04_sdk_sse.test.mjs
// lib/sdk.js createClient() 的 /events（SSE）生命週期回歸測試：
//  1. 串流結束或讀取出錯後必須放掉 sseStarted，下一次 waitPush 要重新訂閱 /events。
//  2. /events 回 403 時必須立刻以 AuthError reject 目前所有等待者（不得等到逾時）。
//  3. /events 回其他非 2xx 時以 EventStreamError 一次 reject 所有等待者。
// 全程使用假的 fetchImpl + ReadableStream：不連線任何網路、不讀寫任何檔案、不使用真實憑證。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, EgoError } from '../lib/sdk.js';

const TOKEN = 'FAKE_VALUE_FOR_TEST';
const enc = new TextEncoder();

// 由字串片段組出真正的 ReadableStream；片段用盡後自動關閉（模擬串流結束）。
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
const statusRes = (status) => ({ status, ok: status >= 200 && status < 300, body: null });

test('串流結束後會重新訂閱：第二次 waitPush 再呼叫一次 /events 並收到推播', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) return okRes([]); // 模擬 daemon 重啟：串流立刻結束
    return okRes([dataChunk({ type: 'push', kind: 'popup', payload: { openerId: 'T-1', targetId: 'T-2' } })]);
  };
  const client = createClient({ port: 9772, token: TOKEN, fetchImpl });

  // 第一次訂閱的串流立刻結束、沒有推播 → 等待者逾時，但狀態必須被重設。
  await assert.rejects(
    client.waitPush((m) => m.kind === 'popup', 50),
    (e) => e instanceof EgoError && e.name === 'TimeoutError',
  );
  assert.equal(calls.length, 1, '此時不該憑空多出第二次訂閱');

  // 第二次 waitPush 必須重新訂閱，並由第二條串流收到推播。
  const msg = await client.waitPush((m) => m.kind === 'popup', 2000);
  assert.equal(calls.length, 2, '串流結束後必須重新呼叫 /events');
  assert.match(calls[1].url, /\/events$/);
  assert.equal(calls[1].init.headers['x-ego-token'], TOKEN);
  assert.equal(msg.payload.targetId, 'T-2');
});

test('串流讀取錯誤後同樣會重新訂閱', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        status: 200,
        ok: true,
        body: new ReadableStream({ pull(controller) { controller.error(new Error('connection reset')); } }),
      };
    }
    return okRes([dataChunk({ type: 'push', kind: 'download', targetId: 'T-1', payload: { kind: 'begin', guid: 'g-1' } })]);
  };
  const client = createClient({ port: 9772, token: TOKEN, fetchImpl });

  await assert.rejects(
    client.waitPush(() => false, 50),
    (e) => e instanceof EgoError && e.name === 'TimeoutError',
  );
  const msg = await client.waitPush((m) => m.kind === 'download', 2000);
  assert.equal(calls, 2, '串流出錯後必須重新呼叫 /events');
  assert.equal(msg.payload.guid, 'g-1');
});

test('/events 回 403 時立即以 AuthError reject，不等逾時', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return statusRes(403); };
  const client = createClient({ port: 9774, token: TOKEN, fetchImpl });

  const t0 = Date.now();
  await assert.rejects(
    client.waitPush(() => true, 5000),
    (e) => e instanceof EgoError && e.name === 'AuthError' && /rejected the token/.test(e.message),
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 100, `403 應在 100ms 內失敗，實際 ${elapsed}ms`);
  assert.equal(calls, 1);
});

test('/events 其他非 2xx 時以 EventStreamError 一次 reject 所有等待者', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return statusRes(500); };
  const client = createClient({ port: 9772, token: TOKEN, fetchImpl });

  // 兩個等待者都必須立刻失敗（handler 立刻掛上，避免 unhandled rejection）。
  const a = assert.rejects(
    client.waitPush(() => true, 5000),
    (e) => e instanceof EgoError && e.name === 'EventStreamError' && /HTTP 500/.test(e.message),
  );
  const b = assert.rejects(
    client.waitPush(() => true, 5000),
    (e) => e instanceof EgoError && e.name === 'EventStreamError',
  );
  await Promise.all([a, b]);
  assert.equal(calls, 1, '同一次失敗不應重複發起多條串流');
});

test('403 失敗後狀態已重設，下一次 waitPush 會重新嘗試訂閱', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return statusRes(403);
    return okRes([dataChunk({ type: 'push', kind: 'fileChooser', targetId: 'T-1', payload: { backendNodeId: 7, mode: 'selectSingle' } })]);
  };
  const client = createClient({ port: 9772, token: TOKEN, fetchImpl });

  await assert.rejects(client.waitPush(() => true, 5000), (e) => e instanceof EgoError && e.name === 'AuthError');
  const msg = await client.waitPush((m) => m.kind === 'fileChooser', 2000);
  assert.equal(calls, 2);
  assert.equal(msg.payload.backendNodeId, 7);
});

test('正常串流：收到符合條件的推播就 resolve（回歸）', async () => {
  let ctrl;
  const body = new ReadableStream({ start(c) { ctrl = c; } });
  const client = createClient({ port: 9772, token: TOKEN, fetchImpl: async () => ({ status: 200, ok: true, body }) });

  const p = client.waitPush((m) => m.type === 'push' && m.kind === 'popup', 2000);
  await new Promise((r) => setTimeout(r, 5));
  ctrl.enqueue(enc.encode(dataChunk({ type: 'push', kind: 'popup', payload: { targetId: 'T-9' } })));

  const msg = await p;
  assert.equal(msg.payload.targetId, 'T-9');
  ctrl.close(); // 收尾：讓串流正常結束
});
