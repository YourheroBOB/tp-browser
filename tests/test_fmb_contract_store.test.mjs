// tests/test_fmb_contract_store.test.mjs
// daemon/store.js 公開介面「契約測試」：鎖 Store 的方法面、create() 回傳的 ledger schema、
// 錯誤訊息格式與持久化檔結構。有別於 tests/test_fmb_store.test.mjs 的行為測試，
// 本檔只鎖「介面形狀」。暫存檔一律寫在 mkdtempSync(tmpdir()) 內並於 after() 清除；零網路、零依賴。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as storeMod from '../daemon/store.js';
import { Store } from '../daemon/store.js';

const dir = mkdtempSync(join(tmpdir(), 'fmb-contract-store-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

const newLedger = () => join(dir, `ledger-${Math.random().toString(36).slice(2)}.json`);

test('contract/store：唯一匯出是 Store；必須以 new 呼叫', () => {
  assert.deepEqual(Object.keys(storeMod).sort(), ['Store']);
  assert.equal(typeof Store, 'function');
  assert.throws(() => Store(newLedger()), TypeError);
});

test('contract/store：Store.prototype 的公開方法面', () => {
  const names = Object.getOwnPropertyNames(Store.prototype)
    .filter((n) => n !== 'constructor')
    .sort();
  assert.deepEqual(names, [
    'addPage', 'bindPage', 'create', 'deleteSpace', 'get',
    'list', 'load', 'nextLabel', 'persist', 'removePage', 'setPage',
  ]);
});

test('contract/store：新建構時 data 為空白 ledger { nextSpaceId, labelSeq, spaces }', () => {
  const s = new Store(newLedger());
  assert.deepEqual(s.data, { nextSpaceId: 1, labelSeq: {}, spaces: {} });
});

test('contract/store：create() 回傳空間物件的鍵集合與預設值契約', () => {
  const s = new Store(newLedger());
  const space = s.create({ name: 'contract-demo' });
  assert.deepEqual(Object.keys(space).sort(), [
    'activeTargetId', 'createdAt', 'id', 'name', 'ownership', 'pages', 'profileId', 'state',
  ]);
  assert.equal(space.id, 1);
  assert.equal(space.name, 'contract-demo');
  assert.equal(space.profileId, 'agent');
  assert.equal(space.ownership, 'agent');
  assert.equal(space.state, 'active');
  assert.equal(space.activeTargetId, null);
  assert.equal(typeof space.createdAt, 'string');
  assert.ok(Number.isFinite(Date.parse(space.createdAt)), 'createdAt 須為可解析的 ISO 字串');
  assert.deepEqual(Object.keys(space.pages).sort(), ['p1']);
  assert.deepEqual(Object.keys(space.pages.p1).sort(), ['openedBy', 'targetId', 'title', 'url']);
  assert.deepEqual(space.pages.p1, { targetId: null, openedBy: 'agent', title: '', url: '' });
});

test('contract/store：create() 的 profileId 為可選參數（預設 agent，可覆寫）；id 循序遞增', () => {
  const s = new Store(newLedger());
  assert.equal(s.create({ name: 'a' }).id, 1);
  assert.equal(s.create({ name: 'b' }).id, 2);
  assert.equal(s.create({ name: 'c', profileId: 'human' }).profileId, 'human');
});

test('contract/store：list() 回傳陣列；get() 對未知 id 回傳 null', () => {
  const s = new Store(newLedger());
  s.create({ name: 'a' });
  s.create({ name: 'b' });
  assert.ok(Array.isArray(s.list()));
  assert.equal(s.list().length, 2);
  assert.equal(s.get(1)?.name, 'a');
  assert.equal(s.get(9999), null);
});

test('contract/store：nextLabel() 的標籤格式契約（p2 起跳、未知空間回 "p?"）', () => {
  const s = new Store(newLedger());
  const space = s.create({ name: 'a' });
  assert.equal(s.nextLabel(space.id), 'p2');
  assert.equal(s.nextLabel(space.id), 'p3');
  assert.equal(s.nextLabel(9999), 'p?');
});

test('contract/store：bindPage/addPage 對未知空間拋 Error "unknown space <id>"', () => {
  const s = new Store(newLedger());
  assert.throws(() => s.bindPage(9999, 'p1', 'T1'), (e) => e instanceof Error && e.message === 'unknown space 9999');
  assert.throws(() => s.addPage(9999, 'p1', 'T1'), (e) => e instanceof Error && e.message === 'unknown space 9999');
});

test('contract/store：setPage/removePage 對未知空間或標籤為安全 no-op（不拋錯）', () => {
  const s = new Store(newLedger());
  const space = s.create({ name: 'a' });
  assert.doesNotThrow(() => s.setPage(9999, 'p1', { title: 'x' }));
  assert.doesNotThrow(() => s.setPage(space.id, 'nope', { title: 'x' }));
  assert.equal(s.get(space.id).pages.p1.title, '');
  assert.doesNotThrow(() => s.removePage(9999, 'p1'));
});

test('contract/store：deleteSpace() 從 ledger 移除空間', () => {
  const s = new Store(newLedger());
  const space = s.create({ name: 'a' });
  s.deleteSpace(space.id);
  assert.equal(s.get(space.id), null);
  assert.equal(s.list().length, 0);
});

test('contract/store：持久化檔為 JSON，schema 鍵集合 { labelSeq, nextSpaceId, spaces }，重載可還原', () => {
  const file = newLedger();
  const s = new Store(file);
  const space = s.create({ name: 'persist-demo' });
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(raw).sort(), ['labelSeq', 'nextSpaceId', 'spaces']);
  const reloaded = new Store(file);
  assert.equal(reloaded.get(space.id)?.name, 'persist-demo');
  assert.equal(reloaded.create({ name: 'next' }).id, 2, 'nextSpaceId 須跨重載延續');
});

test('contract/store：ledger 檔損毀時以全新空白 ledger 啟動（不拋錯）', () => {
  const file = newLedger();
  writeFileSync(file, '<<<not-json>>>', 'utf8');
  const s = new Store(file); // 僅於 stderr 印警告
  assert.deepEqual(s.data, { nextSpaceId: 1, labelSeq: {}, spaces: {} });
});
