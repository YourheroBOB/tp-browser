// tests/fmb_w7_s05_sdk_chooser_setfiles.test.mjs
// lib/sdk.js FileChooser.setFiles() 的迴歸測試：
//  1. 成功路徑：chooserSetFiles 成功後，enableChooserIntercept(false) 必須剛好被呼叫一次，
//     且 setFiles 回傳 daemon 的 receipt。
//  2. 失敗路徑：chooserSetFiles 被拒時，enableChooserIntercept(false) 仍必須剛好被呼叫一次，
//     且 setFiles 拋出的是 chooserSetFiles 的原始錯誤，不是收尾錯誤。
//  3. 收尾也失敗時：enableChooserIntercept(false) 被拒不可蓋掉 chooserSetFiles 的原始錯誤。
// 全程使用假 rpc + 假 waitPush：不連線、不讀寫檔案、不使用真實憑證。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSdk, EgoError } from '../lib/sdk.js';

const MISSING_FILE = 'FAKE_MISSING_FILE_FOR_TEST';

function harness({
  chooserSetFilesResult = { receipt: 'FAKE_RECEIPT_FOR_TEST' },
  chooserSetFilesError = null,
  closeError = null,
} = {}) {
  const calls = [];
  const pages = [{ label: 'p1', targetId: 'T1' }];
  const view = { id: 7, name: 'w7-s05', ownership: 'agent', state: 'active', pages };
  const push = {
    type: 'push',
    kind: 'fileChooser',
    targetId: 'T1',
    payload: { backendNodeId: 42, mode: 'selectSingle' },
  };

  const rpc = async (method, params = {}) => {
    calls.push({ method, params });
    if (method === 'space.use') return view;
    if (method === 'page.call') {
      if (params.method === 'chooserSetFiles') {
        if (chooserSetFilesError) throw chooserSetFilesError;
        return chooserSetFilesResult;
      }
      if (params.method === 'enableChooserIntercept') {
        if (params.args?.[0] === false && closeError) throw closeError;
        return { ok: true };
      }
    }
    return { ok: true };
  };

  const waitPush = () => Promise.resolve(push);
  const sdk = buildSdk({ rpc, waitPush });
  const space = new sdk.TaskSpace(view);
  return { sdk, space, calls };
}

const pageCalls = (calls) => calls.filter((c) => c.method === 'page.call');
const methodOrder = (calls) => pageCalls(calls).map((c) => c.params.method);
const disableCalls = (calls) => pageCalls(calls).filter(
  (c) => c.params.method === 'enableChooserIntercept' && c.params.args[0] === false,
);

async function chooserFor(sdk, space) {
  const chooser = await space.page('p1').waitForFileChooser({ timeout: 1000 });
  assert.ok(chooser instanceof sdk.FileChooser);
  assert.equal(chooser._backendNodeId, 42);
  return chooser;
}

test('setFiles 成功時剛好關閉一次攔截並回傳 receipt', async () => {
  const { sdk, space, calls } = harness();
  const chooser = await chooserFor(sdk, space);

  const receipt = await chooser.setFiles(MISSING_FILE);

  assert.deepEqual(receipt, { receipt: 'FAKE_RECEIPT_FOR_TEST' });
  assert.deepEqual(methodOrder(calls), [
    'enableChooserIntercept',
    'chooserSetFiles',
    'enableChooserIntercept',
  ]);
  assert.equal(disableCalls(calls).length, 1);
  assert.deepEqual(disableCalls(calls)[0].params, {
    spaceId: 7,
    label: 'p1',
    method: 'enableChooserIntercept',
    args: [false],
  });
  assert.deepEqual(
    pageCalls(calls).find((c) => c.params.method === 'chooserSetFiles').params.args,
    [42, [MISSING_FILE]],
  );
});

test('setFiles 失敗時仍剛好關閉一次攔截，並拋出 chooserSetFiles 原錯誤', async () => {
  const original = new EgoError('NotADirectoryError', 'file not found');
  const { sdk, space, calls } = harness({ chooserSetFilesError: original });
  const chooser = await chooserFor(sdk, space);

  await assert.rejects(chooser.setFiles(MISSING_FILE), (err) => err === original);

  assert.deepEqual(methodOrder(calls), [
    'enableChooserIntercept',
    'chooserSetFiles',
    'enableChooserIntercept',
  ]);
  assert.equal(disableCalls(calls).length, 1);
  assert.deepEqual(disableCalls(calls)[0].params.args, [false]);
});

test('關閉攔截也失敗時，拋出的仍是 chooserSetFiles 的原錯誤', async () => {
  const original = new EgoError('NotADirectoryError', 'file not found');
  const closeError = new EgoError('InternalError', 'intercept shutdown failed');
  const { sdk, space, calls } = harness({
    chooserSetFilesError: original,
    closeError,
  });
  const chooser = await chooserFor(sdk, space);

  await assert.rejects(chooser.setFiles(MISSING_FILE), (err) => err === original);

  assert.deepEqual(methodOrder(calls), [
    'enableChooserIntercept',
    'chooserSetFiles',
    'enableChooserIntercept',
  ]);
  assert.equal(disableCalls(calls).length, 1);
});
