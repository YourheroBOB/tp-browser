// tests/fmb_w10_s10_sdk_rpc_protocol.test.mjs
// lib/sdk.js createClient().rpc() 的錯誤契約回歸測試（零網路、零檔案讀寫、零真實憑證）。
//
// 【回歸，修正前會失敗】rpc() 只處理 403 與 {ok:false}，其餘一律直接 res.json()：
//   - daemon 前的反向代理／通道回 HTML 錯誤頁（例如 502）→ res.json() 丟 SyntaxError；
//   - daemon 回一半崩潰、body 被截斷 → 同樣是 SyntaxError；
//   - body 是 JSON 的 null（body 就一個 `null`）→ 讀 j.ok 丟
//     TypeError: Cannot read properties of null (reading 'ok')；
//   - body 是 JSON 字串 → j.ok 是 undefined，錯誤被誤報成 'rpc failed'。
// 這些都繞過 SDK 文件承諾的 EgoError 契約（name/message 可分支），呼叫端完全無法辨識。
// 修正後：解析失敗或非物件信封一律轉成 EgoError('ProtocolError')，訊息只帶 HTTP 狀態碼，
// 不回傳 body（避免錯誤頁把敏感內容帶進日誌）；403 仍在解析之前就以 AuthError 結束。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, EgoError } from '../lib/sdk.js';

const TOKEN = 'FAKE_VALUE_FOR_TEST';

// 以假的 fetchImpl 建立 client：不連線、不開串流、不讀寫任何檔案。
function clientWith(handler) {
  return createClient({ port: 9772, token: TOKEN, fetchImpl: async (url, init) => handler(url, init) });
}

const isProtocolError = (status) => (e) => e instanceof EgoError
  && e.name === 'ProtocolError'
  && e.message.includes(`HTTP ${status}`);

test('rpc：非 JSON 的錯誤頁（HTTP 502）轉成 EgoError(ProtocolError)，不洩漏 SyntaxError 與 body 內容', async () => {
  const client = clientWith(() => ({
    status: 502,
    ok: false,
    json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0'); },
  }));

  await assert.rejects(client.rpc('space.list'), (e) => {
    assert.ok(e instanceof EgoError, `應為 EgoError，實際 ${e?.constructor?.name}`);
    assert.equal(e.name, 'ProtocolError');
    assert.match(e.message, /HTTP 502/);
    assert.equal(e instanceof SyntaxError, false);
    // 錯誤訊息不得夾帶 body／解析器原文（可能是代理或 daemon 的內部資訊）。
    assert.doesNotMatch(e.message, /Unexpected token|position 0/);
    return true;
  });
});

test('rpc：body 被截斷（HTTP 200 但 JSON 解析失敗）也轉成 ProtocolError', async () => {
  const client = clientWith(() => ({
    status: 200,
    ok: true,
    json: async () => { throw new SyntaxError('Unexpected end of JSON input'); },
  }));

  await assert.rejects(client.rpc('space.tabs'), isProtocolError(200));
});

test('rpc：body 是 JSON 的 null 時轉成 ProtocolError（修正前是 TypeError: Cannot read properties of null）', async () => {
  const client = clientWith(() => ({ status: 200, ok: true, json: async () => null }));

  await assert.rejects(client.rpc('space.list'), (e) => {
    assert.ok(e instanceof EgoError, `應為 EgoError，實際 ${e?.constructor?.name}`);
    assert.equal(e.name, 'ProtocolError');
    assert.match(e.message, /HTTP 200/);
    assert.equal(e instanceof TypeError, false);
    return true;
  });
});

test('rpc：body 是 JSON 字串／數字等非物件信封時轉成 ProtocolError，而非誤報 rpc failed', async () => {
  for (const body of ['not-a-rpc-envelope', 42, true]) {
    const client = clientWith(() => ({ status: 200, ok: true, json: async () => body }));
    await assert.rejects(
      client.rpc('space.list'),
      (e) => e instanceof EgoError && e.name === 'ProtocolError' && /HTTP 200/.test(e.message),
      `body=${JSON.stringify(body)}`,
    );
  }
});

test('rpc：403 仍優先以 AuthError 失敗，即使 body 不是 JSON（且不應嘗試解析）', async () => {
  let jsonCalls = 0;
  const client = clientWith(() => ({
    status: 403,
    ok: false,
    json: async () => { jsonCalls += 1; throw new SyntaxError('nope'); },
  }));

  await assert.rejects(
    client.rpc('space.list'),
    (e) => e instanceof EgoError && e.name === 'AuthError' && /rejected the token/.test(e.message),
  );
  assert.equal(jsonCalls, 0, '403 應在解析 body 之前就結束');
});

test('rpc：正常回應與 daemon 錯誤信封的行為不變（回歸保護）', async () => {
  const okClient = clientWith(() => ({
    status: 200,
    ok: true,
    json: async () => ({ ok: true, result: { spaces: [] } }),
  }));
  assert.deepEqual(await okClient.rpc('space.list'), { spaces: [] });

  const errClient = clientWith(() => ({
    status: 200,
    ok: true,
    json: async () => ({ ok: false, error: { name: 'NoSuchSpace', message: 'space 9 not found' } }),
  }));
  await assert.rejects(
    errClient.rpc('space.use', { idOrName: 9 }),
    (e) => e instanceof EgoError && e.name === 'NoSuchSpace' && e.message === 'space 9 not found',
  );

  // 缺 error 欄位時仍沿用既有預設（不得被 ProtocolError 蓋掉）。
  const bareClient = clientWith(() => ({ status: 200, ok: true, json: async () => ({ ok: false }) }));
  await assert.rejects(
    bareClient.rpc('space.list'),
    (e) => e instanceof EgoError && e.name === 'Error' && e.message === 'rpc failed',
  );
});
