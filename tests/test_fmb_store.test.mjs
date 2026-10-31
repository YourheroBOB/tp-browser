// 針對 daemon/store.js（TaskSpace ledger JSON 持久化）的行為與邊界測試。
// 全程使用 os.tmpdir() 下的暫存目錄，不讀寫 repo 以外的固定路徑。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

import { Store } from '../daemon/store.js';

function storePath(t, name = 'store.json') {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'data', name);
}

function captureConsoleError() {
  const calls = [];
  const original = console.error;
  console.error = (...args) => calls.push(args.map((a) => String(a)).join(' '));
  return { calls, restore: () => { console.error = original; } };
}

test('全新 Store 是空的，且建構時不會寫檔案', (t) => {
  const file = storePath(t);
  const s = new Store(file);
  assert.deepEqual(s.list(), []);
  assert.equal(s.get(1), null);
  assert.equal(existsSync(file), false, 'load() 不應主動建立 ledger 檔');
  assert.equal(s.data.nextSpaceId, 1);
});

test('create() 建立預設 p1 分頁、agent 所有權，並立即落地', (t) => {
  const file = storePath(t);
  const s = new Store(file);
  const space = s.create({ name: 'demo' });

  assert.equal(space.id, 1);
  assert.equal(space.name, 'demo');
  assert.equal(space.profileId, 'agent');
  assert.equal(space.ownership, 'agent');
  assert.equal(space.state, 'active');
  assert.equal(space.activeTargetId, null);
  assert.deepEqual(space.pages.p1, { targetId: null, openedBy: 'agent', title: '', url: '' });
  assert.match(space.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.equal(Number.isNaN(Date.parse(space.createdAt)), false);

  assert.ok(existsSync(file), 'create() 應持久化');
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(onDisk.nextSpaceId, 2);
  assert.equal(onDisk.spaces[1].name, 'demo');
  assert.equal(onDisk.labelSeq[1], 1);
});

test('create() 可指定 profileId，且 id 遞增', (t) => {
  const s = new Store(storePath(t));
  const a = s.create({ name: 'a', profileId: 'work' });
  const b = s.create({ name: 'b' });
  assert.equal(a.profileId, 'work');
  assert.equal(b.profileId, 'agent');
  assert.equal(a.id, 1);
  assert.equal(b.id, 2);
  assert.equal(s.list().length, 2);
});

test('nextLabel() 從 p2 起算，且跨重啟連續遞增', (t) => {
  const file = storePath(t);
  const s = new Store(file);
  const space = s.create({ name: 'x' });

  assert.equal(s.nextLabel(space.id), 'p2');
  assert.equal(s.nextLabel(space.id), 'p3');

  const reloaded = new Store(file);
  assert.equal(reloaded.nextLabel(space.id), 'p4');
});

test('nextLabel() 對不存在的 space 回傳 p? 且不寫檔', (t) => {
  const file = storePath(t);
  const s = new Store(file);
  assert.equal(s.nextLabel(42), 'p?');
  assert.equal(existsSync(file), false);
});

test('setPage / bindPage / addPage / removePage 更新分頁資料', (t) => {
  const s = new Store(storePath(t));
  const space = s.create({ name: 'x' });

  s.setPage(space.id, 'p1', { url: 'http://127.0.0.1:8890/p1', title: 'P1' });
  const p1 = s.get(space.id).pages.p1;
  assert.equal(p1.url, 'http://127.0.0.1:8890/p1');
  assert.equal(p1.title, 'P1');
  // patch 是 merge 語意，未指定的欄位要保留
  assert.equal(p1.openedBy, 'agent');
  assert.equal(p1.targetId, null);

  s.bindPage(space.id, 'p2', 'TARGET-1', 'human');
  assert.deepEqual(s.get(space.id).pages.p2, {
    targetId: 'TARGET-1', openedBy: 'human', title: '', url: '',
  });

  s.addPage(space.id, 'p3', 'TARGET-2');
  assert.deepEqual(s.get(space.id).pages.p3, {
    targetId: 'TARGET-2', openedBy: 'agent', title: '', url: '',
  });

  s.removePage(space.id, 'p1');
  assert.equal(s.get(space.id).pages.p1, undefined);
  assert.ok(s.get(space.id).pages.p2, '移除 p1 不應影響其他分頁');
});

test('setPage / removePage 對未知 space 或未知 label 是 no-op（不拋錯）', (t) => {
  const s = new Store(storePath(t));
  assert.doesNotThrow(() => s.setPage(999, 'p1', { url: 'x' }));
  assert.doesNotThrow(() => s.removePage(999, 'p1'));

  const space = s.create({ name: 'x' });
  assert.doesNotThrow(() => s.setPage(space.id, 'pX', { url: 'x' }));
  assert.equal(s.get(space.id).pages.pX, undefined);
  assert.doesNotThrow(() => s.removePage(space.id, 'pX'));
});

test('bindPage / addPage 對未知 space 會明確拋錯', (t) => {
  const s = new Store(storePath(t));
  assert.throws(() => s.bindPage(404, 'p1', 'TARGET-X'), /unknown space 404/);
  assert.throws(() => s.addPage(404, 'p1', 'TARGET-X'), /unknown space 404/);
});

test('deleteSpace() 之後 get 回 null，重啟後也不會復活、id 不重用', (t) => {
  const file = storePath(t);
  const s = new Store(file);
  const space = s.create({ name: 'gone' });
  s.deleteSpace(space.id);
  assert.equal(s.get(space.id), null);
  assert.deepEqual(s.list(), []);

  const reloaded = new Store(file);
  assert.equal(reloaded.get(space.id), null);
  assert.deepEqual(reloaded.list(), []);

  const next = reloaded.create({ name: 'next' });
  assert.equal(next.id, 2, 'nextSpaceId 應持續遞增，避免 targetId 對應錯亂');
});

test('persist() 以 tmp 檔原子替換，不留下殘檔', (t) => {
  const file = storePath(t);
  const s = new Store(file);
  s.create({ name: 'a' });
  s.persist();
  s.persist();
  const files = readdirSync(dirname(file));
  assert.deepEqual(files, ['store.json']);
});

test('損壞的 ledger JSON 會回退成空 ledger 並記錄錯誤，不讓 daemon 起不來', (t) => {
  const file = storePath(t);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '{ this is not valid json', 'utf8');

  const log = captureConsoleError();
  let s;
  try {
    s = new Store(file);
  } finally {
    log.restore();
  }

  assert.deepEqual(s.list(), []);
  assert.equal(s.data.nextSpaceId, 1);
  assert.ok(
    log.calls.some((line) => line.includes('store load failed')),
    `應記錄載入失敗，實際輸出：${JSON.stringify(log.calls)}`,
  );
});

test('load() 會沿用既有 nextSpaceId（ledger 可被外部預先寫入）', (t) => {
  const file = storePath(t);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ nextSpaceId: 5, labelSeq: {}, spaces: {} }), 'utf8');

  const s = new Store(file);
  const space = s.create({ name: 'a' });
  assert.equal(space.id, 5);
});

test('已知健壯性缺口：load() 直接覆蓋 data，不驗證 shape 也不補預設值', (t) => {
  // 這裡只固定「現況」，不是期望行為。載入的 JSON 若缺少 spaces/labelSeq
  // （例如手動編輯或降級後的回滾），Store 會在各方法內拋 TypeError。
  // 若日後 load() 改為與預設值 merge，本測試需同步改寫。
  const file = storePath(t);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '{}', 'utf8');

  const s = new Store(file);
  assert.throws(() => s.list(), TypeError);
  assert.throws(() => s.get(1), TypeError);
  assert.throws(() => s.create({ name: 'x' }), TypeError);
});
