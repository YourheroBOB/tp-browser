// tests/fmb_w2_s04_sdk_numeric_name_http.test.mjs
// lib/sdk.js 兩個回歸點：
//  1. taskSpace('2024') 這種「純數字名稱」：先用 id 試 space.use，遇 UnknownSpace 後
//     必須回到「依名稱查找 → 找不到才 create」，而真正的數字 id 仍只走 space.use。
//  2. createClient().rpc 遇到非 2xx 且本文不是 JSON（404 'not found'、400 'forbidden
//     host/origin'）時，必須丟 EgoError('HttpError')，不得冒出 res.json() 的 SyntaxError。
// 全程使用假 rpc 與假 fetchImpl：不連線網路、不讀寫檔案、不使用真實憑證。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSdk, createClient, EgoError } from '../lib/sdk.js';

const TOKEN = 'FAKE_VALUE_FOR_TEST';

const makeView = (id, name, pages = []) => ({ id, name, ownership: 'agent', state: 'active', pages });
const unknownSpace = () => new EgoError('UnknownSpace', 'unknown space');
const noPush = async () => { throw new Error('waitPush 不應被呼叫'); };

// 假 rpc：記錄呼叫順序與參數，回應由 handler 決定。
function fakeRpc(handler) {
  const calls = [];
  const rpc = async (method, params) => {
    calls.push({ method, params });
    return handler(method, params, calls);
  };
  return { rpc, calls };
}

const methods = (calls) => calls.map((c) => c.method);

test('taskSpace("2024")：id 查詢 UnknownSpace 後改用名稱查找，不直接失敗', async () => {
  const { rpc, calls } = fakeRpc((method, params) => {
    if (method === 'space.use') {
      if (params.idOrName === 2024) throw unknownSpace();
      if (params.idOrName === 7) return makeView(7, '2024');
      throw unknownSpace();
    }
    if (method === 'space.list') return [{ id: 7, name: '2024' }];
    throw new Error(`unexpected method ${method}`);
  });
  const sdk = buildSdk({ rpc, waitPush: noPush });

  const ts = await sdk.taskSpace('2024');
  assert.equal(ts.spaceId, 7);
  assert.equal(ts.name, '2024');
  assert.deepEqual(methods(calls), ['space.use', 'space.list', 'space.use']);
  assert.deepEqual(calls[0].params, { idOrName: 2024 });
  assert.deepEqual(calls[2].params, { idOrName: 7 });
});

test('taskSpace("2024")：名稱不存在時以 space.create({name:"2024"}) 建立', async () => {
  const { rpc, calls } = fakeRpc((method, params) => {
    if (method === 'space.use') throw unknownSpace();
    if (method === 'space.list') return [{ id: 1, name: 'default' }];
    if (method === 'space.create') return makeView(12, params.name);
    throw new Error(`unexpected method ${method}`);
  });
  const sdk = buildSdk({ rpc, waitPush: noPush });

  const ts = await sdk.taskSpace('2024');
  assert.equal(ts.spaceId, 12);
  assert.equal(ts.name, '2024');
  assert.deepEqual(methods(calls), ['space.use', 'space.list', 'space.create']);
  assert.deepEqual(calls[2].params, { name: '2024' });
});

test('純數字名稱：數字型別與字串型別都會先試 id，再 fallback 到名稱', async () => {
  for (const arg of [2024, '2024']) {
    const { rpc, calls } = fakeRpc((method, params) => {
      if (method === 'space.use' && params.idOrName === 2024) throw unknownSpace();
      if (method === 'space.list') return [];
      if (method === 'space.create') return makeView(30, params.name);
      throw new Error(`unexpected method ${method}`);
    });
    const sdk = buildSdk({ rpc, waitPush: noPush });
    const ts = await sdk.taskSpace(arg);
    assert.equal(ts.spaceId, 30, `arg=${arg}`);
    assert.deepEqual(methods(calls), ['space.use', 'space.list', 'space.create'], `arg=${arg}`);
  }
});

test('名稱命中但 id 查詢失敗（清單過期）時退回建立同名空間', async () => {
  const { rpc, calls } = fakeRpc((method, params) => {
    if (method === 'space.use') throw unknownSpace();
    if (method === 'space.list') return [{ id: 99, name: '2024' }];
    if (method === 'space.create') return makeView(40, params.name);
    throw new Error(`unexpected method ${method}`);
  });
  const sdk = buildSdk({ rpc, waitPush: noPush });

  const ts = await sdk.taskSpace('2024');
  assert.equal(ts.spaceId, 40);
  assert.deepEqual(methods(calls), ['space.use', 'space.list', 'space.use', 'space.create']);
  assert.deepEqual(calls[3].params, { name: '2024' });
});

test('真正的數字 id 仍只走 space.use，不查 list、不建立', async () => {
  const { rpc, calls } = fakeRpc((method, params) => {
    if (method === 'space.use') return makeView(params.idOrName, 'whatever');
    throw new Error(`unexpected method ${method}`);
  });
  const sdk = buildSdk({ rpc, waitPush: noPush });

  const byNumber = await sdk.taskSpace(3);
  const byNumericString = await sdk.taskSpace('3');
  assert.equal(byNumber.spaceId, 3);
  assert.equal(byNumericString.spaceId, 3);
  assert.deepEqual(calls.map((c) => c.params), [{ idOrName: 3 }, { idOrName: 3 }]);
  assert.deepEqual(methods(calls), ['space.use', 'space.use']);
});

test('非數字名稱維持原行為：先 list 再 use', async () => {
  const { rpc, calls } = fakeRpc((method, params) => {
    if (method === 'space.list') return [{ id: 5, name: 'research-flow' }];
    if (method === 'space.use') return makeView(params.idOrName, 'research-flow');
    throw new Error(`unexpected method ${method}`);
  });
  const sdk = buildSdk({ rpc, waitPush: noPush });

  const ts = await sdk.taskSpace('research-flow');
  assert.equal(ts.spaceId, 5);
  assert.deepEqual(methods(calls), ['space.list', 'space.use']);
});

test('space.use 的非 UnknownSpace 錯誤（如 AuthError）會原樣往上丟，不會誤建空間', async () => {
  const { rpc, calls } = fakeRpc((method) => {
    if (method === 'space.use') throw new EgoError('AuthError', 'daemon rejected the token');
    throw new Error(`unexpected method ${method}`);
  });
  const sdk = buildSdk({ rpc, waitPush: noPush });

  await assert.rejects(
    sdk.taskSpace('2024'),
    (e) => e instanceof EgoError && e.name === 'AuthError',
  );
  assert.deepEqual(methods(calls), ['space.use']);
});

// --- rpc 對非 JSON 回應的處理 -------------------------------------------------

const textResponse = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  async text() { return body; },
  // 若 rpc 還在用 res.json()，這裡就會丟 SyntaxError —— 用來證明修正有效。
  async json() { throw new SyntaxError('Unexpected token in JSON'); },
});

const jsonResponse = (status, obj) => ({
  status,
  ok: status >= 200 && status < 300,
  async text() { return JSON.stringify(obj); },
  async json() { return obj; },
});

test('rpc：404 純文字 "not found" 丟 EgoError("HttpError")，帶狀態碼與本文', async () => {
  const seen = [];
  const client = createClient({
    port: 9772,
    token: TOKEN,
    fetchImpl: async (url, init) => { seen.push({ url, init }); return textResponse(404, 'not found'); },
  });

  await assert.rejects(client.rpc('space.list'), (e) => {
    assert.ok(e instanceof EgoError, `應為 EgoError，實際 ${e?.constructor?.name}`);
    assert.ok(!(e instanceof SyntaxError), '不得是 SyntaxError');
    assert.equal(e.name, 'HttpError');
    assert.match(e.message, /404/);
    assert.match(e.message, /not found/);
    return true;
  });
  assert.equal(seen.length, 1);
  assert.match(seen[0].url, /\/rpc$/);
  assert.equal(seen[0].init.headers['x-ego-token'], TOKEN);
  assert.deepEqual(JSON.parse(seen[0].init.body).method, 'space.list');
});

test('rpc：400 純文字 "forbidden host/origin" 丟 EgoError("HttpError")', async () => {
  const client = createClient({ port: 9774, token: TOKEN, fetchImpl: async () => textResponse(400, 'forbidden host/origin') });

  await assert.rejects(client.rpc('space.use', { idOrName: 1 }), (e) => {
    assert.ok(e instanceof EgoError && !(e instanceof SyntaxError));
    assert.equal(e.name, 'HttpError');
    assert.match(e.message, /400/);
    assert.match(e.message, /forbidden host\/origin/);
    return true;
  });
});

test('rpc：HttpError 只帶本文前 200 字', async () => {
  const body = 'A'.repeat(500);
  const client = createClient({ port: 9772, token: TOKEN, fetchImpl: async () => textResponse(502, body) });

  await assert.rejects(client.rpc('space.list'), (e) => {
    assert.equal(e.name, 'HttpError');
    assert.ok(e.message.endsWith('A'.repeat(200)), '應以 200 字片段結尾');
    assert.ok(!e.message.endsWith('A'.repeat(201)), '不得超過 200 字');
    return true;
  });
});

test('rpc：2xx 但本文不是 JSON 時也是 EgoError("HttpError")，不是 SyntaxError', async () => {
  const client = createClient({ port: 9772, token: TOKEN, fetchImpl: async () => textResponse(200, '<html>proxy</html>') });

  await assert.rejects(client.rpc('space.list'), (e) => {
    assert.ok(e instanceof EgoError && !(e instanceof SyntaxError));
    assert.equal(e.name, 'HttpError');
    assert.match(e.message, /200/);
    assert.match(e.message, /proxy/);
    return true;
  });
});

test('rpc：非 2xx 但本文是 JSON 時仍採用 daemon 的錯誤名稱（回歸）', async () => {
  const client = createClient({
    port: 9772,
    token: TOKEN,
    fetchImpl: async () => jsonResponse(500, { ok: false, error: { name: 'UnknownSpace', message: 'unknown space' } }),
  });

  await assert.rejects(
    client.rpc('space.use', { idOrName: 99 }),
    (e) => e instanceof EgoError && e.name === 'UnknownSpace' && /unknown space/.test(e.message),
  );
});

test('rpc：成功回應回傳 result（回歸）', async () => {
  const client = createClient({
    port: 9772,
    token: TOKEN,
    fetchImpl: async () => jsonResponse(200, { ok: true, result: { id: 5, name: '2024' } }),
  });
  assert.deepEqual(await client.rpc('space.use', { idOrName: 5 }), { id: 5, name: '2024' });
});

test('rpc：403 仍優先以 AuthError 表示（回歸）', async () => {
  const client = createClient({ port: 9772, token: TOKEN, fetchImpl: async () => textResponse(403, 'forbidden') });
  await assert.rejects(client.rpc('space.list'), (e) => e instanceof EgoError && e.name === 'AuthError');
});

test('rpc：只提供 res.json() 的舊式假 fetch 仍可運作（回歸）', async () => {
  const client = createClient({
    port: 9772,
    token: TOKEN,
    fetchImpl: async () => ({ status: 200, ok: true, async json() { return { ok: true, result: { id: 5 } }; } }),
  });
  assert.deepEqual(await client.rpc('task.cdp', {}), { id: 5 });
});
