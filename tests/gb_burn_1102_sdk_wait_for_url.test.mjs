// lib/sdk.js Page#waitForURL 原本沒有任何測試覆蓋。
// 以假 rpc 驅動 buildSdk：page.call('url') 依序回傳 urls 陣列（用完後停在最後一個），
// 鎖定 string／RegExp／function 三種 matcher、function matcher 拋錯視為不符、以及逾時錯誤格式。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSdk, EgoError } from '../lib/sdk.js';

function harness(urls) {
  const calls = [];
  let i = 0;
  const rpc = async (method, params = {}) => {
    calls.push({ method, params });
    if (method === 'page.call' && params.method === 'url') {
      const u = urls[Math.min(i, urls.length - 1)];
      i++;
      return u;
    }
    return {};
  };
  const sdk = buildSdk({ rpc, waitPush: () => new Promise(() => {}) });
  const pages = [{ label: 'p1', targetId: 'T1' }];
  const space = new sdk.TaskSpace({ id: 7, name: 'demo', ownership: 'agent', state: 'active', pages });
  const urlCalls = () => calls.filter((c) => c.method === 'page.call' && c.params.method === 'url');
  return { page: space.page('p1'), calls, urlCalls };
}

test('waitForURL：string matcher 需完全相等，命中即回傳該 URL', async () => {
  const h = harness(['https://a.test/x?y=1', 'https://a.test/x']);
  assert.equal(await h.page.waitForURL('https://a.test/x', { timeout: 2000 }), 'https://a.test/x');
  assert.equal(h.urlCalls().length, 2, '前綴相符不算命中，須輪詢到完全相等');
  assert.equal(h.urlCalls()[0].params.label, 'p1');
});

test('waitForURL：RegExp matcher 第一次就命中時只呼叫一次 url()', async () => {
  const h = harness(['https://a.test/done']);
  assert.equal(await h.page.waitForURL(/\/done$/, { timeout: 2000 }), 'https://a.test/done');
  assert.equal(h.urlCalls().length, 1);
});

test('waitForURL：function matcher 收到 URL 物件', async () => {
  const h = harness(['https://a.test/start', 'https://b.test/cb?code=1']);
  let seen = null;
  const u = await h.page.waitForURL((url) => { seen = url; return url.hostname === 'b.test'; }, { timeout: 2000 });
  assert.equal(u, 'https://b.test/cb?code=1');
  assert.ok(seen instanceof URL);
  assert.equal(seen.searchParams.get('code'), '1');
});

test('waitForURL：function matcher 拋錯（或 URL 無法解析）視為不符，繼續輪詢', async () => {
  const h = harness(['not a url', 'https://a.test/ok']);
  const u = await h.page.waitForURL((url) => { if (url.pathname !== '/ok') throw new Error('nope'); return true; }, { timeout: 2000 });
  assert.equal(u, 'https://a.test/ok');
});

test('waitForURL：逾時丟 EgoError(TimeoutError)，訊息帶 timeout 與最後一個 URL', async () => {
  const h = harness(['https://a.test/stuck']);
  await assert.rejects(
    h.page.waitForURL('https://never.test/', { timeout: 50 }),
    (e) => e instanceof EgoError && e.name === 'TimeoutError'
      && e.message === 'page.waitForURL timed out after 50ms (last: https://a.test/stuck)',
  );
});
