// tests/fmb_w3_s04_sdk_chooser_keep_hidden.test.mjs
// lib/sdk.js 三個回歸測試，全部以「假的 rpc + 假的 waitPush」傳入 buildSdk：
//  1. page.waitForFileChooser() 必須先 _refresh() 取得 targetId，matcher 才可能命中推播
//     （以 ts.page('p1') 建立的 Page 初始 _targetId 是 null，會永遠等不到）。
//  2. TaskSpace.finish({ keep: true }) 送出的 rpc 參數必須是 keep:'all'
//     （daemon 只認得陣列與 'all'，true 會被當成 [] 而關掉整個 space 的分頁）。
//  3. waitForSelector 的 state:'hidden' 在元素存在但 visible:false 時必須立即成立；
//     detached 仍然只認 count === 0。
// 全程零網路、零檔案讀寫、零真實憑證。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSdk, EgoError } from '../lib/sdk.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

// 建一個以假 rpc / 假 waitPush 驅動的 TaskSpace；waitPush 只登記等待者，由測試自行餵推播。
function harness({
  pages = [{ label: 'p1', targetId: 'T1' }],
  probe = () => ({ count: 0, visible: false }),
} = {}) {
  const calls = [];
  const waiters = [];

  const rpc = async (method, params = {}) => {
    calls.push({ method, params });
    if (method === 'space.use') {
      return { id: 7, name: 'demo-space', ownership: 'agent', state: 'active', pages };
    }
    if (method === 'space.finish') return { ok: true };
    if (method === 'page.call') {
      if (params.method === 'waitForSelectorProbe') return probe(params.args?.[0], params.args?.[1]);
      return { ok: true, method: params.method };
    }
    return {};
  };

  const waitPush = (match, timeout, message) => new Promise((resolve, reject) => {
    waiters.push({ match, timeout, message, resolve, reject });
  });

  const sdk = buildSdk({ rpc, waitPush });
  const space = new sdk.TaskSpace({ id: 7, name: 'demo-space', ownership: 'agent', state: 'active', pages });
  return { sdk, space, calls, waiters };
}

test('waitForFileChooser 先 _refresh 取得 targetId，matcher 能命中 T1 的 fileChooser 推播', async () => {
  const { sdk, space, calls, waiters } = harness();
  const page = space.page('p1');

  // 重現條件：以 space.page('p1') 建立的 Page 沒有 targetId。
  assert.equal(page.targetId, null);
  assert.equal(page._targetId, null);

  const pending = page.waitForFileChooser({ timeout: 5000 });
  await flush();

  // _refresh() 必須先跑過，且攔截器要被開啟。
  assert.equal(page.targetId, 'T1', 'waitForFileChooser 必須先 _refresh() 取得 targetId');
  assert.ok(calls.some((c) => c.method === 'space.use' && c.params.idOrName === 7), '應先以 space.use 刷新頁面資訊');
  assert.ok(
    calls.some((c) => c.method === 'page.call' && c.params.method === 'enableChooserIntercept' && c.params.args[0] === true),
    '應開啟 fileChooser 攔截',
  );

  assert.equal(waiters.length, 1, '應註冊一個 waitPush 等待者');
  const [w] = waiters;
  const hit = { type: 'push', kind: 'fileChooser', targetId: 'T1', payload: { backendNodeId: 42, mode: 'selectSingle' } };

  assert.equal(w.match(hit), true, 'matcher 必須命中 targetId T1');
  assert.equal(w.match({ ...hit, targetId: 'T2' }), false, '不應命中其他 targetId');
  assert.equal(w.match({ ...hit, kind: 'popup' }), false, '不應命中其他 kind');
  assert.equal(w.match({ ...hit, type: 'event' }), false, '不應命中非 push 訊息');

  // 餵入推播後應解析成 FileChooser，且不應再送出關閉攔截的呼叫。
  w.resolve(hit);
  const chooser = await pending;
  assert.ok(chooser instanceof sdk.FileChooser);
  assert.equal(chooser.isMultiple(), false);
  assert.equal(chooser._backendNodeId, 42);
  assert.equal(
    calls.some((c) => c.method === 'page.call' && c.params.method === 'enableChooserIntercept' && c.params.args[0] === false),
    false,
    '成功路徑不應關閉攔截器',
  );
});

test('TaskSpace.finish({ keep: true }) 送出的 rpc 參數是 keep:"all"', async () => {
  const { space, calls } = harness();

  await space.finish({ keep: true });
  const call = calls.find((c) => c.method === 'space.finish');
  assert.ok(call, 'finish 必須呼叫 space.finish');
  assert.deepEqual(call.params, { id: 7, keep: 'all' });

  // 明確陣列與預設值仍照原樣傳遞（不可被放寬成 'all'）。
  await space.finish({ keep: ['p1'] });
  await space.finish();
  const finishes = calls.filter((c) => c.method === 'space.finish');
  assert.deepEqual(finishes[1].params, { id: 7, keep: ['p1'] });
  assert.deepEqual(finishes[2].params, { id: 7, keep: [] });
});

test('waitForSelector：{count:1,visible:false} 時 hidden 立即成立、detached 不成立', async () => {
  const { space, calls } = harness({ probe: () => ({ count: 1, visible: false }) });
  const page = space.page('p1');

  const probe = await page.waitForSelector('#ghost', { state: 'hidden', timeout: 200 });
  assert.deepEqual(probe, { count: 1, visible: false });
  const probes = calls.filter((c) => c.method === 'page.call' && c.params.method === 'waitForSelectorProbe');
  assert.equal(probes.length, 1, 'hidden 應在第一輪就成立，不該繼續輪詢');
  assert.deepEqual(probes[0].params.args, ['#ghost', { state: 'hidden' }]);

  // detached 仍只看 count === 0：元素存在時必須逾時。
  await assert.rejects(
    page.waitForSelector('#ghost', { state: 'detached', timeout: 50 }),
    (e) => e instanceof EgoError && e.name === 'TimeoutError',
  );
});

test('waitForSelector：元素不存在時 hidden 與 detached 都立即成立', async () => {
  const { space } = harness({ probe: () => ({ count: 0, visible: false }) });
  const page = space.page('p1');

  assert.deepEqual(await page.waitForSelector('#gone', { state: 'hidden', timeout: 200 }), { count: 0, visible: false });
  assert.deepEqual(await page.waitForSelector('#gone', { state: 'detached', timeout: 200 }), { count: 0, visible: false });
  // attached 不應因為 gone 而成立。
  await assert.rejects(
    page.waitForSelector('#gone', { state: 'attached', timeout: 50 }),
    (e) => e instanceof EgoError && e.name === 'TimeoutError',
  );
});
