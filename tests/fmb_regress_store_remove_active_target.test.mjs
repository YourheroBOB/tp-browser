// 回歸：移除「正是 activeTargetId」的分頁後，ledger 仍指向已刪掉的 target。
// 只有該分頁自己的 targetId 吻合時才清掉；刪別的分頁、或 targetId 為 null，都不可清。
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

function reload(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

test('removing the active page clears activeTargetId on disk', (t) => {
  const { file, store } = openStore(t);
  const space = store.create({ name: 's' });
  store.bindPage(space.id, 'p1', 'T-active');
  store.bindPage(space.id, 'p2', 'T-same');
  space.activeTargetId = 'T-active';
  store.removePage(space.id, 'p1');

  const raw = reload(file);
  const saved = raw.spaces[String(space.id)];
  assert.equal(saved.activeTargetId, null);
  assert.equal(Object.hasOwn(saved.pages, 'p1'), false);
  assert.equal(saved.pages.p2.targetId, 'T-same');

  const again = new Store(file);
  assert.equal(again.get(space.id).activeTargetId, null);
});

test('removing a different page keeps activeTargetId', (t) => {
  const { file, store } = openStore(t);
  const space = store.create({ name: 's' });
  store.bindPage(space.id, 'p1', 'T-active');
  store.bindPage(space.id, 'p2', 'T-other');
  space.activeTargetId = 'T-active';
  store.removePage(space.id, 'p2');

  const saved = reload(file).spaces[String(space.id)];
  assert.equal(saved.activeTargetId, 'T-active');
  assert.equal(saved.pages.p1.targetId, 'T-active');
  assert.equal(Object.hasOwn(saved.pages, 'p2'), false);
});

test('removing a null-target placeholder does not clear a different activeTargetId', (t) => {
  const { file, store } = openStore(t);
  const space = store.create({ name: 's' });
  store.bindPage(space.id, 'p2', 'T-live');
  space.activeTargetId = 'T-live';
  assert.equal(space.pages.p1.targetId, null);
  store.removePage(space.id, 'p1');

  const saved = reload(file).spaces[String(space.id)];
  assert.equal(saved.activeTargetId, 'T-live');
  assert.equal(saved.pages.p2.targetId, 'T-live');
  assert.equal(Object.hasOwn(saved.pages, 'p1'), false);
});

test('removePage on an unknown space or missing label does not throw', (t) => {
  const { file, store } = openStore(t);
  const space = store.create({ name: 's' });
  store.bindPage(space.id, 'p1', 'T-active');
  space.activeTargetId = 'T-active';
  store.persist();
  const before = readFileSync(file, 'utf8');
  assert.doesNotThrow(() => {
    store.removePage(999999, 'p1');
    store.removePage(space.id, 'missing');
    store.removePage(space.id, 'toString');
  });
  assert.equal(readFileSync(file, 'utf8'), before);
});
