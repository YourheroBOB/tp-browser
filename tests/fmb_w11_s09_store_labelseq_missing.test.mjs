// tests/fmb_w11_s09_store_labelseq_missing.test.mjs
// 回歸測試（wave w11 / s09）：daemon/store.js create() 在 ledger 缺少（或型別錯誤的）
// labelSeq 時拋 TypeError 的缺陷。
//
//   B1 load() 原本只把 nextSpaceId 正規化，沒有處理 labelSeq。nextLabel() 有防禦
//      （`this.data.labelSeq ?? (this.data.labelSeq = {})`），但 create() 直接
//      `this.data.labelSeq[id] = 1`：舊版／手編／半寫入的 ledger 只要整塊缺 labelSeq，
//      daemon 雖然載入得到既有空間，第一次建立新 TaskSpace 就拋 TypeError 而失效。
//      labelSeq 為 null／純量會直接拋錯，為陣列則寫出畸形資料。
//
//   修法（daemon/store.js）：載入時把 labelSeq 一併正規化成一般物件
//   （缺欄位或型別不符時補成 {}），與既有 nextSpaceId 正規化、以及 nextLabel 的
//   防禦行為一致；不改動 persist 的檔案格式與 Store.prototype 公開介面。
//
// 測試邊界：所有檔案讀寫都在 mkdtempSync(tmpdir()) 內，結束即刪除；零網路、零正式服務
// 連線；示例值一律使用 FAKE_VALUE_FOR_TEST 這類明顯假字串。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../daemon/store.js';

function tempFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-w11-s09-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'ledger.json');
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

test('B1：ledger 整塊缺少 labelSeq 時 create() 不得拋錯，既有空間原封不動', (t) => {
  const file = tempFile(t);
  writeFileSync(file, JSON.stringify({
    nextSpaceId: 2,
    spaces: { 1: spaceRecord(1, 'kept', 'T1-FAKE_VALUE_FOR_TEST') },
  }), 'utf8');

  const store = new Store(file);
  assert.equal(store.get(1).name, 'kept');

  const created = store.create({ name: 'fresh' });
  assert.equal(created.id, 2, '新空間 id 應接續既有 nextSpaceId');
  assert.equal(store.data.labelSeq[2], 1, 'create() 應為新空間建立 labelSeq 計數器');
  assert.equal(store.get(1).name, 'kept', '既有空間不得被覆蓋');
  assert.equal(store.get(1).pages.p1.targetId, 'T1-FAKE_VALUE_FOR_TEST');

  // 落盤後重新載入仍正確（labelSeq 已寫成合法物件）
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(onDisk.spaces).sort(), ['1', '2']);
  assert.equal(onDisk.labelSeq['2'], 1);
  assert.equal(onDisk.nextSpaceId, 3);

  const reloaded = new Store(file);
  assert.equal(reloaded.get(2).name, 'fresh');
  assert.equal(reloaded.nextLabel(2), 'p2', '新空間重載後仍可正常續號');
});

test('B1：labelSeq 為 null／陣列／純量時 create() 仍能運作（正規化為一般物件）', (t) => {
  for (const bad of [null, [], 5, 'FAKE_VALUE_FOR_TEST']) {
    const file = tempFile(t);
    writeFileSync(file, JSON.stringify({
      nextSpaceId: 1,
      labelSeq: bad,
      spaces: {},
    }), 'utf8');

    const store = new Store(file);
    const created = store.create({ name: `bad-${JSON.stringify(bad)}` });
    assert.equal(created.id, 1, `labelSeq=${JSON.stringify(bad)} 時 create() 應產生 id 1`);
    assert.equal(
      Array.isArray(store.data.labelSeq),
      false,
      `labelSeq 應被正規化成一般物件，實際：${JSON.stringify(store.data.labelSeq)}`,
    );
    assert.equal(store.data.labelSeq[1], 1);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).labelSeq['1'], 1);
  }
});

test('B1：缺少 labelSeq 仍能連續建立多個空間並跨重載續號', (t) => {
  const file = tempFile(t);
  writeFileSync(file, JSON.stringify({
    nextSpaceId: 1,
    spaces: {},
  }), 'utf8');

  const store = new Store(file);
  const a = store.create({ name: 'a' });
  const b = store.create({ name: 'b' });
  assert.equal(a.id, 1);
  assert.equal(b.id, 2);
  assert.deepEqual(store.data.labelSeq, { 1: 1, 2: 1 });

  assert.equal(store.nextLabel(a.id), 'p2');
  assert.equal(new Store(file).nextLabel(a.id), 'p3');
});
