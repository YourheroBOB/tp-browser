// tests/fmb_w4_s09_store_nextspaceid.test.mjs
// 回歸測試（wave w4 / s09）：daemon/store.js 的兩個缺陷
//   B1 ledger 載入時未驗證 nextSpaceId：legacy／手改／半寫入的 ledger 若缺少 nextSpaceId，
//      create() 會算出 NaN 當 id 並以字串鍵 "NaN" 寫回；若 nextSpaceId 落後於既有 space id，
//      create() 會直接覆蓋既有空間（id 重用）。另外根節點是 null／陣列／純量時，
//      load() 會把非物件塞進 this.data，讓後續每個方法都炸 TypeError。
//   B2 deleteSpace() 只刪 spaces[id]，留下孤兒 labelSeq[id]，ledger 只增不減
//      （fmb_feature2/reaper.js 每次回收都會留下一筆）。
//
// 測試邊界：所有檔案讀寫都在 mkdtempSync(tmpdir()) 內，結束即刪除；零網路、
// 零正式服務連線；示例值一律使用 FAKE_VALUE_FOR_TEST 這類明顯假字串。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../daemon/store.js';

function tempFile(t, name = 'ledger.json') {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-w4-s09-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, name);
}

// 先寫入既有的 ledger 內容（模擬舊版或半寫入的檔案），再回傳路徑。
function seededLedger(t, ledger, { raw = false } = {}) {
  const file = tempFile(t);
  writeFileSync(file, raw ? String(ledger) : JSON.stringify(ledger), 'utf8');
  return file;
}

const spaceRecord = (id, name, targetId = null) => ({
  id,
  name,
  profileId: 'agent',
  ownership: 'agent',
  state: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  pages: { p1: { targetId, openedBy: 'agent', title: '', url: '' } },
  activeTargetId: targetId,
});

test('B1：ledger 缺 nextSpaceId 時 create() 不得產生 NaN id／"NaN" 鍵', (t) => {
  const file = seededLedger(t, { spaces: {}, labelSeq: {} });
  const before = readFileSync(file, 'utf8');

  const store = new Store(file);
  assert.equal(readFileSync(file, 'utf8'), before, 'load() 不得改寫磁碟（只正規化記憶體狀態）');

  const created = store.create({ name: 'legacy' });
  assert.equal(Number.isInteger(created.id), true, `space id 必須是整數，實際為 ${created.id}`);
  assert.equal(created.id, 1);
  assert.equal(store.get(1).name, 'legacy');
  assert.equal(store.get('NaN'), null);

  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(onDisk.spaces), ['1'], '不得以 "NaN" 字串鍵寫回');
  assert.equal(onDisk.nextSpaceId, 2);
});

test('B1：nextSpaceId 落後於既有 space id 時 create() 不得覆蓋既有空間', (t) => {
  const file = seededLedger(t, {
    nextSpaceId: 1,
    labelSeq: { 5: 1 },
    spaces: { 5: spaceRecord(5, 'kept', 'T1-FAKE_VALUE_FOR_TEST') },
  });

  const store = new Store(file);
  const created = store.create({ name: 'fresh' });

  assert.equal(created.id, 6, '新 id 必須大於所有既有 space id');
  assert.equal(store.get(5).name, 'kept', '既有空間不得被新空間覆蓋');
  assert.equal(store.get(5).pages.p1.targetId, 'T1-FAKE_VALUE_FOR_TEST');

  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(onDisk.spaces).sort(), ['5', '6']);
  assert.equal(onDisk.nextSpaceId, 7);
});

test('B1：nextSpaceId 為 0／負數／小數／字串／null 時一律重建為正整數', (t) => {
  for (const bad of [0, -3, 1.5, 'three', null, true]) {
    const file = seededLedger(t, { nextSpaceId: bad, spaces: {}, labelSeq: {} });
    const store = new Store(file);
    assert.equal(
      store.data.nextSpaceId, 1,
      `nextSpaceId=${JSON.stringify(bad)} 應被正規化為 1，實際 ${JSON.stringify(store.data.nextSpaceId)}`,
    );
    const created = store.create({ name: `bad-${String(bad)}` });
    assert.equal(created.id, 1, `nextSpaceId=${JSON.stringify(bad)} 時 create() 應產生 id 1`);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).nextSpaceId, 2);
  }
});

test('B1：ledger 根節點不是物件（null／陣列／純量）時安全降級，且不覆寫原檔', (t) => {
  for (const raw of ['null', '[]', '"ledger"', '42', 'true']) {
    const file = seededLedger(t, raw, { raw: true });
    const errors = t.mock.method(console, 'error', () => {});

    const store = new Store(file);
    assert.ok(errors.mock.callCount() >= 1, `根節點 ${raw} 應留下載入失敗的診斷訊息`);
    assert.deepEqual(store.list(), []);
    assert.equal(store.get(1), null);
    assert.equal(store.data.nextSpaceId, 1);
    assert.equal(readFileSync(file, 'utf8'), raw, '降級不得立刻覆寫損壞的原檔');

    const created = store.create({ name: `recovered-${raw}` });
    assert.equal(created.id, 1);
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(onDisk.spaces['1'].name, `recovered-${raw}`);
  }
});

test('B2：deleteSpace() 一併清掉 labelSeq，ledger 不隨回收無限膨脹', (t) => {
  const file = tempFile(t);
  const store = new Store(file);
  const keep = store.create({ name: 'keep' });
  const drop = store.create({ name: 'drop' });

  assert.equal(new Store(file).data.labelSeq[drop.id], 1, '前提：create() 會建立 labelSeq 計數器');

  store.deleteSpace(drop.id);
  assert.equal(Object.hasOwn(store.data.labelSeq, drop.id), false, 'labelSeq[drop] 應被清掉');
  assert.equal(Object.hasOwn(store.data.labelSeq, keep.id), true, '其他空間的 labelSeq 不得受影響');

  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(onDisk.labelSeq), [String(keep.id)]);
  assert.deepEqual(Object.keys(onDisk.spaces), [String(keep.id)]);

  // 刪除空間不得讓 nextSpaceId 倒退（id 不可重用）
  const reloaded = new Store(file);
  assert.equal(reloaded.data.nextSpaceId, 3);
  assert.equal(reloaded.create({ name: 'after' }).id, 3);
});

test('B2：刪除後重建同號空間不會沿用舊標籤序號（labelSeq 已清空）', (t) => {
  const file = tempFile(t);
  const store = new Store(file);
  const first = store.create({ name: 'first' });
  assert.equal(store.nextLabel(first.id), 'p2');
  store.deleteSpace(first.id);

  // 模擬「ledger 被外部重置後 nextSpaceId 重用同一個數字」：labelSeq 不得殘留舊序號。
  store.data.nextSpaceId = first.id;
  const again = store.create({ name: 'again' });
  assert.equal(again.id, first.id);
  assert.equal(store.nextLabel(again.id), 'p2');
});
