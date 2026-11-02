// 回歸 nextLabel：
// 1. labelSeq 的數字字串要當數字續編，不可掉回 p2 蓋掉已占用的標籤。
// 2. 續號時只認 pages 的自有鍵；原型上的 pN、以及 pages 為 null／陣列／純量，都不可誤判或拋錯。
// 3. labelSeq 只認自有鍵；原型上的同名計數不可被當成目前序號。
// 4. 未知空間回 'p?'，且不寫檔。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../daemon/store.js';

function openStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-regress-nextlabel-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'ledger.json');
  return { file, store: new Store(file) };
}

test('numeric-string labelSeq continues from that value', (t) => {
  const { file, store } = openStore(t);
  const space = store.create({ name: 's' });
  store.data.labelSeq[space.id] = '04';
  assert.equal(store.nextLabel(space.id), 'p5');
  assert.equal(store.data.labelSeq[space.id], 5);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.labelSeq[String(space.id)], 5);
});

test('numeric-string labelSeq still skips an existing own label', (t) => {
  const { store } = openStore(t);
  const space = store.create({ name: 's' });
  store.bindPage(space.id, 'p5', 'T-taken');
  store.data.labelSeq[space.id] = '04';
  assert.equal(store.nextLabel(space.id), 'p6');
  assert.equal(store.data.labelSeq[space.id], 6);
  assert.equal(space.pages.p5.targetId, 'T-taken');
});

test('a null labelSeq entry falls back to p2 instead of NaN', (t) => {
  const { store } = openStore(t);
  const space = store.create({ name: 's' });
  store.data.labelSeq[space.id] = null;
  assert.equal(store.nextLabel(space.id), 'p2');
  assert.equal(store.data.labelSeq[space.id], 2);
});

test('pages that are not a plain object do not throw and do not consume array indices', (t) => {
  const samples = [null, 42, 'bad', []];
  for (const pages of samples) {
    const { store } = openStore(t);
    const space = store.create({ name: 's' });
    if (Array.isArray(pages)) pages.p2 = { targetId: 'T-array' };
    space.pages = pages;
    store.data.labelSeq[space.id] = 1;
    assert.equal(store.nextLabel(space.id), 'p2');
  }
});

test('unknown space returns p? and does not rewrite the ledger', (t) => {
  const { file, store } = openStore(t);
  store.create({ name: 's' });
  const before = readFileSync(file, 'utf8');
  assert.equal(store.nextLabel(999999), 'p?');
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('an inherited labelSeq counter is ignored', (t) => {
  const { store } = openStore(t);
  const space = store.create({ name: 's' });
  const key = String(space.id);
  delete store.data.labelSeq[space.id];
  Object.prototype[key] = 40;
  try {
    assert.equal(store.nextLabel(space.id), 'p2');
    assert.equal(store.data.labelSeq[space.id], 2);
    assert.equal(Object.prototype[key], 40);
  } finally {
    delete Object.prototype[key];
  }
});

test('an inherited pN on Object.prototype is not treated as an existing page', (t) => {
  const { store } = openStore(t);
  const space = store.create({ name: 's' });
  Object.prototype.p2 = { targetId: 'T-inherited' };
  try {
    assert.equal(store.nextLabel(space.id), 'p2');
    assert.equal(space.pages.p1.targetId, null);
    assert.equal(Object.hasOwn(space.pages, 'p2'), false);
  } finally {
    delete Object.prototype.p2;
  }
});
