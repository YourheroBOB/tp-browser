// tests/test_fmb_store_ledger.test.mjs
// daemon/store.js（TaskSpace ledger）的邊界與持久化測試。
// 所有檔案都寫在 mkdtempSync(tmpdir()) 內，測試結束即刪除；不連網、不含任何真實憑證或個資。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../daemon/store.js';

function tmpDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('create：寫入 ledger，預設 p1 為未綁定的佔位分頁', (t) => {
  const file = join(tmpDir(t), 'state', 'store.json'); // 父目錄不存在，驗證 persist 會遞迴建立
  const store = new Store(file);
  assert.deepEqual(store.list(), []);
  assert.equal(store.get(1), null);

  const space = store.create({ name: 'demo' });
  assert.equal(space.id, 1);
  assert.equal(space.name, 'demo');
  assert.equal(space.profileId, 'agent');
  assert.equal(space.ownership, 'agent');
  assert.equal(space.state, 'active');
  assert.equal(space.activeTargetId, null);
  assert.deepEqual(space.pages, { p1: { targetId: null, openedBy: 'agent', title: '', url: '' } });
  assert.match(space.createdAt, /^\d{4}-\d{2}-\d{2}T/);

  assert.equal(existsSync(file), true);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.nextSpaceId, 2);
  assert.equal(raw.spaces['1'].name, 'demo');
  assert.deepEqual(raw.spaces['1'].pages, { p1: { targetId: null, openedBy: 'agent', title: '', url: '' } });
});

test('nextLabel：建立後第一次回傳 p2 並遞增；未知空間回 p?', (t) => {
  const file = join(tmpDir(t), 'store.json');
  const store = new Store(file);
  store.create({ name: 'a' });
  assert.equal(store.nextLabel(1), 'p2');
  assert.equal(store.nextLabel(1), 'p3');
  assert.equal(store.nextLabel(999), 'p?');
});

test('重新載入：nextSpaceId／labelSeq／分頁資料都會保留，不會覆蓋既有空間', (t) => {
  const file = join(tmpDir(t), 'store.json');
  const first = new Store(file);
  first.create({ name: 'keep' });
  first.bindPage(1, 'p1', 'T-1', 'agent');
  first.setPage(1, 'p1', { title: '測試標題', url: 'http://127.0.0.1:8765/' });
  first.nextLabel(1);

  const second = new Store(file);
  assert.equal(second.list().length, 1);
  assert.equal(second.get(1).pages.p1.targetId, 'T-1');
  assert.equal(second.get(1).pages.p1.title, '測試標題');
  assert.equal(second.get(1).pages.p1.url, 'http://127.0.0.1:8765/');

  const created = second.create({ name: 'second' });
  assert.equal(created.id, 2); // nextSpaceId 接續
  assert.equal(second.nextLabel(1), 'p3'); // labelSeq 也接續
});

test('損壞的 ledger JSON：載入失敗時從空白狀態開始，且不覆寫原檔', (t) => {
  const dir = tmpDir(t);
  const file = join(dir, 'store.json');
  const broken = '{ "spaces": { "1": ';
  writeFileSync(file, broken);

  const errors = t.mock.method(console, 'error', () => {});
  const store = new Store(file);
  assert.equal(errors.mock.callCount(), 1);
  assert.deepEqual(store.list(), []);
  assert.equal(store.get(1), null);
  assert.equal(readFileSync(file, 'utf8'), broken); // 讀檔失敗不應立刻覆寫

  const space = store.create({ name: 'recovered' });
  assert.equal(space.id, 1);
});

test('bindPage／addPage：覆寫同名 label 並重設 title／url', (t) => {
  const file = join(tmpDir(t), 'store.json');
  const store = new Store(file);
  store.create({ name: 'a' });
  store.setPage(1, 'p1', { title: '舊標題', url: 'http://127.0.0.1:8765/old' });

  store.bindPage(1, 'p1', 'T-9', 'human');
  assert.deepEqual(store.get(1).pages.p1, { targetId: 'T-9', openedBy: 'human', title: '', url: '' });

  store.addPage(1, 'p2', 'T-10');
  assert.deepEqual(store.get(1).pages.p2, { targetId: 'T-10', openedBy: 'agent', title: '', url: '' });
});

test('未知空間：bindPage／addPage 丟錯，setPage／removePage 為安全 no-op', (t) => {
  const file = join(tmpDir(t), 'store.json');
  const store = new Store(file);
  store.create({ name: 'x' });

  assert.throws(() => store.bindPage(42, 'p1', 'T-x'), /unknown space 42/);
  assert.throws(() => store.addPage(42, 'p1', 'T-x'), /unknown space 42/);
  assert.doesNotThrow(() => store.setPage(42, 'p1', { title: 'nope' }));
  assert.doesNotThrow(() => store.removePage(42, 'p1'));
  assert.equal(store.get(42), null);

  // 既有空間但不存在該 label：也要是 no-op，不能長出幽靈分頁
  store.setPage(1, 'p9', { title: 'ghost' });
  store.removePage(1, 'p9');
  assert.deepEqual(Object.keys(store.get(1).pages), ['p1']);
});

test('removePage 只刪指定分頁；deleteSpace 後 get 回 null 且檔案同步', (t) => {
  const file = join(tmpDir(t), 'store.json');
  const store = new Store(file);
  store.create({ name: 'a' });
  store.addPage(1, 'p2', 'T-2');

  store.removePage(1, 'p2');
  assert.deepEqual(Object.keys(store.get(1).pages), ['p1']);

  store.deleteSpace(1);
  assert.equal(store.get(1), null);
  assert.deepEqual(store.list(), []);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(raw.spaces, {});
  assert.doesNotThrow(() => store.deleteSpace(1)); // 冪等
});

test('persist：原子寫入後不遺留 .tmp 暫存檔', (t) => {
  const dir = tmpDir(t);
  const file = join(dir, 'store.json');
  const store = new Store(file);
  store.create({ name: 'a' });
  store.setPage(1, 'p1', { url: 'http://127.0.0.1:8765/' });

  const leftovers = readdirSync(dir).filter((name) => name.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});

test(
  '載入缺少 nextSpaceId 的舊 ledger 時應能重建可用 id',
  (t) => {
    const dir = tmpDir(t);
    const file = join(dir, 'store.json');
    writeFileSync(file, JSON.stringify({ spaces: {}, labelSeq: {} }));
    const store = new Store(file);
    const space = store.create({ name: 'legacy' });
    assert.equal(Number.isInteger(space.id), true);
    assert.equal(store.get(1).name, 'legacy');
    // 寫回的 ledger 不得出現 "NaN" 鍵，且 nextSpaceId 已正規化成正整數。
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(Object.hasOwn(saved.spaces, 'NaN'), false);
    assert.equal(Number.isInteger(saved.nextSpaceId) && saved.nextSpaceId > 1, true);
  },
);
