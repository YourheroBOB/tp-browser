// tests/fmb_w6_s02_store_proto_keys.test.mjs
// 回歸測試（wave w6 / s02）：daemon/store.js 以 Object.prototype 繼承鍵當 space id 或
// 分頁 label 時的誤判與原型污染。
//   B1 get('__proto__') 原本回傳 Object.prototype，get('constructor') 回傳 Object 函式，
//      兩者都不是 null（非自有鍵被當成存在的空間）。
//   B2 setPage(spaceId, '__proto__', patch) 原本 Object.assign 到 Object.prototype，
//      造成全域原型污染 ({}).polluted === 1。
//   B3 bindPage/addPage 用 '__proto__' 當 label 會改掉 pages 物件的原型，persist 後
//      該分頁（連同既有分頁）在重載時不見。
//   B4 nextLabel('toString') 原本寫出一筆孤兒 labelSeq 記錄（ledger 只增不減）。
//
// 測試邊界：所有檔案讀寫都在 mkdtempSync(tmpdir()) 內，結束即刪除；零網路、零正式服務
// 連線；示例值一律使用 FAKE_VALUE_FOR_TEST 這類明顯假字串。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../daemon/store.js';

// 污染探針：用一個不可能撞名的一般屬性名稱，確認沒有東西被寫進全域原型。
const POLLUTED = 'fmbW6S02Polluted';
const INHERITED_KEYS = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf'];

function tempFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-w6-s02-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'ledger.json');
}

function assertClean() {
  assert.equal(Object.prototype[POLLUTED], undefined, 'Object.prototype 不得被污染');
  assert.equal(({})[POLLUTED], undefined, '一般物件不得看到被污染的屬性');
}

test('get：繼承鍵（__proto__／constructor／…）一律視為不存在，回傳 null', (t) => {
  const store = new Store(tempFile(t));

  // 尚未建立任何空間時就必須是 null，不能是 Object.prototype 或 Object 函式。
  for (const key of INHERITED_KEYS) {
    assert.equal(store.get(key), null, `空 ledger 的 get(${key}) 必須是 null`);
  }

  const space = store.create({ name: 'a' });
  assert.equal(store.get(space.id), space);
  assert.equal(store.get(String(space.id)), space, '數字與字串 id 必須等價');
  assert.equal(store.get(9999), null);

  for (const key of INHERITED_KEYS) {
    assert.equal(store.get(key), null, `有空間時 get(${key}) 仍必須是 null`);
  }
  assertClean();
});

test('setPage：__proto__／constructor 不會污染全域原型，也不算既有分頁', (t) => {
  const file = tempFile(t);
  const store = new Store(file);
  const space = store.create({ name: 'victim' });
  const before = readFileSync(file, 'utf8');

  store.setPage(space.id, '__proto__', { [POLLUTED]: 'FAKE_VALUE_FOR_TEST' });
  assertClean();
  store.setPage(space.id, 'constructor', { [POLLUTED]: 'FAKE_VALUE_FOR_TEST' });
  assertClean();
  assert.equal(Object[POLLUTED], undefined, 'Object 函式本身也不得被改');

  const pages = store.get(space.id).pages;
  assert.equal(Object.hasOwn(pages, '__proto__'), false, 'setPage 不得憑空建立 __proto__ 自有鍵');
  assert.equal(Object.getPrototypeOf(pages), Object.prototype, 'setPage 不得改動 pages 的原型');
  assert.deepEqual(Object.keys(pages), ['p1']);
  assert.equal(readFileSync(file, 'utf8'), before, '被拒絕的 setPage 不應改寫 ledger');

  // 正常 label 仍必須是 merge 語意
  store.setPage(space.id, 'p1', { title: 'ok' });
  assert.equal(store.get(space.id).pages.p1.title, 'ok');
  assert.equal(store.get(space.id).pages.p1.openedBy, 'agent');
});

test('bindPage：非法 label 丟錯且不改原型、不落盤；合法 label 重載後仍在', (t) => {
  const file = tempFile(t);
  const store = new Store(file);
  const space = store.create({ name: 'a' });
  const before = readFileSync(file, 'utf8');

  for (const label of ['__proto__', 'constructor', 'toString']) {
    assert.throws(
      () => store.bindPage(space.id, label, 'T1-FAKE_VALUE_FOR_TEST'),
      /page label/,
      `bindPage(${label}) 必須丟錯`,
    );
  }
  assertClean();

  const pages = store.get(space.id).pages;
  assert.equal(Object.getPrototypeOf(pages), Object.prototype, 'pages 的原型不得被換掉');
  assert.deepEqual(Object.keys(pages), ['p1']);
  assert.equal(pages.p1.targetId, null);
  assert.equal(readFileSync(file, 'utf8'), before, '拋錯路徑不得寫檔');

  // 合法 label：綁定後重新載入仍必須看得到（不會因為原型被動過而消失）
  store.bindPage(space.id, 'p2', 'T2-FAKE_VALUE_FOR_TEST', 'human');
  const reloaded = new Store(file);
  assert.deepEqual(Object.keys(reloaded.get(space.id).pages).sort(), ['p1', 'p2']);
  assert.deepEqual(reloaded.get(space.id).pages.p2, {
    targetId: 'T2-FAKE_VALUE_FOR_TEST', openedBy: 'human', title: '', url: '',
  });
});

test('addPage：非法 label 丟錯；既有分頁不得因原型被動過而消失', (t) => {
  const file = tempFile(t);
  const store = new Store(file);
  const space = store.create({ name: 'a' });
  const before = readFileSync(file, 'utf8');

  for (const label of ['__proto__', 'constructor', 'valueOf']) {
    assert.throws(
      () => store.addPage(space.id, label, 'T1-FAKE_VALUE_FOR_TEST'),
      /page label/,
      `addPage(${label}) 必須丟錯`,
    );
  }
  assertClean();
  assert.equal(readFileSync(file, 'utf8'), before, '拋錯路徑不得寫檔');
  assert.equal(Object.getPrototypeOf(store.get(space.id).pages), Object.prototype);

  store.addPage(space.id, 'p3', 'T3-FAKE_VALUE_FOR_TEST');
  const reloaded = new Store(file);
  assert.deepEqual(Object.keys(reloaded.get(space.id).pages).sort(), ['p1', 'p3']);
  assert.equal(reloaded.get(space.id).pages.p3.targetId, 'T3-FAKE_VALUE_FOR_TEST');
});

test('nextLabel：繼承鍵不得生出孤兒 labelSeq，且不寫檔', (t) => {
  const file = tempFile(t);
  const store = new Store(file);
  const space = store.create({ name: 'a' });
  const before = readFileSync(file, 'utf8');

  for (const key of ['toString', '__proto__', 'constructor', 'valueOf']) {
    assert.equal(store.nextLabel(key), 'p?', `nextLabel(${key}) 必須回 p?`);
  }
  assert.equal(readFileSync(file, 'utf8'), before, '未知空間的 nextLabel 不得寫檔');
  assert.equal(Object.hasOwn(store.data.labelSeq, 'toString'), false, 'labelSeq 不得長出孤兒鍵');

  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(onDisk.labelSeq), [String(space.id)]);

  // 合法空間的標籤序號不受影響
  assert.equal(store.nextLabel(space.id), 'p2');
});

test('removePage：繼承鍵是 no-op，不動原型、不清 activeTargetId、不寫檔', (t) => {
  const file = tempFile(t);
  const store = new Store(file);
  const space = store.create({ name: 'a' });
  store.bindPage(space.id, 'p1', 'T1-FAKE_VALUE_FOR_TEST');
  store.get(space.id).activeTargetId = 'T1-FAKE_VALUE_FOR_TEST';
  store.persist();
  const before = readFileSync(file, 'utf8');

  for (const label of ['__proto__', 'constructor', 'toString']) {
    assert.doesNotThrow(() => store.removePage(space.id, label), `removePage(${label}) 必須是安全 no-op`);
  }

  assert.equal(typeof Object.prototype.toString, 'function', 'Object.prototype.toString 不得被刪掉');
  assert.equal(readFileSync(file, 'utf8'), before, 'no-op 不得改寫 ledger');
  assert.deepEqual(Object.keys(store.get(space.id).pages), ['p1']);
  assert.equal(store.get(space.id).activeTargetId, 'T1-FAKE_VALUE_FOR_TEST');
});

test('整併：一連串 __proto__／constructor 呼叫後 ledger 重載仍正確、原型保持乾淨', (t) => {
  const file = tempFile(t);
  const store = new Store(file);
  const space = store.create({ name: 'victim' });

  assert.equal(store.get('__proto__'), null);
  assert.equal(store.get('constructor'), null);
  store.setPage(space.id, '__proto__', { [POLLUTED]: 1 });
  assert.throws(() => store.bindPage(space.id, '__proto__', 'T1-FAKE_VALUE_FOR_TEST'), /page label/);
  assert.throws(() => store.addPage(space.id, 'constructor', 'T1-FAKE_VALUE_FOR_TEST'), /page label/);
  assert.doesNotThrow(() => store.removePage(space.id, 'constructor'));
  assert.equal(store.nextLabel('toString'), 'p?');
  assertClean();

  store.bindPage(space.id, 'p2', 'T2-FAKE_VALUE_FOR_TEST');
  store.setPage(space.id, 'p2', { title: 'ok', url: 'http://127.0.0.1:0/' });

  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(onDisk.spaces), [String(space.id)]);
  assert.deepEqual(Object.keys(onDisk.spaces[space.id].pages).sort(), ['p1', 'p2']);
  assert.equal(Object.hasOwn(onDisk.spaces[space.id].pages, '__proto__'), false);
  assert.deepEqual(Object.keys(onDisk.labelSeq), [String(space.id)]);

  const reloaded = new Store(file);
  assert.deepEqual(reloaded.data, store.data);
  assert.equal(reloaded.get(space.id).pages.p2.targetId, 'T2-FAKE_VALUE_FOR_TEST');
  assert.equal(reloaded.get(space.id).pages.p2.title, 'ok');
  assert.equal(reloaded.get('toString'), null);
  assert.equal(Object.getPrototypeOf(reloaded.get(space.id).pages), Object.prototype);
  assertClean();
});
