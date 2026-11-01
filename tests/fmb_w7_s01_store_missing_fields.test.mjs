// tests/fmb_w7_s01_store_missing_fields.test.mjs
// 回歸測試（wave w7 / s01）：daemon/store.js 載入「缺 spaces／labelSeq／pages」或
// 壞形狀 ledger 時的 TypeError。
//   B1 根節點的 spaces 缺漏／null／陣列／純量 → list()／get() 在 Object.values(undefined)、
//      Object.hasOwn(undefined) 處拋 TypeError，daemon 起不來；create() 則在
//      `Cannot set properties of undefined` 拋錯，且 nextSpaceId 已遞增、記憶體成半套狀態。
//   B2 labelSeq 缺漏／null／陣列／純量 → nextLabel() 在 Object.hasOwn(undefined) 拋錯。
//   B3 space.pages 為 null／陣列／純量 → setPage／removePage／bindPage／addPage 拋 TypeError。
//   B4 spaces 內混入非物件項目（null／陣列／純量）→ 被 list()／reaper 當成空間。
//
// 測試邊界：所有檔案讀寫都在 mkdtempSync(tmpdir()) 內，結束即刪除；零網路、零正式服務
// 連線；示例值一律使用 FAKE_VALUE_FOR_TEST 這類明顯假字串。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../daemon/store.js';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function tempFile(t, name = 'ledger.json') {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-w7-s01-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, name);
}

function seed(t, ledger) {
  const file = tempFile(t);
  writeFileSync(file, typeof ledger === 'string' ? ledger : JSON.stringify(ledger), 'utf8');
  return file;
}

const validSpace = (id, name = 'a') => ({
  id,
  name,
  profileId: 'agent',
  ownership: 'agent',
  state: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  pages: { p1: { targetId: null, openedBy: 'agent', title: '', url: '' } },
  activeTargetId: null,
});

// 逐一呼叫所有公開方法：任何一個拋錯都視為回歸失敗。
// spaceId 傳 null 表示「這份 ledger 沒有任何可用空間」。
function exercisePublicMethods(store, spaceId) {
  assert.doesNotThrow(() => store.list(), 'list()');
  assert.doesNotThrow(() => store.get(999999), 'get(未知空間)');
  assert.doesNotThrow(() => store.nextLabel(999999), 'nextLabel(未知空間)');
  assert.doesNotThrow(() => store.setPage(999999, 'p1', { title: 'ghost' }), 'setPage(未知空間)');
  assert.doesNotThrow(() => store.removePage(999999, 'p1'), 'removePage(未知空間)');
  assert.doesNotThrow(() => store.deleteSpace(999999), 'deleteSpace(未知空間)');
  if (spaceId != null) {
    assert.doesNotThrow(() => store.get(spaceId), 'get(既有空間)');
    assert.doesNotThrow(() => store.setPage(spaceId, 'p1', { title: 'FAKE_VALUE_FOR_TEST' }), 'setPage');
    assert.doesNotThrow(() => store.nextLabel(spaceId), 'nextLabel(既有空間)');
    assert.doesNotThrow(() => store.bindPage(spaceId, 'p2', 'T-FAKE_VALUE_FOR_TEST'), 'bindPage');
    assert.doesNotThrow(() => store.addPage(spaceId, 'p3', 'T-FAKE_VALUE_FOR_TEST'), 'addPage');
    assert.doesNotThrow(() => store.removePage(spaceId, 'p3'), 'removePage');
  }
  assert.doesNotThrow(() => store.load(), 'load()');
  assert.doesNotThrow(() => store.persist(), 'persist()');
}

test('B0（題目重現）：缺 labelSeq 且 space.pages 為 null 的 ledger，載入後每個公開方法都不拋錯', (t) => {
  const file = seed(t, {
    nextSpaceId: 2,
    spaces: { 1: { id: 1, name: 'a', pages: null, activeTargetId: null } },
  });
  const store = new Store(file); // 原本 nextLabel(1) 會在 Object.hasOwn(undefined) 拋錯

  assert.equal(store.list().length, 1);
  assert.equal(store.get(1).name, 'a');
  assert.deepEqual(store.get(1).pages, {}, 'pages 為 null 必須正規化成空物件');

  exercisePublicMethods(store, 1);

  // 原本 create({ name: 'x' }) 會拋 Cannot set properties of undefined
  const created = store.create({ name: 'x' });
  assert.ok(Number.isInteger(created.id), '新 id 必須是整數');
  assert.equal(created.id, 2, '新 id 必須大於既有 id（1）');
  assert.equal(store.get(1).name, 'a', '既有空間不得被覆蓋');

  // persist 後記憶體與磁碟必須一致（不得留下「半個空間」），且檔案內有 labelSeq 物件
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(isPlainObject(onDisk.labelSeq), 'persist 後 labelSeq 必須是物件');
  assert.equal(onDisk.labelSeq[created.id], 1);
  assert.ok(onDisk.spaces[String(created.id)], '新空間必須落盤');
  assert.equal(JSON.stringify(onDisk), JSON.stringify(store.data), '磁碟內容必須等於記憶體狀態');
});

const SHAPE_CASES = [
  ['缺 spaces', { nextSpaceId: 1, labelSeq: {} }],
  ['spaces 為 null', { nextSpaceId: 1, labelSeq: {}, spaces: null }],
  ['spaces 為陣列', { nextSpaceId: 1, labelSeq: {}, spaces: [] }],
  ['spaces 為純量', { nextSpaceId: 1, labelSeq: {}, spaces: 'nope' }],
  ['缺 labelSeq', { nextSpaceId: 1, spaces: {} }],
  ['labelSeq 為 null', { nextSpaceId: 1, spaces: {}, labelSeq: null }],
  ['labelSeq 為陣列', { nextSpaceId: 1, spaces: {}, labelSeq: [] }],
  ['labelSeq 為純量', { nextSpaceId: 1, spaces: {}, labelSeq: 7 }],
  ['spaces 與 labelSeq 都缺', {}],
];

for (const [label, ledger] of SHAPE_CASES) {
  test(`B1：${label} → 所有公開方法安全，create 續號且落盤含 labelSeq 物件`, (t) => {
    const file = seed(t, ledger);
    const store = new Store(file);

    assert.ok(isPlainObject(store.data.spaces), `${label}: spaces 必須正規化成純物件`);
    assert.ok(isPlainObject(store.data.labelSeq), `${label}: labelSeq 必須正規化成純物件`);
    assert.deepEqual(store.list(), [], `${label}: list() 必須是空陣列`);
    assert.equal(store.get(1), null, `${label}: get() 必須回 null`);

    exercisePublicMethods(store, null);

    const created = store.create({ name: 'fresh' });
    assert.ok(Number.isInteger(created.id) && created.id > 0, `${label}: create 必須回傳正整數 id`);
    assert.equal(store.nextLabel(created.id), 'p2', `${label}: nextLabel 必須可運作`);

    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(isPlainObject(onDisk.labelSeq), `${label}: persist 後 labelSeq 必須是物件`);
    assert.ok(isPlainObject(onDisk.spaces), `${label}: persist 後 spaces 必須是物件`);
    assert.ok(onDisk.spaces[String(created.id)], `${label}: 新空間必須落盤`);
    assert.equal(onDisk.nextSpaceId, created.id + 1, `${label}: nextSpaceId 必須續號`);
  });
}

test('B4：spaces 內非物件項目（null／陣列／純量／布林）一律丟棄，合法空間保留', (t) => {
  const file = seed(t, {
    nextSpaceId: 9,
    labelSeq: { 5: 3 },
    spaces: { 1: null, 2: 42, 3: 'x', 4: [], 6: true, 5: validSpace(5, 'kept') },
  });
  const store = new Store(file);

  assert.equal(store.list().length, 1, '只有合法的 space 項目應保留');
  assert.equal(store.get(5).name, 'kept');
  for (const bad of [1, 2, 3, 4, 6]) {
    assert.equal(store.get(bad), null, `space ${bad} 必須被丟棄`);
  }

  exercisePublicMethods(store, 5);

  const created = store.create({ name: 'fresh' });
  assert.ok(created.id > 5, `新 id 必須大於所有既有 id，實際為 ${created.id}`);
  assert.equal(store.get(5).name, 'kept', '既有空間不得被覆蓋');
});

for (const bad of [null, [], 'nope', 42, true]) {
  test(`B3：space.pages 為 ${JSON.stringify(bad)} 時正規化成空物件，分頁方法不拋錯`, (t) => {
    const file = seed(t, {
      nextSpaceId: 1,
      labelSeq: {},
      spaces: { 1: { id: 1, name: 'a', pages: bad, activeTargetId: null } },
    });
    const store = new Store(file);
    assert.deepEqual(store.get(1).pages, {}, 'pages 必須正規化成純物件');

    exercisePublicMethods(store, 1);

    assert.ok(store.get(1).pages.p2, 'bindPage 必須能寫入正規化後的 pages');
    assert.equal(new Store(file).get(1).name, 'a', '重載後空間必須還在');
  });
}

test('B2：根節點不是物件（null／陣列／純量）時安全降級，方法不拋錯且可恢復寫入', (t) => {
  t.mock.method(console, 'error', () => {});
  for (const raw of ['null', '[]', '"ledger"', '42', 'true']) {
    const file = seed(t, raw);
    const store = new Store(file);

    assert.deepEqual(store.list(), [], raw);
    assert.equal(store.get(1), null, raw);
    assert.equal(store.data.nextSpaceId, 1, raw);

    exercisePublicMethods(store, null);

    const created = store.create({ name: 'recovered' });
    assert.equal(created.id, 1, raw);
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(isPlainObject(onDisk.labelSeq), raw);
    assert.ok(isPlainObject(onDisk.spaces), raw);
    assert.ok(onDisk.spaces['1'], raw);
  }
});

test('B5：正常 ledger 的行為不變（create／nextLabel／bindPage／setPage／重載往返）', (t) => {
  const file = tempFile(t);
  const store = new Store(file);
  const s = store.create({ name: 'normal' });

  assert.equal(s.id, 1);
  assert.deepEqual(s.pages.p1, { targetId: null, openedBy: 'agent', title: '', url: '' });
  assert.equal(store.nextLabel(s.id), 'p2');
  assert.equal(store.nextLabel(s.id), 'p3');
  store.bindPage(s.id, 'p2', 'T-FAKE_VALUE_FOR_TEST', 'human');
  store.setPage(s.id, 'p2', { title: 't', url: 'http://127.0.0.1:0/x' });
  store.removePage(s.id, 'p3');

  const reloaded = new Store(file);
  assert.deepEqual(reloaded.data, store.data);
  assert.deepEqual(Object.keys(reloaded.get(s.id).pages).sort(), ['p1', 'p2']);
  assert.equal(reloaded.get(s.id).pages.p2.targetId, 'T-FAKE_VALUE_FOR_TEST');
  assert.equal(reloaded.get(s.id).pages.p2.openedBy, 'human');
  assert.equal(reloaded.nextLabel(s.id), 'p4');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).labelSeq[s.id], 4);
});

test('B6：不可新增 Store.prototype 方法（公開介面契約不變）', () => {
  const names = Object.getOwnPropertyNames(Store.prototype)
    .filter((n) => n !== 'constructor')
    .sort();
  assert.deepEqual(names, [
    'addPage', 'bindPage', 'create', 'deleteSpace', 'get',
    'list', 'load', 'nextLabel', 'persist', 'removePage', 'setPage',
  ]);
});
