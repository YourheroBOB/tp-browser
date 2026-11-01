// tests/fmb_w8_s05_store_nextlabel_collision.test.mjs
// 回歸測試（wave w8 / s05）：daemon/store.js nextLabel() 的標籤碰撞缺陷。
//
//   B1 nextLabel(spaceId) 只依 labelSeq 遞增，完全不看 space 內已有的標籤：分頁先以
//      自訂 label 'p2'（addPage／bindPage／adopt 的 as）佔用後，下一次 nextLabel 仍回
//      'p2'，呼叫端 addPage 就把那個分頁的 targetId 覆蓋掉。
//   B2 重載 ledger（手編或舊版 ledger 的 labelSeq 落後於實際 pN 標籤）時同樣會撞。
//
//   修法（daemon/store.js）：nextLabel 從 labelSeq 續號後，跳過 pages 內已存在的 pN
//   標籤（只認自有鍵），並把 labelSeq 推進到實際發出的號碼；persist 次數與
//   Store.prototype 公開介面維持不變。
//
// 測試邊界：所有檔案讀寫都在 mkdtempSync(tmpdir()) 內，結束即刪除；零網路、零正式服務
// 連線；示例值一律使用 FAKE_VALUE_FOR_TEST 這類明顯假字串。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../daemon/store.js';

function tempFile(t, name = 'ledger.json') {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-w8-s05-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, name);
}

const page = (targetId, openedBy = 'agent') => ({ targetId, openedBy, title: '', url: '' });

const spaceShape = (id, pages) => ({
  id,
  name: `space-${id}`,
  profileId: 'agent',
  ownership: 'agent',
  state: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  pages,
  activeTargetId: null,
});

test('題目重現：自訂 p2 先佔用後，nextLabel 不得再回 p2 或覆蓋既有分頁', (t) => {
  const file = tempFile(t);
  const store = new Store(file);
  const space = store.create({ name: 'collision' });

  store.addPage(space.id, 'p2', 'T-EXISTING-FAKE_VALUE_FOR_TEST', 'human');
  const before = JSON.stringify(store.get(space.id).pages.p2);

  const label = store.nextLabel(space.id);
  assert.match(label, /^p[1-9]\d*$/);
  assert.equal(label, 'p3', 'p2 已被占用，nextLabel 必須跳到下一個空號');
  assert.equal(Object.hasOwn(store.get(space.id).pages, label), false, 'nextLabel 只發標籤，不自行建頁');

  // 呼叫端接著 addPage：原本被佔用的 p2 必須原封不動。
  store.addPage(space.id, label, 'T-NEW-FAKE_VALUE_FOR_TEST');
  assert.equal(JSON.stringify(store.get(space.id).pages.p2), before, '既有分頁不得被覆蓋');
  assert.equal(store.get(space.id).pages[label].targetId, 'T-NEW-FAKE_VALUE_FOR_TEST');

  // labelSeq 推進到實際發出的號碼（3），記憶體與磁碟一致，下次從 p4 繼續。
  assert.equal(store.data.labelSeq[space.id], 3);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).labelSeq[space.id], 3);
  assert.equal(store.nextLabel(space.id), 'p4');
});

test('連續佔用 p2 與 p3：nextLabel 一律跳到空號，既有分頁不受影響', (t) => {
  const file = tempFile(t);
  const store = new Store(file);
  const space = store.create({ name: 'occupied' });

  store.addPage(space.id, 'p2', 'T2-FAKE_VALUE_FOR_TEST');
  assert.equal(store.nextLabel(space.id), 'p3');

  store.addPage(space.id, 'p3', 'T3-FAKE_VALUE_FOR_TEST');
  assert.equal(store.nextLabel(space.id), 'p4');
  assert.equal(store.nextLabel(space.id), 'p5');

  assert.deepEqual(Object.keys(store.get(space.id).pages), ['p1', 'p2', 'p3']);
  assert.equal(store.get(space.id).pages.p2.targetId, 'T2-FAKE_VALUE_FOR_TEST');
  assert.equal(store.get(space.id).pages.p3.targetId, 'T3-FAKE_VALUE_FOR_TEST');
  assert.equal(store.data.labelSeq[space.id], 5);
});

test('重載後仍不撞：labelSeq 落後於實際 pN 標籤（手編／舊版 ledger）', (t) => {
  const file = tempFile(t);
  writeFileSync(file, JSON.stringify({
    nextSpaceId: 2,
    // 舊版／手編 ledger：labelSeq 只有 1，但實際分頁已占用到 p4。
    labelSeq: { 1: 1 },
    spaces: {
      1: spaceShape(1, {
        p1: page('T1-FAKE_VALUE_FOR_TEST'),
        p2: page('T2-FAKE_VALUE_FOR_TEST', 'human'),
        p3: page('T3-FAKE_VALUE_FOR_TEST'),
        p4: page('T4-FAKE_VALUE_FOR_TEST', 'human'),
      }),
    },
  }), 'utf8');

  const store = new Store(file);
  assert.equal(store.nextLabel(1), 'p5', 'labelSeq 落後時必須跳過所有已存在的 pN');
  assert.equal(store.nextLabel(1), 'p6');

  // 既有分頁一頁都不能被改動。
  assert.deepEqual(store.get(1).pages, {
    p1: page('T1-FAKE_VALUE_FOR_TEST'),
    p2: page('T2-FAKE_VALUE_FOR_TEST', 'human'),
    p3: page('T3-FAKE_VALUE_FOR_TEST'),
    p4: page('T4-FAKE_VALUE_FOR_TEST', 'human'),
  });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).labelSeq[1], 6);
});

test('重載後仍不撞：ledger 整塊缺少 labelSeq 也能安全續號', (t) => {
  const file = tempFile(t);
  writeFileSync(file, JSON.stringify({
    nextSpaceId: 1,
    spaces: {
      1: spaceShape(1, {
        p1: page('T1-FAKE_VALUE_FOR_TEST'),
        p2: page('T2-FAKE_VALUE_FOR_TEST'),
      }),
    },
  }), 'utf8');

  const store = new Store(file);
  assert.equal(store.nextLabel(1), 'p3');
  assert.equal(store.get(1).pages.p2.targetId, 'T2-FAKE_VALUE_FOR_TEST');
});

test('空 space：pages 為空物件時 nextLabel 仍從 p2 起跳並寫入 labelSeq', (t) => {
  const file = tempFile(t);
  writeFileSync(file, JSON.stringify({
    nextSpaceId: 2,
    labelSeq: {},
    spaces: { 1: spaceShape(1, {}) },
  }), 'utf8');

  const store = new Store(file);
  assert.equal(store.nextLabel(1), 'p2');
  assert.equal(store.data.labelSeq[1], 2);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).labelSeq[1], 2);

  // 移除全部分頁後的行為一致（空 space 不因 removePage 而壞掉）。
  const file2 = tempFile(t, 'ledger-emptied.json');
  const s2 = new Store(file2);
  const space = s2.create({ name: 'emptied' });
  s2.removePage(space.id, 'p1');
  assert.deepEqual(Object.keys(s2.get(space.id).pages), []);
  assert.equal(s2.nextLabel(space.id), 'p2');
});

test('未知空間仍回 p? 且不寫檔；合法空間不受繼承鍵影響', (t) => {
  const file = tempFile(t);
  const store = new Store(file);
  const space = store.create({ name: 'a' });
  store.addPage(space.id, 'p2', 'T2-FAKE_VALUE_FOR_TEST');
  const before = readFileSync(file, 'utf8');

  assert.equal(store.nextLabel(9999), 'p?');
  assert.equal(store.nextLabel('toString'), 'p?');
  assert.equal(readFileSync(file, 'utf8'), before, '未知空間的 nextLabel 不得寫檔');
  assert.equal(Object.hasOwn(store.data.labelSeq, 'toString'), false);
  assert.equal(store.nextLabel(space.id), 'p3');
});

test('persist 次數不變：每次 nextLabel 只寫一次盤', (t) => {
  const file = tempFile(t);
  const store = new Store(file);
  const space = store.create({ name: 'persist-count' });
  store.addPage(space.id, 'p2', 'T2-FAKE_VALUE_FOR_TEST');

  let calls = 0;
  const original = store.persist.bind(store);
  store.persist = () => { calls += 1; original(); };

  assert.equal(store.nextLabel(space.id), 'p3');
  assert.equal(calls, 1, 'nextLabel 必須只 persist 一次');
});
