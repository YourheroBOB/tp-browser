// tests/test_fmb_edge_store.test.mjs
// 邊界與錯誤情境：daemon/store.js 的 ledger 損壞、原子寫入失敗 fallback、
// 未知 spaceId／分頁標籤的 no-op 語意、以及字串／數字 id 混用。
//
// 只使用 mkdtempSync(tmpdir()) 建立的暫存目錄；不讀寫 repo 以外的固定路徑，
// 也不連線任何服務。測試資料一律使用 FAKE_TARGET 這類明顯假值。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../daemon/store.js';

function tempLedger(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tp-fmb-edge-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file: join(dir, 'ledger.json') };
}

test('損壞的 ledger JSON：啟動為空 ledger、記錄錯誤、之後仍可正常寫入', (t) => {
  const { file } = tempLedger(t);
  writeFileSync(file, '{ this is not json', 'utf8');

  const messages = [];
  const originalError = console.error;
  console.error = (...args) => messages.push(args.map(String).join(' '));
  let store;
  try {
    store = new Store(file);
  } finally {
    console.error = originalError;
  }

  // 壞檔不應讓 daemon 起不來，而是退回全新 ledger。
  assert.deepEqual(store.list(), []);
  assert.equal(store.data.nextSpaceId, 1);
  assert.ok(
    messages.some((m) => m.includes('store load failed')),
    `預期記錄載入失敗訊息，實際：${messages.join(' | ') || '(無)'}`,
  );

  // 退回空 ledger 後仍必須能落盤（避免「壞檔 → 永久無法寫入」）。
  const space = store.create({ name: 'edge-corrupt' });
  assert.equal(space.id, 1);
  const persisted = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(persisted.spaces['1'].name, 'edge-corrupt');
});

test('原子寫入失敗時仍會落盤（persist fallback），不會靜默遺失資料', (t) => {
  const { file } = tempLedger(t);
  const store = new Store(file);

  // 讓 `${file}.${pid}.tmp` 變成目錄：writeFileSync(tmp) 會失敗，
  // 迫使 persist() 走 catch 分支直接覆寫主檔。
  mkdirSync(`${file}.${process.pid}.tmp`);

  store.create({ name: 'edge-fallback' });
  const persisted = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(persisted.spaces['1'].name, 'edge-fallback');
  assert.equal(persisted.nextSpaceId, 2);
});

test('未知 spaceId：nextLabel 回 "p?"，setPage／removePage／deleteSpace 為 no-op，bindPage／addPage 丟錯', (t) => {
  const { file } = tempLedger(t);
  const store = new Store(file);

  assert.equal(store.get(999), null);
  assert.equal(store.nextLabel(999), 'p?');
  // nextLabel 對未知空間提早 return，不應產生任何檔案寫入。
  assert.equal(existsSync(file), false, '未知空間的 nextLabel 不應觸發 persist');

  assert.doesNotThrow(() => store.setPage(999, 'p1', { title: 'ghost' }));
  assert.doesNotThrow(() => store.removePage(999, 'p1'));
  assert.doesNotThrow(() => store.deleteSpace(999));

  assert.throws(() => store.bindPage(999, 'p1', 'FAKE_TARGET'), /unknown space 999/);
  assert.throws(() => store.addPage(999, 'p1', 'FAKE_TARGET'), /unknown space 999/);
});

test('既有 ledger：nextSpaceId 續號，且字串與數字 id 等價（避免重複建立）', (t) => {
  const { file } = tempLedger(t);
  writeFileSync(file, JSON.stringify({
    nextSpaceId: 7,
    labelSeq: { 5: 2, 6: 1 },
    spaces: {
      5: {
        id: 5, name: 'kept', profileId: 'agent', ownership: 'agent', state: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        pages: { p1: { targetId: 'FAKE_TARGET', openedBy: 'agent', title: 'kept', url: 'http://127.0.0.1/' } },
        activeTargetId: 'FAKE_TARGET',
      },
      6: {
        id: 6, name: 'idle', profileId: 'agent', ownership: 'agent', state: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        pages: { p1: { targetId: null, openedBy: 'agent', title: '', url: '' } },
        activeTargetId: null,
      },
    },
  }), 'utf8');

  const store = new Store(file);
  assert.equal(store.list().length, 2);
  assert.equal(store.get(5), store.get('5'));
  assert.equal(store.get('5').name, 'kept');

  // labelSeq[5] = 2 → 下一個標籤應為 p3（不是重新從 p1 開始）。
  assert.equal(store.nextLabel(5), 'p3');

  const created = store.create({ name: 'fresh' });
  assert.equal(created.id, 7);

  store.deleteSpace('5');
  assert.equal(store.get(5), null);
  assert.equal(store.list().length, 2); // 6 與 7
});

test('setPage 對不存在的分頁標籤是 no-op，不會憑空新增分頁', (t) => {
  const { file } = tempLedger(t);
  const store = new Store(file);
  const space = store.create({ name: 'edge-setpage' });

  assert.deepEqual(Object.keys(store.get(space.id).pages), ['p1']);
  store.setPage(space.id, 'p9', { title: 'ghost' });
  assert.deepEqual(Object.keys(store.get(space.id).pages), ['p1']);

  store.setPage(space.id, 'p1', { title: 'ok' });
  assert.equal(store.get(space.id).pages.p1.title, 'ok');
  assert.equal(store.get(space.id).pages.p1.targetId, null);
});
