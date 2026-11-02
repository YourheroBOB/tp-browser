// 回歸：removePage 必須在「被刪分頁的 targetId === activeTargetId」時清掉作用中目標，
// 且不得把未綁定分頁（targetId == null）、其他分頁、或原型鏈上的鍵名當成作用中分頁。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../daemon/store.js';

function openStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-regress-active-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'ledger.json');
  return { file, store: new Store(file) };
}

function persisted(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

test('removePage 只在被刪分頁持有 activeTargetId 時清掉它', (t) => {
  const { file, store } = openStore(t);
  const space = store.create({ name: 'ride' });
  store.bindPage(space.id, 'p1', 'T-live');
  store.addPage(space.id, 'p2', 'T-side');
  store.get(space.id).activeTargetId = 'T-live';

  store.removePage(space.id, 'p2');
  assert.equal(store.get(space.id).activeTargetId, 'T-live');
  assert.equal(store.get(space.id).pages.p1.targetId, 'T-live');
  assert.equal(Object.hasOwn(store.get(space.id).pages, 'p2'), false);

  store.addPage(space.id, 'p2', 'T-side');
  store.removePage(space.id, 'p1');
  assert.equal(store.get(space.id).activeTargetId, null);
  assert.equal(Object.hasOwn(store.get(space.id).pages, 'p1'), false);
  assert.equal(store.get(space.id).pages.p2.targetId, 'T-side');

  const raw = persisted(file);
  const saved = raw.spaces[String(space.id)];
  assert.equal(Object.hasOwn(saved, 'activeTargetId'), true);
  assert.equal(saved.activeTargetId, null);
  assert.equal(Object.hasOwn(saved.pages, 'p1'), false);
  assert.equal(saved.pages.p2.targetId, 'T-side');

  store.removePage(space.id, 'p1');
  assert.equal(store.get(space.id).activeTargetId, null);
});

test('移除 targetId 為 null 的佔位分頁不得清掉另一個 activeTargetId', (t) => {
  const { file, store } = openStore(t);
  const space = store.create({ name: 'ride' });
  store.get(space.id).activeTargetId = 'T-keep';

  store.removePage(space.id, 'p1');
  assert.equal(store.get(space.id).activeTargetId, 'T-keep');
  assert.equal(Object.hasOwn(store.get(space.id).pages, 'p1'), false);

  store.addPage(space.id, 'p9', 'T-other');
  store.removePage(space.id, 'p9');
  assert.equal(store.get(space.id).activeTargetId, 'T-keep');
  assert.equal(persisted(file).spaces[String(space.id)].activeTargetId, 'T-keep');
});

test('同一 target 仍掛在其他分頁時，移除作用中的那一頁仍要清掉 activeTargetId', (t) => {
  const { file, store } = openStore(t);
  const space = store.create({ name: 'ride' });
  store.bindPage(space.id, 'p1', 'T-same');
  store.addPage(space.id, 'p2', 'T-same');
  store.get(space.id).activeTargetId = 'T-same';

  store.removePage(space.id, 'p1');
  assert.equal(store.get(space.id).activeTargetId, null);
  assert.equal(store.get(space.id).pages.p2.targetId, 'T-same');
  assert.equal(persisted(file).spaces[String(space.id)].activeTargetId, null);
});

test('字串 targetId 不得用寬鬆相等清掉數字 activeTargetId', (t) => {
  const { file, store } = openStore(t);
  const space = store.create({ name: 'ride' });
  store.bindPage(space.id, 'p1', '42');
  store.get(space.id).activeTargetId = 42;

  store.removePage(space.id, 'p1');
  assert.equal(store.get(space.id).activeTargetId, 42);
  assert.equal(persisted(file).spaces[String(space.id)].activeTargetId, 42);
  assert.equal(Object.hasOwn(store.get(space.id).pages, 'p1'), false);
});

test('未知空間、缺漏標籤與原型鍵名都不得改寫分頁', (t) => {
  const { store } = openStore(t);
  const space = store.create({ name: 'ride' });
  try {
    assert.doesNotThrow(() => store.removePage(424242, 'p1'));
    assert.equal(store.get(424242), null);
    assert.doesNotThrow(() => {
      store.removePage(space.id, 'missing');
      store.removePage(space.id, '__proto__');
      store.removePage(space.id, 'constructor');
      store.removePage(space.id, 'toString');
    });
    assert.equal(store.get(space.id).pages.p1.targetId, null);
    assert.equal(Object.getPrototypeOf(store.get(space.id).pages), Object.prototype);
    assert.equal(Object.prototype.targetId, undefined);
    assert.equal(store.get('__proto__'), null);
    assert.equal(store.get('constructor'), null);
    assert.equal(store.get('toString'), null);
  } finally {
    delete Object.prototype.targetId;
    delete Object.prototype.p1;
  }
});
