// tests/fmb_w13_s10_sdk_sse_line_endings.test.mjs
// lib/sdk.js createClient() 的 /events（SSE）換行處理回歸測試。
// 全程零網路、零檔案讀寫、零真實憑證：只用假的 fetchImpl + ReadableStream，
// token 一律是明顯假值 FAKE_VALUE_FOR_TEST，事件內容皆為假資料。
//
// 【回歸，修正前會失敗】SSE 規格允許 CRLF、CR、LF 三種換行，舊版只找 '\n\n'。
// daemon 若（或中間的 HTTP 代理）改用 CRLF，整條串流的推播都解析不出來，
// waitPush 只能一路等到 timeout，錯誤訊息指向「事件沒發生」而非換行格式。
// 修正後三種換行都能解析，且分隔字串被切成兩個 chunk 時仍能正確組回。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, EgoError } from '../lib/sdk.js';

const TOKEN = 'FAKE_VALUE_FOR_TEST';
const enc = new TextEncoder();

// 建立一個可手動餵資料的客戶端（不連線任何服務）。
function harness() {
  let ctrl;
  const body = new ReadableStream({ start(c) { ctrl = c; } });
  const client = createClient({
    port: 9772,
    token: TOKEN,
    fetchImpl: async () => ({ status: 200, ok: true, body }),
  });
  const push = (s) => ctrl.enqueue(enc.encode(s));
  return { client, push, close: () => ctrl.close() };
}

const tick = () => new Promise((r) => setTimeout(r, 10));
const payload = { type: 'push', kind: 'popup', payload: { openerId: 'T-1', targetId: 'T-2' } };
const bodyOf = (msg) => JSON.stringify(msg);

test('CRLF 分隔的推播能解析（修正前會逾時）', async () => {
  const h = harness();
  const p = h.client.waitPush((m) => m.kind === 'popup', 2000);
  await tick();

  h.push(`data: ${bodyOf(payload)}\r\n\r\n`);
  const msg = await p;
  assert.equal(msg.payload.targetId, 'T-2');
  h.close();
});

test('只用 CR 當換行的推播也能解析（修正前會逾時）', async () => {
  const h = harness();
  const p = h.client.waitPush((m) => m.kind === 'popup', 2000);
  await tick();

  h.push(`data: ${bodyOf(payload)}\r\r`);
  const msg = await p;
  assert.equal(msg.payload.targetId, 'T-2');
  h.close();
});

test('分隔字串被切成兩個 chunk（"\\r\\n\\r" + "\\n"）仍能解析，不會提前命中', async () => {
  const h = harness();
  const p = h.client.waitPush((m) => m.kind === 'popup', 2000);
  await tick();

  h.push(`data: ${bodyOf(payload)}\r\n\r`);
  await tick();
  h.push('\n');

  const msg = await p;
  assert.equal(msg.payload.targetId, 'T-2');
  h.close();
});

test('JSON 內容被切成多個 chunk 時仍能組回（CRLF 分隔）', async () => {
  const h = harness();
  const p = h.client.waitPush((m) => m.kind === 'popup', 2000);
  await tick();

  h.push('data: {"type":"push","kind":"popup",');
  await tick();
  h.push('"payload":{"openerId":"T-1","targetId":"T-9"}}\r\n\r\n');

  const msg = await p;
  assert.equal(msg.payload.targetId, 'T-9');
  h.close();
});

test('回歸：LF（"\\n\\n"）分隔仍然正常', async () => {
  const h = harness();
  const p = h.client.waitPush((m) => m.kind === 'popup', 2000);
  await tick();

  h.push(`data: ${bodyOf(payload)}\n\n`);
  const msg = await p;
  assert.equal(msg.payload.targetId, 'T-2');
  h.close();
});

test('回歸：同一 chunk 內連續多個事件，只有符合條件的推播被解析、其餘不影響等待者', async () => {
  const h = harness();
  const p = h.client.waitPush((m) => m.kind === 'download', 2000);
  await tick();

  h.push([
    `data: ${bodyOf({ type: 'push', kind: 'popup', payload: { targetId: 'X-1' } })}`,
    `: keep-alive comment`,
    `data: ${bodyOf({ type: 'push', kind: 'download', targetId: 'T-1', payload: { kind: 'begin', guid: 'g-1' } })}`,
    '',
  ].join('\r\n'));

  const msg = await p;
  assert.equal(msg.payload.guid, 'g-1');
  h.close();
});

test('回歸：換行格式不影響時序——不符條件的等待者仍會逾時（型別不變）', async () => {
  const h = harness();
  await assert.rejects(
    h.client.waitPush((m) => m.kind === 'dialog', 50),
    (e) => e instanceof EgoError && e.name === 'TimeoutError',
  );
  h.push(`data: ${bodyOf(payload)}\r\n\r\n`);
  h.close();
});
