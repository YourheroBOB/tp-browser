// tests/fmb_w13_s10_sdk_ensurepage_race.test.mjs
// lib/sdk.js 的 _ensurePage() 併發初始化回歸測試。
// 全程零網路、零檔案讀寫、零真實憑證：只用假的 rpc 驅動 buildSdk，
// 所有識別值都是明顯假資料（space 名 'default'、label 'p1'、targetId 'T-1'）。
//
// 【回歸，修正前會失敗】多個「需要預設 page」的 SDK 入口被同時呼叫時
// （例如 await Promise.all([pageInfo(), js('1+1'), click('#go')])），
// 舊寫法每個呼叫都看到 _activeTask === null，於是各自跑一次 taskSpace('default')：
// 兩邊 space.list 都查不到同名空間、各自 space.create，ledger 裡多出重複的 'default'
// 空間；_activePage 還會被後完成的那一邊覆蓋，先回來的呼叫拿到的是另一邊建立的頁面物件。
// 修正後：進行中的初始化共用同一個 promise，只建立一次，所有呼叫落在同一個 page；
// 失敗時清掉快取，下一次仍可重試（不得把錯誤永久快取）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSdk, EgoError } from '../lib/sdk.js';

// 以假的 rpc 驅動 buildSdk。
// space.list 預設回空陣列（模擬「同名空間還不存在」），space.create 每次回一個新的 view。
function harness({ listImpl } = {}) {
  const calls = [];
  const created = [];
  let listCount = 0;

  const rpc = async (method, params = {}) => {
    calls.push({ method, params });
    if (method === 'space.list') {
      listCount += 1;
      if (listImpl) return listImpl(listCount);
      return [];
    }
    if (method === 'space.create') {
      const view = {
        id: created.length + 1,
        name: params.name,
        ownership: 'agent',
        state: 'active',
        pages: [{ label: 'p1', targetId: `T-${created.length + 1}` }],
      };
      created.push(view);
      return view;
    }
    if (method === 'page.call') {
      if (params.method === 'info') return { spaceId: params.spaceId, label: params.label, targetId: `T-${params.spaceId}` };
      if (params.method === 'evaluate') return { value: params.args?.[0], spaceId: params.spaceId };
      return { ok: true, method: params.method, spaceId: params.spaceId };
    }
    return { ok: true };
  };

  const sdk = buildSdk({ rpc, waitPush: () => { throw new Error('這個測試不該用到 waitPush'); } });
  const count = (m) => calls.filter((c) => c.method === m).length;
  const pageCalls = () => calls.filter((c) => c.method === 'page.call');
  return { sdk, calls, created, count, pageCalls };
}

test('併發的 pageInfo()/js()/click() 只建立一次預設 space（修正前會建立 2~3 次）', async () => {
  const h = harness();

  const [info, evaled, clicked] = await Promise.all([
    h.sdk.pageInfo(),
    h.sdk.js('1+1'),
    h.sdk.click('#go'),
  ]);

  assert.equal(h.count('space.list'), 1, 'space.list 只該查一次');
  assert.equal(h.count('space.create'), 1, 'space.create 只該建立一次（修正前為 3 次）');
  assert.equal(h.created.length, 1);
  assert.equal(h.created[0].name, 'default');

  // 三個呼叫都必須落在同一個 space（修正前會分別落在 id 1/2/3）。
  assert.equal(info.spaceId, 1);
  assert.equal(evaled.spaceId, 1);
  assert.equal(clicked.spaceId, 1);

  const pc = h.pageCalls();
  assert.equal(pc.length, 3);
  for (const c of pc) {
    assert.equal(c.params.spaceId, 1, '所有 page.call 必須落在同一個 space');
    assert.equal(c.params.label, 'p1');
  }
  assert.deepEqual(pc.map((c) => c.params.method).sort(), ['click', 'evaluate', 'info']);
});

test('初始化成功後重複呼叫沿用同一個 page，不再打 space.list/space.create', async () => {
  const h = harness();

  const a = await h.sdk.pageInfo();
  const b = await h.sdk.pageInfo();
  const c = await h.sdk.js('x');

  assert.equal(h.count('space.list'), 1);
  assert.equal(h.count('space.create'), 1);
  assert.equal(h.pageCalls().length, 3);
  assert.equal(a.spaceId, b.spaceId);
  assert.equal(c.spaceId, a.spaceId);
});

test('初始化失敗後不得把錯誤永久快取：下一次呼叫會重新嘗試', async () => {
  let first = true;
  const h = harness({
    listImpl: () => {
      if (first) {
        first = false;
        throw new EgoError('DaemonUnavailable', 'connect ECONNREFUSED 127.0.0.1:9772');
      }
      return [];
    },
  });

  await assert.rejects(
    h.sdk.pageInfo(),
    (e) => e instanceof EgoError && e.name === 'DaemonUnavailable',
  );
  assert.equal(h.count('space.create'), 0, '第一次失敗時不該建立 space');

  const info = await h.sdk.pageInfo();
  assert.equal(h.count('space.list'), 2, '失敗後必須重新查詢，而不是沿用同一個被拒絕的 promise');
  assert.equal(h.count('space.create'), 1);
  assert.equal(info.spaceId, 1);
});

test('space.create 失敗後同樣可重試（錯誤不被快取）', async () => {
  let firstCreate = true;
  const calls = [];
  const rpc = async (method, params = {}) => {
    calls.push({ method, params });
    if (method === 'space.list') return [];
    if (method === 'space.create') {
      if (firstCreate) {
        firstCreate = false;
        throw new EgoError('LedgerError', 'persist failed');
      }
      return { id: 1, name: params.name, ownership: 'agent', state: 'active', pages: [{ label: 'p1', targetId: 'T-1' }] };
    }
    if (method === 'page.call' && params.method === 'info') return { spaceId: params.spaceId, label: params.label };
    return { ok: true };
  };
  const sdk = buildSdk({ rpc, waitPush: () => { throw new Error('這個測試不該用到 waitPush'); } });

  await assert.rejects(sdk.pageInfo(), (e) => e instanceof EgoError && e.name === 'LedgerError');
  const info = await sdk.pageInfo();
  assert.equal(info.spaceId, 1);
  assert.equal(calls.filter((c) => c.method === 'space.create').length, 2);
});

test('使用者先建立具名 space 後，pageInfo() 沿用它的 p1 且不額外建立 default', async () => {
  const h = harness();

  const ts = await h.sdk.taskSpace('other');
  const info = await h.sdk.pageInfo();

  assert.equal(ts.name, 'other');
  assert.equal(info.spaceId, ts.id);
  assert.equal(h.count('space.list'), 1);
  assert.equal(h.count('space.create'), 1, '只該有建立 other 的那一次');
  assert.equal(h.created[0].name, 'other');
});
