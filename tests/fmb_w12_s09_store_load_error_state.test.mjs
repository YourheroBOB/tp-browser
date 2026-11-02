// tests/fmb_w12_s09_store_load_error_state.test.mjs
// 回歸測試（wave w12 / s09）：daemon/store.js load() 的邊界與錯誤處理。
//
//   B1 BOM：Windows 的記事本／PowerShell 存 UTF-8 時常自動加上 BOM（U+FEFF），但
//      JSON.parse 不接受前置 BOM。一份「內容完全合法、只是被手動編輯過」的 ledger
//      因此被當成損毀檔，連備份一起降級成空 ledger——daemon 視角下所有 TaskSpace
//      瞬間消失。修法：載入前只剝掉開頭那一個 U+FEFF，其餘位元組不動。
//   B2 load() 的 catch 只印日誌、留備份，沒有把 this.data 重設成空 ledger。load() 是
//      公開方法，可在成功載入後被再次呼叫；失敗後 Store 會帶著舊 ledger 繼續運作，
//      與日誌「starting fresh」及降級契約相反。
//   B3 normalizeLedger() 的 Math.max(...ids) 在 spaces 鍵數很大時會撞上引擎的參數上限
//      並拋 RangeError，讓合法的大型 ledger 被誤判成損毀（降級＋無謂備份）；
//      改成 reduce 後不再有這個上限。
//
// 測試邊界：所有檔案讀寫都在 mkdtempSync(tmpdir()) 內，結束即刪除；零網路、零正式服務
// 連線；示例值一律使用 FAKE_VALUE_FOR_TEST 這類明顯假字串。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../daemon/store.js';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-w12-s09-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const corruptBackups = (dir) => readdirSync(dir).filter((name) => name.includes('.corrupt-'));

const page = (targetId) => ({ targetId, openedBy: 'agent', title: '', url: '' });

const spaceRecord = (id, name, targetId) => ({
  id,
  name,
  profileId: 'agent',
  ownership: 'agent',
  state: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  pages: { p1: page(targetId) },
  activeTargetId: targetId,
});

test('B1：手動編輯過、帶 UTF-8 BOM 的合法 ledger 不得被當成損毀', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'ledger.json');
  const ledger = {
    nextSpaceId: 3,
    labelSeq: { 2: 4 },
    spaces: { 2: spaceRecord(2, 'kept-FAKE_VALUE_FOR_TEST', 'T-KEPT-FAKE_VALUE_FOR_TEST') },
  };
  // 模擬記事本另存的結果：內容本身合法，只是開頭多了一個 U+FEFF。
  writeFileSync(file, `\uFEFF${JSON.stringify(ledger)}`, 'utf8');
  const errors = t.mock.method(console, 'error', () => {});

  const store = new Store(file);
  assert.equal(errors.mock.callCount(), 0, '合法內容加 BOM 不應觸發載入失敗的診斷訊息');
  assert.deepEqual(corruptBackups(dir), [], '不得留下任何 .corrupt- 備份');
  assert.equal(store.get(2)?.name, 'kept-FAKE_VALUE_FOR_TEST', '既有空間必須原封不動載入');
  assert.equal(store.get(2).pages.p1.targetId, 'T-KEPT-FAKE_VALUE_FOR_TEST');
  assert.equal(store.data.nextSpaceId, 3, 'nextSpaceId 應沿用檔案內容（已大於所有 space id）');
  assert.equal(store.nextLabel(2), 'p5', 'labelSeq[2]=4 → 下一個標籤應為 p5');

  const created = store.create({ name: 'after-bom-FAKE_VALUE_FOR_TEST' });
  assert.equal(created.id, 3);
  assert.equal(store.get(2).name, 'kept-FAKE_VALUE_FOR_TEST', '既有空間不得被新空間覆蓋');

  // 本模組自己寫出的檔案仍是純 JSON，不會把 BOM 帶回去。
  assert.notEqual(readFileSync(file, 'utf8').charCodeAt(0), 0xfeff);
  assert.equal(new Store(file).get(3)?.name, 'after-bom-FAKE_VALUE_FOR_TEST');
});

test('B2：成功載入後再 load() 遇到損毀檔，必須降級為空 ledger（不得留下舊資料）', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'ledger.json');
  const store = new Store(file);
  const stale = store.create({ name: 'stale-FAKE_VALUE_FOR_TEST' });
  store.bindPage(stale.id, 'p1', 'T-STALE-FAKE_VALUE_FOR_TEST');

  const corrupt = '{ "nextSpaceId": 2, "spaces": {';
  writeFileSync(file, corrupt, 'utf8');
  const errors = t.mock.method(console, 'error', () => {});

  assert.doesNotThrow(() => store.load(), 'load() 不得把解析錯誤往外拋');
  assert.ok(errors.mock.callCount() >= 1, '載入失敗必須留下診斷訊息');
  assert.deepEqual(store.list(), [], '失敗後必須是空 ledger，不得留著先前載入的空間');
  assert.deepEqual(store.data, { nextSpaceId: 1, labelSeq: {}, spaces: {} });
  assert.equal(store.get(stale.id), null);

  // 原檔仍被原樣備份，資料救得回來（降級不等於丟掉證據）。
  const backups = corruptBackups(dir);
  assert.equal(backups.length, 1, `應留下恰一個 .corrupt- 備份，實際：${backups.join(',') || '(無)'}`);
  assert.equal(readFileSync(join(dir, backups[0]), 'utf8'), corrupt);

  // 降級後仍可正常運作，且寫回磁碟的內容與記憶體一致（不會把舊空間復活）。
  const created = store.create({ name: 'fresh-FAKE_VALUE_FOR_TEST' });
  assert.equal(created.id, 1, '降級後 nextSpaceId 必須從 1 重新開始');
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(onDisk.spaces), ['1']);
  assert.equal(onDisk.spaces['1'].name, 'fresh-FAKE_VALUE_FOR_TEST');
  assert.equal(onDisk.nextSpaceId, 2);
  assert.deepEqual(new Store(file).data, store.data);
});

test('B2：連續多次 load() 失敗仍保持可用的空 ledger（重設具冪等性）', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'ledger.json');
  const store = new Store(file);
  store.create({ name: 'first-FAKE_VALUE_FOR_TEST' });

  writeFileSync(file, 'null', 'utf8');
  const errors = t.mock.method(console, 'error', () => {});

  assert.doesNotThrow(() => store.load());
  assert.doesNotThrow(() => store.load());
  assert.ok(errors.mock.callCount() >= 2, '每次失敗都應留下診斷訊息');
  assert.deepEqual(store.list(), []);
  assert.equal(store.data.nextSpaceId, 1);
  assert.equal(store.create({ name: 'again-FAKE_VALUE_FOR_TEST' }).id, 1);
});

test('B3：大型但合法的 ledger 不得被誤判為損毀（normalizeLedger 不得因展開運算子拋錯）', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'ledger.json');
  // 遠超過 JS 引擎的呼叫參數上限（Math.max(...ids) 在此規模會拋 RangeError）。
  const COUNT = 250000;
  const spaces = {};
  for (let i = 1; i <= COUNT; i += 1) spaces[i] = { id: i };
  // 刻意不寫 nextSpaceId：舊版 ledger 的合法形狀，載入時應由 normalizeLedger 重建。
  writeFileSync(file, JSON.stringify({ labelSeq: {}, spaces }), 'utf8');
  const errors = t.mock.method(console, 'error', () => {});

  const store = new Store(file);
  assert.equal(errors.mock.callCount(), 0, '合法的大型 ledger 不應觸發載入失敗');
  assert.deepEqual(corruptBackups(dir), [], '合法的大型 ledger 不得留下 .corrupt- 備份');
  assert.equal(store.list().length, COUNT);
  assert.equal(store.get(COUNT)?.id, COUNT);
  assert.equal(store.data.nextSpaceId, COUNT + 1, 'nextSpaceId 應重建為最大 id + 1');
  assert.equal(store.nextLabel(1), 'p2');
});
