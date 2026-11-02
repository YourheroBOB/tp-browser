// bindPage／addPage 覆寫分頁時，若舊 targetId 正是 activeTargetId 且已沒有其他分頁持有它，
// activeTargetId 必須清成 null。修前會一直指向已消失的 target，並寫進 ledger。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../daemon/store.js';

function tempFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'bug-store-active-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'ledger.json');
}

test('bindPage 覆寫最後一個持有者後，activeTargetId 不得留著已消失的 target', (t) => {
  const file = tempFile(t);
  const store = new Store(file);
  const space = store.create({ name: 'rebind' });
  store.bindPage(space.id, 'p1', 'T1-FAKE_VALUE_FOR_TEST');
  store.addPage(space.id, 'p2', 'T1-FAKE_VALUE_FOR_TEST');
  store.get(space.id).activeTargetId = 'T1-FAKE_VALUE_FOR_TEST';
  store.persist();

  // 另一個分頁仍持有 T1：作用中 target 還在，不得清掉。
  store.bindPage(space.id, 'p1', 'T4-FAKE_VALUE_FOR_TEST');
  assert.equal(store.get(space.id).activeTargetId, 'T1-FAKE_VALUE_FOR_TEST');
  assert.equal(store.get(space.id).pages.p2.targetId, 'T1-FAKE_VALUE_FOR_TEST');

  // 最後一個持有者也被改綁：ledger 不得再指向 T1。
  store.bindPage(space.id, 'p2', 'T5-FAKE_VALUE_FOR_TEST');
  assert.equal(store.get(space.id).pages.p2.targetId, 'T5-FAKE_VALUE_FOR_TEST');
  assert.equal(store.get(space.id).activeTargetId, null);

  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(onDisk.spaces[String(space.id)].activeTargetId, null);
  assert.equal(new Store(file).get(space.id).activeTargetId, null);
});

test('addPage 覆寫作用中分頁後，activeTargetId 不得留著已消失的 target', (t) => {
  const file = tempFile(t);
  const store = new Store(file);
  const space = store.create({ name: 'readd' });
  store.bindPage(space.id, 'p1', 'T1-FAKE_VALUE_FOR_TEST');
  store.get(space.id).activeTargetId = 'T1-FAKE_VALUE_FOR_TEST';
  store.persist();

  // 原 target 再寫一次：target 仍在，activeTargetId 維持不變。
  store.addPage(space.id, 'p1', 'T1-FAKE_VALUE_FOR_TEST', 'human');
  assert.equal(store.get(space.id).activeTargetId, 'T1-FAKE_VALUE_FOR_TEST');

  store.addPage(space.id, 'p1', 'T9-FAKE_VALUE_FOR_TEST', 'human');
  assert.equal(store.get(space.id).pages.p1.openedBy, 'human');
  assert.equal(store.get(space.id).pages.p1.targetId, 'T9-FAKE_VALUE_FOR_TEST');
  assert.equal(store.get(space.id).pages.p1.title, '');
  assert.equal(store.get(space.id).activeTargetId, null);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).spaces[String(space.id)].activeTargetId, null);
});
