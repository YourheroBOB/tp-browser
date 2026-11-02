// tests/fmb_w11_s10_sdk_bad_response.test.mjs
// lib/sdk.js createClient() 在「daemon 回應格式異常」時的錯誤處理回歸測試。
// 零網路、零檔案讀寫、零真實憑證（token 一律用明顯假值）；只用假的 fetchImpl／ReadableStream。
//
//  1.【回歸，修正前會失敗】POST /rpc 收到非 JSON 回應。
//     修正前：直接 res.json()，呼叫端收到原始 SyntaxError
//     （例如 "Unexpected token < in JSON at position 0"）：訊息沒有 HTTP 狀態碼，
//     也沒有「是哪一個 RPC 方法失敗」，無法判斷該重試、該重新認證，還是自己的程式有問題。
//     修正後：拋出 EgoError('HttpError')，訊息同時帶 HTTP 狀態與 RPC 方法名稱。
//
//  2.【回歸，修正前會失敗】GET /events 回 2xx 但沒有可讀 body（null 或非串流物件）。
//     修正前：res.body.getReader() 的 TypeError 被 catch 吞掉，只重設 sseStarted，
//     等待者要等到自己 timeout（預設 30 秒）才失敗，而 TimeoutError 完全指錯原因。
//     修正後：立刻以 EgoError('EventStreamError') reject 所有等待者。
//
// 既有的正常路徑（200 的可讀 SSE、403 AuthError、JSON 的 {ok:false}）一併做回歸保護，
// 確保新包裝沒有蓋掉原有語意。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, EgoError } from '../lib/sdk.js';

const TOKEN = 'FAKE_VALUE_FOR_TEST';
const enc = new TextEncoder();

// 產生一個「解析 JSON 就失敗」的 res.json：模擬非 JSON／被截斷的 body。
const jsonThrows = (err) => async () => { throw err; };

// ---- 一、/rpc 非 JSON 回應 -------------------------------------------------

test('/rpc 非 JSON（HTTP 502 + HTML 錯誤頁）→ EgoError(HttpError)，訊息含狀態與方法名', async () => {
  const client = createClient({
    port: 9772,
    token: TOKEN,
    fetchImpl: async () => ({
      status: 502,
      ok: false,
      json: jsonThrows(new SyntaxError('Unexpected token < in JSON at position 0')),
    }),
  });

  await assert.rejects(
    client.rpc('space.list'),
    (e) => e instanceof EgoError
      && e.name === 'HttpError'
      && /space\.list/.test(e.message)
      && /502/.test(e.message),
  );
});

test('/rpc 回 200 但 body 被截斷 → 仍是 HttpError，不讓原始 SyntaxError 漏出去', async () => {
  const client = createClient({
    port: 9772,
    token: TOKEN,
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      json: jsonThrows(new SyntaxError('Unexpected end of JSON input')),
    }),
  });

  await assert.rejects(
    client.rpc('page.call', { label: 'p1' }),
    (e) => e instanceof EgoError
      && e.name === 'HttpError'
      && /page\.call/.test(e.message)
      && /200/.test(e.message),
  );
});

test('回歸：403 仍優先轉成 AuthError（即使 body 根本無法解析）', async () => {
  const client = createClient({
    port: 9772,
    token: TOKEN,
    fetchImpl: async () => ({ status: 403, ok: false, json: jsonThrows(new SyntaxError('nope')) }),
  });

  await assert.rejects(
    client.rpc('space.list'),
    (e) => e instanceof EgoError && e.name === 'AuthError' && /rejected the token/.test(e.message),
  );
});

test('回歸：可解析的 {ok:false} 仍轉成 daemon 提供的 name/message', async () => {
  const client = createClient({
    port: 9772,
    token: TOKEN,
    fetchImpl: async () => ({
      status: 200,
      ok: true,
      json: async () => ({ ok: false, error: { name: 'NoSuchSpace', message: 'space 9 not found' } }),
    }),
  });

  await assert.rejects(
    client.rpc('space.use', { idOrName: 9 }),
    (e) => e instanceof EgoError && e.name === 'NoSuchSpace' && e.message === 'space 9 not found',
  );
});

// ---- 二、/events 2xx 但沒有可讀 body ---------------------------------------

test('/events 回 200 但 body 為 null → 立刻 EventStreamError，不等逾時', async () => {
  const client = createClient({
    port: 9772,
    token: TOKEN,
    fetchImpl: async () => ({ status: 200, ok: true, body: null }),
  });

  const t0 = Date.now();
  await assert.rejects(
    client.waitPush(() => true, 300),
    (e) => e instanceof EgoError
      && e.name === 'EventStreamError'
      && /readable body/.test(e.message),
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 100, `應在 100ms 內失敗，實際 ${elapsed}ms`);
});

test('/events 回 200 但 body 不是可讀串流 → 立刻 EventStreamError，且一次 reject 所有等待者', async () => {
  const client = createClient({
    port: 9772,
    token: TOKEN,
    fetchImpl: async () => ({ status: 200, ok: true, body: {} }),
  });

  // 兩個等待者都必須立刻失敗（handler 同步掛上，避免 unhandled rejection）。
  const a = assert.rejects(
    client.waitPush(() => true, 300),
    (e) => e instanceof EgoError && e.name === 'EventStreamError',
  );
  const b = assert.rejects(
    client.waitPush(() => true, 300),
    (e) => e instanceof EgoError && e.name === 'EventStreamError',
  );
  await Promise.all([a, b]);
});

test('回歸：/events 403 仍是立刻 AuthError（body 檢查不可蓋掉狀態檢查）', async () => {
  const client = createClient({
    port: 9772,
    token: TOKEN,
    fetchImpl: async () => ({ status: 403, ok: false, body: null }),
  });

  const t0 = Date.now();
  await assert.rejects(
    client.waitPush(() => true, 300),
    (e) => e instanceof EgoError && e.name === 'AuthError' && /rejected the token/.test(e.message),
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 100, `應在 100ms 內失敗，實際 ${elapsed}ms`);
});

test('回歸：200 的可讀 SSE 串流仍能正確解析推播', async () => {
  let ctrl;
  const body = new ReadableStream({ start(c) { ctrl = c; } });
  const client = createClient({
    port: 9772,
    token: TOKEN,
    fetchImpl: async () => ({ status: 200, ok: true, body }),
  });

  const p = client.waitPush((m) => m.kind === 'fileChooser', 2000);
  await new Promise((r) => setTimeout(r, 5));
  ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ type: 'push', kind: 'fileChooser', payload: { backendNodeId: 7 } })}\n\n`));

  const msg = await p;
  assert.equal(msg.payload.backendNodeId, 7);
  ctrl.close(); // 收尾：讓串流正常結束、狀態重設
});
