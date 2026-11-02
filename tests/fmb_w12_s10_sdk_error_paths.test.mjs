// tests/fmb_w12_s10_sdk_error_paths.test.mjs
// lib/sdk.js buildSdk() 的三個錯誤處理／輸入驗證回歸測試。
// 零網路、零檔案讀寫、零真實憑證：全部以假的 rpc／waitPush 驅動，只用明顯假值。
//
//  1.【回歸，修正前會失敗】page._refresh() 假設 space.use 的回應一定有 pages。
//     ledger 形狀不完整（缺 pages；同類缺口見 docs/fmb/ARCHITECTURE.md §3.2）時，
//     waitForFileChooser／waitForEvent 會拋
//     TypeError: Cannot read properties of undefined (reading 'find')，
//     把真正的情況（頁面資訊拿不到）蓋成看起來像 SDK 內部 bug 的例外。
//     同檔其他位置（TaskSpace 建構子、userPage()）都已用 `view.pages || []` 防守。
//
//  2.【回歸，修正前會失敗】page.waitForEvent() 先把不支援的事件名稱做完 _refresh()
//     才丟 NotSupportedError。space 已被回收或 daemon 連不上時，space.use 的錯誤
//     （NoSuchSpace／網路錯誤）會蓋掉「這個事件不支援」——呼叫端最需要知道的東西不見了。
//
//  3.【回歸，修正前會失敗】FileChooser.setFiles() 失敗時沒有關閉 fileChooser 攔截器。
//     該分頁之後真正的檔案選擇對話框會被靜默吞掉（推播送給已不存在的等待者），
//     使用者只看到「點檔案輸入框沒反應」。
//
// 另附 Mouse／Keyboard／Download 的參數對應覆蓋，確保修正沒有動到正常路徑。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSdk, EgoError } from '../lib/sdk.js';

// 以假的 rpc 驅動 buildSdk；pageCall 可選擇性介入單一 page.call 的回應／拋錯。
function harness({ pageCall } = {}) {
  const calls = [];
  const rpc = async (method, params = {}) => {
    calls.push({ method, params });
    if (method === 'page.call') {
      const r = pageCall ? pageCall(params) : undefined;
      if (r !== undefined) return r;
      return { ok: true, method: params.method };
    }
    return { ok: true };
  };
  const sdk = buildSdk({
    rpc,
    waitPush: () => { throw new Error('這個測試不該用到 waitPush'); },
  });
  const space = new sdk.TaskSpace({
    id: 7,
    name: 'w12-s10',
    ownership: 'agent',
    state: 'active',
    pages: [{ label: 'p1', targetId: 'T1' }],
  });
  return { sdk, space, calls };
}

const pageCalls = (calls) => calls.filter((c) => c.method === 'page.call');
const byPageMethod = (calls, name) => pageCalls(calls).filter((c) => c.params.method === name);

// ---- 一、space.use 回應缺 pages --------------------------------------------

test('space.use 回應缺 pages 時 waitForFileChooser 不可拋 TypeError（回歸）', async () => {
  const calls = [];
  const rpc = async (method, params = {}) => {
    calls.push({ method, params });
    if (method === 'space.use') return { id: 7, name: 'no-pages' }; // 形狀不完整的 ledger
    return { ok: true };
  };
  const injected = new EgoError('TimeoutError', 'injected by test');
  const sdk = buildSdk({ rpc, waitPush: () => Promise.reject(injected) });
  const space = new sdk.TaskSpace({ id: 7, name: 'no-pages', ownership: 'agent', state: 'active', pages: [] });
  const page = space.page('p1');
  assert.equal(page.targetId, null);

  // 修正前會是 TypeError（view.pages undefined）；修正後應一路走到 waitPush 才失敗，
  // 而且必須是測試注入的那個錯誤（代表錯誤來源沒有被 SDK 內部的 TypeError 蓋掉）。
  await assert.rejects(page.waitForFileChooser({ timeout: 50 }), (e) => e === injected);
  assert.equal(page.targetId, null, '缺 pages 時不該憑空得到 targetId');

  // _refresh 之後仍應開啟攔截器；等待失敗後既有的 catch 路徑要關回去。
  const intercepts = calls
    .filter((c) => c.method === 'page.call' && c.params.method === 'enableChooserIntercept')
    .map((c) => c.params.args);
  assert.deepEqual(intercepts, [[true], [false]]);
});

test('space.use 回應缺 pages 時 waitForEvent 也不拋 TypeError', async () => {
  const rpc = async (method) => {
    if (method === 'space.use') return { id: 7, name: 'no-pages' };
    return { ok: true };
  };
  const injected = new EgoError('TimeoutError', 'injected by test');
  const sdk = buildSdk({ rpc, waitPush: () => Promise.reject(injected) });
  const space = new sdk.TaskSpace({ id: 7, name: 'no-pages', ownership: 'agent', state: 'active', pages: [] });
  const page = space.page('p1');

  await assert.rejects(page.waitForEvent('popup', { timeout: 50 }), (e) => e === injected);
});

test('_refresh 對 null／缺 pages 的 space.use 回應都安全回傳原 view', async () => {
  for (const view of [null, {}, { id: 7 }, { id: 7, pages: null }]) {
    const sdk = buildSdk({ rpc: async () => view, waitPush: () => { throw new Error('不該用到 waitPush'); } });
    const space = new sdk.TaskSpace({ id: 7, name: 'x', ownership: 'agent', state: 'active', pages: [] });
    const page = space.page('p1');

    assert.equal(await page._refresh(), view);
    assert.equal(page.targetId, null);
  }
});

// ---- 二、waitForEvent 先驗參數再發 RPC --------------------------------------

test('waitForEvent：不支援的事件在發出任何 RPC 之前就以 NotSupportedError 拒絕（回歸）', async () => {
  const calls = [];
  const rpc = async (method) => {
    calls.push({ method });
    if (method === 'space.use') throw new EgoError('NoSuchSpace', 'space 7 not found');
    return {};
  };
  const sdk = buildSdk({ rpc, waitPush: () => { throw new Error('不該用到 waitPush'); } });
  const space = new sdk.TaskSpace({ id: 7, name: 'gone', ownership: 'agent', state: 'active', pages: [] });
  const page = space.page('p1');

  await assert.rejects(
    page.waitForEvent('dialog', { timeout: 50 }),
    (e) => e instanceof EgoError && e.name === 'NotSupportedError' && /dialog/.test(e.message),
  );
  assert.deepEqual(calls, [], '參數錯誤不該先打 space.use');
});

// ---- 三、FileChooser.setFiles 的攔截器生命週期 ------------------------------

test('FileChooser.setFiles 失敗時仍會關閉攔截器，且原始錯誤往外傳（回歸）', async () => {
  const { sdk, space, calls } = harness({
    pageCall: (params) => {
      if (params.method === 'chooserSetFiles') throw new EgoError('CDPError', 'setInputFiles failed');
      return undefined;
    },
  });
  const chooser = new sdk.FileChooser(space, 'p1', 42, 'selectMultiple');
  assert.equal(chooser.isMultiple(), true);

  await assert.rejects(
    chooser.setFiles('uploads/report.txt'),
    (e) => e instanceof EgoError && e.name === 'CDPError' && /setInputFiles failed/.test(e.message),
  );

  const setCall = byPageMethod(calls, 'chooserSetFiles');
  assert.equal(setCall.length, 1);
  assert.deepEqual(setCall[0].params.args, [42, ['uploads/report.txt']], '單一字串要包成陣列');

  const disables = byPageMethod(calls, 'enableChooserIntercept');
  assert.equal(disables.length, 1, '失敗路徑必須關閉攔截器');
  assert.deepEqual(disables[0].params.args, [false]);
});

test('FileChooser.setFiles：關閉攔截器失敗不可覆蓋原始的 setFiles 錯誤', async () => {
  const { sdk, space } = harness({
    pageCall: (params) => {
      if (params.method === 'chooserSetFiles') throw new EgoError('CDPError', 'setInputFiles failed');
      if (params.method === 'enableChooserIntercept') throw new EgoError('CDPError', 'disable failed');
      return undefined;
    },
  });
  const chooser = new sdk.FileChooser(space, 'p1', 42, 'selectSingle');

  await assert.rejects(
    chooser.setFiles(['uploads/a.txt', 'uploads/b.txt']),
    (e) => e instanceof EgoError && e.name === 'CDPError' && /setInputFiles failed/.test(e.message),
  );
});

test('FileChooser.setFiles 成功：先 setFiles 再關閉攔截器，並回傳 receipt', async () => {
  const { sdk, space, calls } = harness({
    pageCall: (params) => (params.method === 'chooserSetFiles' ? { ok: true, receipt: 'R1' } : undefined),
  });
  const chooser = new sdk.FileChooser(space, 'p1', 7, 'selectSingle');
  assert.equal(chooser.isMultiple(), false);

  assert.deepEqual(await chooser.setFiles('uploads/one.txt'), { ok: true, receipt: 'R1' });

  const seq = pageCalls(calls)
    .filter((c) => c.params.method === 'chooserSetFiles' || c.params.method === 'enableChooserIntercept')
    .map((c) => [c.params.method, c.params.args]);
  assert.deepEqual(seq, [
    ['chooserSetFiles', [7, ['uploads/one.txt']]],
    ['enableChooserIntercept', [false]],
  ]);
  assert.deepEqual(chooser._label, 'p1');
});

// ---- 四、正常路徑覆蓋：Mouse／Keyboard／Download ---------------------------

test('Mouse／Keyboard 的方法都轉成對應的 page.call 參數（覆蓋）', async () => {
  const { space, calls } = harness();
  const page = space.page('p1');

  await page.mouse.click(10, 20, { button: 'left' });
  await page.mouse.wheel(0, 100);
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText('hi');
  await page.keyboard.paste('pasted');

  const seq = pageCalls(calls).map((c) => [c.params.method, c.params.args]);
  assert.deepEqual(seq, [
    ['mouse.click', [10, 20, { button: 'left' }]],
    ['mouse.wheel', [0, 100, {}]],
    ['keyboard.press', ['Control+A', {}]],
    ['keyboard.insertText', ['hi']],
    ['keyboard.insertText', ['pasted']],
  ]);
});

test('Download 的方法都帶上 guid，page() 恆為 null（覆蓋）', async () => {
  const { sdk, calls } = harness();
  const dl = new sdk.Download('g-1');

  await dl.url();
  await dl.saveAs('downloads/x.zip');

  const seq = calls.filter((c) => c.method === 'download.call').map((c) => c.params);
  assert.deepEqual(seq, [
    { guid: 'g-1', method: 'url' },
    { guid: 'g-1', method: 'saveAs', args: ['downloads/x.zip'] },
  ]);
  assert.equal(dl.page(), null);
  assert.equal(dl.guid, 'g-1');
});
