// tests/fmb_w4_s10_sdk_finish_keep_rpc.test.mjs
// lib/sdk.js 的一組回歸／覆蓋測試（零網路、零檔案讀寫、零真實憑證）：
//
//  1.【回歸，會先失敗】completeTaskSpace() 的 keep 正規化。
//     修改前：`completeTaskSpace(space, { keep: 'all' })` 只判斷 true 與 Array.isArray，
//     daemon 原生的 'all'（與單一 label 字串）被靜默轉成 []，於是呼叫端要求「保留所有分頁」，
//     送出的卻是「全部關掉」——與意圖完全相反，而且沒有任何錯誤訊息。
//     同一份輸入在 TaskSpace.finish() 卻能正確送出，兩條路徑語意不一致。
//
//  2.【覆蓋】createClient().rpc() 的請求組裝與錯誤轉換（repo 內原本沒有任何測試覆蓋）：
//     POST /rpc、x-ego-token 標頭、id 遞增、params 省略時送 {}、埠號對應、
//     403 → AuthError、{ok:false} → 帶 daemon name/message 的 EgoError、缺 error 欄位時的預設名稱。
//
// 不使用 fetch、不連線任何服務；需要 token 一律用明顯假值。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSdk, createClient, EgoError } from '../lib/sdk.js';

const TOKEN = 'FAKE_VALUE_FOR_TEST';

// 以假的 rpc 驅動 buildSdk：只記錄呼叫，不連線、不開串流。
function makeSdk() {
  const calls = [];
  const pages = [{ label: 'p1', targetId: 'T1' }];
  const rpc = async (method, params = {}) => {
    calls.push({ method, params });
    if (method === 'space.use') return { id: 7, name: 'w4-s10', ownership: 'agent', state: 'active', pages };
    return {};
  };
  const waitPush = () => { throw new Error('這個測試不該用到 waitPush'); };
  const sdk = buildSdk({ rpc, waitPush });
  const space = new sdk.TaskSpace({ id: 7, name: 'w4-s10', ownership: 'agent', state: 'active', pages });
  return { sdk, space, calls };
}

const finishes = (calls) => calls.filter((c) => c.method === 'space.finish');
const lastFinish = (calls) => finishes(calls).at(-1);

test('completeTaskSpace 收到 keep:"all" 必須原樣送出（修改前會變成 []，反而關掉所有分頁）', async () => {
  const { sdk, space, calls } = makeSdk();

  await sdk.completeTaskSpace(space, { keep: 'all' });

  assert.equal(finishes(calls).length, 1);
  assert.deepEqual(lastFinish(calls).params, { id: 7, keep: 'all' });
});

test('completeTaskSpace 的 keep 若是單一 label 字串也要原樣送出，不可退化成空陣列', async () => {
  const { sdk, calls } = makeSdk();

  await sdk.completeTaskSpace(7, { keep: 'p1' });

  assert.deepEqual(lastFinish(calls).params, { id: 7, keep: 'p1' });
});

test('completeTaskSpace：true → "all"、陣列原樣、未指定 → []，id 可由物件或數字取得', async () => {
  const { sdk, space, calls } = makeSdk();

  await sdk.completeTaskSpace({ spaceId: 12 }, { keep: true });
  await sdk.completeTaskSpace({ id: 13 }, { keep: ['p1', 'p2'] });
  await sdk.completeTaskSpace(14);
  await sdk.completeTaskSpace(space);

  const byId = (id) => finishes(calls).find((c) => c.params.id === id).params;
  assert.deepEqual(byId(12), { id: 12, keep: 'all' });
  assert.deepEqual(byId(13), { id: 13, keep: ['p1', 'p2'] });
  assert.deepEqual(byId(14), { id: 14, keep: [] });
  assert.deepEqual(lastFinish(calls).params, { id: 7, keep: [] });
});

test('TaskSpace.finish 與 completeTaskSpace 對同一組 keep 輸入給出一致的結果', async () => {
  const { sdk, space, calls } = makeSdk();

  const inputs = [{ keep: true }, { keep: 'all' }, { keep: ['p1'] }, undefined];
  for (const opts of inputs) await space.finish(opts);
  const fromFinish = finishes(calls).map((c) => c.params.keep);

  for (const opts of inputs) await sdk.completeTaskSpace(space, opts);
  const fromComplete = finishes(calls).map((c) => c.params.keep).slice(inputs.length);

  assert.deepEqual(fromFinish, ['all', 'all', ['p1'], []]);
  assert.deepEqual(fromComplete, fromFinish);
});

// ---- createClient().rpc() -------------------------------------------------

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return handler(calls.length);
  };
  return { calls, fetchImpl };
}

const resJson = (body, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test('rpc：POST /rpc、帶 x-ego-token、id 遞增、params 省略時送 {}', async () => {
  const { calls, fetchImpl } = fakeFetch(() => resJson({ ok: true, result: { spaces: [] } }));
  const client = createClient({ port: 9772, token: TOKEN, fetchImpl });

  assert.deepEqual(await client.rpc('space.list'), { spaces: [] });
  await client.rpc('page.call', { label: 'p1' });
  await client.rpc('space.tabs');

  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'http://127.0.0.1:9772/rpc');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.equal(calls[0].init.headers['x-ego-token'], TOKEN);

  const bodies = calls.map((c) => JSON.parse(c.init.body));
  assert.deepEqual(bodies.map((b) => b.id), [1, 2, 3]);
  assert.deepEqual(bodies[0], { id: 1, method: 'space.list', params: {} });
  assert.deepEqual(bodies[1], { id: 2, method: 'page.call', params: { label: 'p1' } });
  assert.deepEqual(bodies[2].params, {});
});

test('rpc：埠號 9774 走 alt 埠，其他值走預設 9772', async () => {
  for (const [port, expected] of [[9774, 'http://127.0.0.1:9774/rpc'], [9772, 'http://127.0.0.1:9772/rpc']]) {
    const { calls, fetchImpl } = fakeFetch(() => resJson({ ok: true, result: null }));
    await createClient({ port, token: TOKEN, fetchImpl }).rpc('space.list');
    assert.equal(calls[0].url, expected);
  }
});

test('rpc：403 → AuthError；{ok:false} → EgoError(daemon name/message)；缺 error 欄位用預設名稱', async () => {
  const forbidden = createClient({
    port: 9772,
    token: TOKEN,
    fetchImpl: async () => resJson({ ok: false }, 403),
  });
  await assert.rejects(
    forbidden.rpc('space.list'),
    (e) => e instanceof EgoError && e.name === 'AuthError' && /rejected the token/.test(e.message),
  );

  const named = createClient({
    port: 9772,
    token: TOKEN,
    fetchImpl: async () => resJson({ ok: false, error: { name: 'NoSuchSpace', message: 'space 9 not found' } }),
  });
  await assert.rejects(
    named.rpc('space.use', { idOrName: 9 }),
    (e) => e instanceof EgoError && e.name === 'NoSuchSpace' && e.message === 'space 9 not found',
  );

  const bare = createClient({
    port: 9772,
    token: TOKEN,
    fetchImpl: async () => resJson({ ok: false }),
  });
  await assert.rejects(
    bare.rpc('space.list'),
    (e) => e instanceof EgoError && e.name === 'Error' && e.message === 'rpc failed',
  );
});
