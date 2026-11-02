// Page#wait(ms) 必須把參數當毫秒：參數名就是 ms，且同檔案的
// waitForTimeout(ms) 也是毫秒語意。舊寫法 `ms <= 60 ? ms * 1000 : ms`
// 在 60/61 處斷裂：wait(60) 等 60 秒，wait(61) 只等 61 毫秒。
// 零網路；只用假的 rpc / waitPush，且不依賴 wall-clock 絕對值，只量級判斷。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSdk } from '../lib/sdk.js';

function makePage() {
  const rpc = async () => { throw new Error('no rpc expected'); };
  const waitPush = () => { throw new Error('no waitPush expected'); };
  const sdk = buildSdk({ rpc, waitPush });
  const space = new sdk.TaskSpace({ id: 1, name: 't', ownership: 'agent', state: 'active', pages: [] });
  return space.page('p1');
}

test('page.wait(1) 只等約 1ms，不會被當成 1 秒', async () => {
  const page = makePage();
  const t0 = Date.now();
  await page.wait(1);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 750, `wait(1) took ${elapsed}ms, expected ms semantics (<750ms)`);
});

test('page.wait 與 waitForTimeout 同輸入耗時一致（皆為毫秒）', async () => {
  const page = makePage();
  const t0 = Date.now();
  await page.wait(1);
  const wWait = Date.now() - t0;
  const t1 = Date.now();
  await page.waitForTimeout(1);
  const wTimeout = Date.now() - t1;
  assert.ok(wWait < 750, `wait(1) took ${wWait}ms`);
  assert.ok(Math.abs(wWait - wTimeout) < 500, `wait(1)=${wWait}ms vs waitForTimeout(1)=${wTimeout}ms`);
});
