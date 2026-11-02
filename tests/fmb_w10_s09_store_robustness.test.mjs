// tests/fmb_w10_s09_store_robustness.test.mjs
// 回歸測試（wave w10 / s09）：daemon/store.js 健壯性修復
//   1. 舊版或手動編輯缺少 labelSeq 的 ledger 載入後，create() 原本因
//      this.data.labelSeq[id] 存取 undefined 屬性而拋出 TypeError。修復後
//      防禦性初始化 labelSeq，正常建立空間並持久化。
//   2. 既有 Store 實例呼叫 load() 若遇到損毀 ledger，原本 catch 區塊未重設
//      this.data，導致記憶體殘留舊空間，違背「starting fresh」降級契約。修復後
//      確實降級為空 ledger，備份損壞檔案，並可安全重建新空間。
//
// 測試邊界：所有檔案讀寫都在 mkdtempSync(tmpdir()) 內，結束即刪除；零網路、
// 零正式服務連線；示例值一律使用 FAKE_VALUE_FOR_TEST 這類明顯假字串。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../daemon/store.js';

function tempFile(t, name = 'ledger.json') {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-w10-s09-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, name);
}

test('缺少 labelSeq 的舊版／手編 ledger：create() 正常建空間不拋 TypeError，labelSeq 接續正確', (t) => {
  const file = tempFile(t);
  // 模擬缺少 labelSeq 區塊的既有合法 ledger
  writeFileSync(file, JSON.stringify({
    nextSpaceId: 2,
    spaces: {
      1: {
        id: 1,
        name: 'legacy-space',
        profileId: 'agent',
        ownership: 'agent',
        state: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        pages: { p1: { targetId: 'FAKE_VALUE_FOR_TEST', openedBy: 'agent', title: '', url: '' } },
        activeTargetId: 'FAKE_VALUE_FOR_TEST',
      },
    },
  }), 'utf8');

  const store = new Store(file);
  assert.equal(store.data.labelSeq, undefined, '前提確認：載入的原 ledger 缺少 labelSeq');

  // 未修復前此處會拋出 TypeError: Cannot set properties of undefined (setting '2')
  const created = store.create({ name: 'fresh-space' });
  assert.equal(created.id, 2);
  assert.equal(store.data.labelSeq[2], 1, '新空間的 labelSeq 應初始化為 1');

  // 持久化檔案也必須保有 labelSeq 結構
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(onDisk.labelSeq['2'], 1);
  assert.equal(onDisk.spaces['2'].name, 'fresh-space');

  // 後續 nextLabel 行為正常接續為 p2
  assert.equal(store.nextLabel(2), 'p2');
  assert.equal(store.data.labelSeq[2], 2);
});

test('既有 Store 實例重載損毀 ledger：確實 starting fresh 降級為空 ledger，不殘留舊空間', (t) => {
  const file = tempFile(t);
  const store = new Store(file);
  const s1 = store.create({ name: 'before-corrupt' });
  assert.equal(s1.id, 1);
  assert.equal(store.list().length, 1);

  // 模擬執行期間檔案被外部破壞（截斷 JSON）
  writeFileSync(file, '{"nextSpaceId": 99, "spaces": {', 'utf8');

  const errors = t.mock.method(console, 'error', () => {});
  store.load();
  assert.ok(errors.mock.callCount() >= 1, '應印出 starting fresh 日誌');

  // 未修復前 store.data 仍殘留原本空間 1；修復後必須完全降級為空 ledger
  assert.deepEqual(store.list(), [], '重載損毀檔後必須降級為空 spaces');
  assert.equal(store.get(1), null);
  assert.equal(store.data.nextSpaceId, 1, 'nextSpaceId 應回退為初始值 1');
  assert.deepEqual(store.data.labelSeq, {}, 'labelSeq 應回退為空物件');

  // 驗證有留下備份檔
  const dir = join(file, '..');
  const backups = readdirSync(dir).filter((n) => n.includes('.corrupt-'));
  assert.equal(backups.length, 1, '應產生恰好一個 .corrupt- 備份');

  // 降級後可安全繼續建立新空間
  const recovered = store.create({ name: 'recovered' });
  assert.equal(recovered.id, 1);
  assert.equal(store.list().length, 1);
  assert.equal(store.get(1).name, 'recovered');
});
