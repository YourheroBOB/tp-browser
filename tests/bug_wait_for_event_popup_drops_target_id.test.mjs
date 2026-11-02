// Page#waitForEvent('popup') 在 page.adopt 成功後必須保留 targetId。
// 修正前：改走 TaskSpace.page(label)，回傳頁的 targetId 是 null。
// space.use 若尚未列出新分頁，_refresh 不會補上，接著 waitForEvent('download')
// 拿 null 比對推播，下載事件對不上。
// 零網路、零檔案、零真實憑證；只用假的 rpc / waitPush。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSdk } from '../lib/sdk.js';

test('waitForEvent(popup) 回傳的 Page 保留 adopt 的 targetId，後續 download 才對得上', async () => {
  const calls = [];
  const queue = [
    { type: 'push', kind: 'popup', payload: { openerId: 'T1', targetId: 'T-popup' } },
    { type: 'push', kind: 'download', targetId: 'T-popup', payload: { kind: 'begin', guid: 'g-9' } },
  ];
  const rpc = async (method, params = {}) => {
    calls.push({ method, params });
    if (method === 'space.use') {
      // 開窗者 p1 在清單裡；新 popup p2 尚未出現（adopt 回應比 ledger 快）。
      return {
        id: 7,
        name: 'popup-space',
        ownership: 'agent',
        state: 'active',
        pages: [{ label: 'p1', targetId: 'T1' }],
      };
    }
    if (method === 'page.adopt') return { label: 'p2', targetId: 'T-popup' };
    return {};
  };
  const waitPush = (match) => {
    const idx = queue.findIndex((m) => match(m));
    if (idx === -1) return Promise.reject(new Error('no matching push'));
    return Promise.resolve(queue.splice(idx, 1)[0]);
  };
  const sdk = buildSdk({ rpc, waitPush });
  const space = new sdk.TaskSpace({
    id: 7,
    name: 'popup-space',
    ownership: 'agent',
    state: 'active',
    pages: [{ label: 'p1', targetId: 'T1' }],
  });

  const popup = await space.page('p1').waitForEvent('popup', { timeout: 1000 });

  assert.equal(popup.label, 'p2');
  assert.equal(popup.targetId, 'T-popup');
  const adopt = calls.find((c) => c.method === 'page.adopt');
  assert.deepEqual(adopt.params, { spaceId: 7, targetId: 'T-popup' });

  const dl = await popup.waitForEvent('download', { timeout: 1000 });
  assert.ok(dl instanceof sdk.Download);
  assert.equal(dl.guid, 'g-9');
});
