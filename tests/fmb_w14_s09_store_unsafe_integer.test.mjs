// tests/fmb_w14_s09_store_unsafe_integer.test.mjs
// 回歸測試（wave w14 / s09）：daemon/store.js 對「不安全整數（2**53 以上）」的驗證缺口。
//
//   B1 load() 的 nextSpaceId 正規化用 Number.isInteger：2**53 以上的 double 通過檢查，
//      但 `n + 1 === n`。於是 create() 的 `nextSpaceId++` 停在原地，連續兩次 create()
//      拿到同一個 id，第二個 TaskSpace 直接覆蓋第一個（資料遺失）。同樣地，ledger 內若
//      已有 2**53 這種鍵，maxId + 1 會算出同一個不安全的號碼，create() 就覆寫那個既有空間。
//   B2 nextLabel() 的 labelSeq 續號也用 Number.isInteger：labelSeq 落在 2**53 以上時
//      `parsed + 1` 不會前進，nextLabel 連續回傳同一個標籤，呼叫端 addPage 就覆蓋上一個分頁。
//
//   修法（daemon/store.js）：改用 Number.isSafeInteger 驗證 nextSpaceId、既有 space id 與
//   labelSeq；標籤序號無法再前進時（已達安全整數上限）回繞到 p2 並跳過既有分頁；
//   create() 另外在 nextSpaceId 被就地改壞時依既有 spaces 重建。不改 ledger 檔案格式，
//   也不新增／移除 Store.prototype 的公開方法。
//
// 測試邊界：所有檔案讀寫都在 mkdtempSync(tmpdir()) 內，結束即刪除；零網路、零正式服務
// 連線；示例值一律使用 FAKE_VALUE_FOR_TEST 這類明顯假字串。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../daemon/store.js';

// 2**53：Number.isInteger 為 true，但 2**53 + 1 === 2**53（加一不會前進）。
const UNSAFE = 9007199254740992;
// Number.MAX_SAFE_INTEGER：還是安全整數，但再 +1 就不安全了。
const MAX_SAFE = 9007199254740991;

function tempFile(t, name = 'ledger.json') {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-w14-s09-'));
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

test('B1：nextSpaceId 為 2**53（不安全整數）時，兩次 create() 不得拿到同一個 id', (t) => {
  const file = tempFile(t);
  writeFileSync(file, JSON.stringify({ nextSpaceId: UNSAFE, labelSeq: {}, spaces: {} }), 'utf8');

  const store = new Store(file);
  assert.equal(
    Number.isSafeInteger(store.data.nextSpaceId),
    true,
    `nextSpaceId 必須正規化成安全整數，實際為 ${store.data.nextSpaceId}`,
  );

  const a = store.create({ name: 'a-FAKE_VALUE_FOR_TEST' });
  const b = store.create({ name: 'b-FAKE_VALUE_FOR_TEST' });

  assert.equal(Number.isSafeInteger(a.id), true, `space id 必須是安全整數，實際為 ${a.id}`);
  assert.notEqual(a.id, b.id, '兩次 create() 必須取得不同 id，否則後者覆蓋前者');
  assert.equal(store.get(a.id).name, 'a-FAKE_VALUE_FOR_TEST', '第一個空間不得被覆蓋');
  assert.equal(store.get(b.id).name, 'b-FAKE_VALUE_FOR_TEST');
  assert.equal(store.list().length, 2, '兩個空間都必須留在 ledger 內');

  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(onDisk.spaces).sort(), [String(a.id), String(b.id)].sort());
  assert.equal(Number.isSafeInteger(onDisk.nextSpaceId), true);
  assert.ok(onDisk.nextSpaceId > a.id && onDisk.nextSpaceId > b.id, 'nextSpaceId 必須大於所有既有 id');

  // 重新載入後仍可繼續配置新 id（不得倒退、不得重用）
  const reloaded = new Store(file);
  const c = reloaded.create({ name: 'c-FAKE_VALUE_FOR_TEST' });
  assert.ok(c.id > a.id && c.id > b.id, `重載後的新 id 必須大於既有 id，實際為 ${c.id}`);
});

test('B1：既有 space 鍵為 2**53 時，create() 不得覆寫它（maxId + 1 會算出同一個數）', (t) => {
  const file = tempFile(t);
  writeFileSync(file, JSON.stringify({
    labelSeq: {},
    spaces: {
      [String(UNSAFE)]: spaceShape(UNSAFE, { p1: page('T1-FAKE_VALUE_FOR_TEST') }),
    },
  }), 'utf8');

  const store = new Store(file);
  assert.equal(store.get(UNSAFE).name, `space-${UNSAFE}`, '前提：載入得到既有空間');

  const created = store.create({ name: 'fresh-FAKE_VALUE_FOR_TEST' });
  assert.equal(Number.isSafeInteger(created.id), true, `新空間 id 必須是安全整數，實際為 ${created.id}`);
  assert.notEqual(String(created.id), String(UNSAFE), '新 id 不得等於既有空間的鍵');

  assert.equal(store.get(UNSAFE).name, `space-${UNSAFE}`, '既有空間不得被覆寫');
  assert.equal(store.get(UNSAFE).pages.p1.targetId, 'T1-FAKE_VALUE_FOR_TEST');

  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(Object.keys(onDisk.spaces).length, 2, '新舊空間必須並存');
  assert.equal(onDisk.spaces[String(UNSAFE)].name, `space-${UNSAFE}`);
  assert.equal(onDisk.spaces[String(created.id)].name, 'fresh-FAKE_VALUE_FOR_TEST');
  assert.equal(Number.isSafeInteger(onDisk.nextSpaceId), true);
});

test('B2：labelSeq 為 2**53 時，nextLabel 連續回傳不同且未被佔用的標籤', (t) => {
  const file = tempFile(t);
  writeFileSync(file, JSON.stringify({
    nextSpaceId: 2,
    labelSeq: { 1: UNSAFE },
    spaces: { 1: spaceShape(1, { p1: page('T1-FAKE_VALUE_FOR_TEST') }) },
  }), 'utf8');

  const store = new Store(file);
  const first = store.nextLabel(1);
  const second = store.nextLabel(1);

  assert.match(first, /^p[1-9]\d*$/, `標籤格式必須是 p<正整數>，實際為 ${first}`);
  assert.match(second, /^p[1-9]\d*$/, `標籤格式必須是 p<正整數>，實際為 ${second}`);
  assert.notEqual(first, second, 'nextLabel 不得連續回傳同一個標籤（會覆蓋分頁）');
  assert.equal(Object.hasOwn(store.get(1).pages, first), false, '發出的標籤不得撞到既有分頁');
  assert.equal(Object.hasOwn(store.get(1).pages, second), false);

  // 呼叫端真的拿這兩個標籤建頁：兩頁都必須存在
  store.addPage(1, first, 'TA-FAKE_VALUE_FOR_TEST');
  store.addPage(1, second, 'TB-FAKE_VALUE_FOR_TEST');
  assert.equal(store.get(1).pages[first].targetId, 'TA-FAKE_VALUE_FOR_TEST');
  assert.equal(store.get(1).pages[second].targetId, 'TB-FAKE_VALUE_FOR_TEST');
  assert.deepEqual(Object.keys(store.get(1).pages).sort(), ['p1', first, second].sort());

  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(Number.isSafeInteger(onDisk.labelSeq['1']), true);
  assert.equal(onDisk.spaces['1'].pages[first].targetId, 'TA-FAKE_VALUE_FOR_TEST');
});

test('B2：labelSeq 已達安全整數上限時回繞，仍跳過既有分頁並持續前進', (t) => {
  const file = tempFile(t);
  writeFileSync(file, JSON.stringify({
    nextSpaceId: 2,
    labelSeq: { 1: MAX_SAFE },
    spaces: {
      1: spaceShape(1, {
        p1: page('T1-FAKE_VALUE_FOR_TEST'),
        p2: page('T2-FAKE_VALUE_FOR_TEST'),
      }),
    },
  }), 'utf8');

  const store = new Store(file);
  assert.equal(store.nextLabel(1), 'p3', '上限之後應回繞，且 p2 已被佔用必須跳過');
  assert.equal(store.nextLabel(1), 'p4');
  assert.equal(store.get(1).pages.p2.targetId, 'T2-FAKE_VALUE_FOR_TEST', '既有分頁不得被覆蓋');
  assert.equal(Number.isSafeInteger(JSON.parse(readFileSync(file, 'utf8')).labelSeq['1']), true);
});

test('B1：nextSpaceId 在記憶體中被改成不安全整數／非正數時，create() 依既有空間重建', (t) => {
  const file = tempFile(t);
  const store = new Store(file);
  const keep = store.create({ name: 'keep-FAKE_VALUE_FOR_TEST' });
  const seen = new Set([keep.id]);

  for (const bad of [UNSAFE, 0, -1, 1.5, '5', null]) {
    store.data.nextSpaceId = bad;
    const created = store.create({ name: `after-${String(bad)}-FAKE_VALUE_FOR_TEST` });

    assert.equal(
      Number.isSafeInteger(created.id),
      true,
      `nextSpaceId=${String(bad)} 時 id 必須是安全整數，實際為 ${created.id}`,
    );
    assert.equal(seen.has(created.id), false, `nextSpaceId=${String(bad)} 時 id ${created.id} 不得重複使用`);
    seen.add(created.id);
    assert.equal(store.get(keep.id).name, 'keep-FAKE_VALUE_FOR_TEST', '既有空間不得被覆蓋');
  }

  assert.equal(Number.isSafeInteger(store.data.nextSpaceId), true, '操作後 nextSpaceId 必須回到安全整數');
  assert.equal(store.list().length, seen.size, 'ledger 內的空間數必須等於成功建立的數量');
});
