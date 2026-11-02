// 回歸：deleteSpace 只刪 spaces 時，labelSeq[id] 會變成永久孤兒，ledger 只增不減。
// 刪空間必須一併刪掉該空間的序號；其他空間的序號要留下。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../daemon/store.js';

function openStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-regress-dellabel-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'ledger.json');
  return { file, store: new Store(file) };
}

test('deleteSpace removes that labelSeq entry and keeps the sibling counter', (t) => {
  const { file, store } = openStore(t);
  const a = store.create({ name: 'alpha' });
  const b = store.create({ name: 'beta' });
  assert.equal(store.nextLabel(a.id), 'p2');
  assert.equal(store.nextLabel(a.id), 'p3');

  const restarted = new Store(file);
  assert.equal(restarted.data.labelSeq[String(a.id)], 3);
  restarted.deleteSpace(a.id);

  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(Object.hasOwn(raw.spaces, String(a.id)), false);
  assert.equal(raw.spaces[String(b.id)].name, 'beta');
  assert.equal(Object.hasOwn(raw.labelSeq, String(a.id)), false);
  assert.equal(raw.labelSeq[String(b.id)], 1);

  restarted.deleteSpace(a.id);
  const again = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(Object.hasOwn(again.labelSeq, String(a.id)), false);
  assert.equal(again.labelSeq[String(b.id)], 1);
  assert.equal(again.spaces[String(b.id)].pages.p1.targetId, null);
});
