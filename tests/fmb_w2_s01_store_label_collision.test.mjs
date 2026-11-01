import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../daemon/store.js';

function tempLedger(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-w2-s01-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'spaces.json');
}

test('nextLabel 跳過已存在的手動分頁標籤', (t) => {
  const store = new Store(tempLedger(t));
  store.create({ name: 'a' });
  store.addPage(1, 'p2', 'FAKE_VALUE_FOR_TEST');
  store.addPage(1, 'p3', 'FAKE_VALUE_FOR_TEST');

  assert.equal(store.nextLabel(1), 'p4');

  store.addPage(1, 'p4', 'FAKE_VALUE_FOR_TEST');
  assert.equal(store.get(1).pages.p2.targetId, 'FAKE_VALUE_FOR_TEST');
  assert.equal(store.get(1).pages.p3.targetId, 'FAKE_VALUE_FOR_TEST');
  assert.equal(store.get(1).pages.p4.targetId, 'FAKE_VALUE_FOR_TEST');
});

test('deleteSpace 移除 labelSeq，且重新載入後仍不存在', (t) => {
  const file = tempLedger(t);
  const store = new Store(file);
  const space = store.create({ name: 'a' });
  store.nextLabel(space.id);

  store.deleteSpace(space.id);
  const reloaded = new Store(file);

  assert.equal(reloaded.get(space.id), null);
  assert.equal(Object.hasOwn(reloaded.data.labelSeq, String(space.id)), false);
});
