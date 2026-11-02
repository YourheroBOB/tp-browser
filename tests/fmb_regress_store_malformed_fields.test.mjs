// 回歸：labelSeq 為 null／陣列／純量時 create() 不得拋錯，也不得把帳本當成損壞檔清掉。
// pages 不是一般物件時 nextLabel 不得拋錯；繼承來的 pN 不算已佔用；
// 自有鍵的分頁值若是 null，setPage 不得 Object.assign 上去。
// 不覆蓋「labelSeq 鍵完全缺少」（既有 fmb_w11_s09）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../daemon/store.js';

function spaceStub(id, name) {
  return {
    id,
    name,
    profileId: 'agent',
    ownership: 'agent',
    state: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    pages: { p1: { targetId: null, openedBy: 'agent', title: '', url: '' } },
    activeTargetId: null,
  };
}

function fresh(t, body) {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-regress-malformed-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'ledger.json');
  writeFileSync(file, `${JSON.stringify(body)}\n`);
  return { dir, file, store: new Store(file) };
}

function emptyStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-regress-malformed-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'ledger.json');
  return { dir, file, store: new Store(file) };
}

function assertNoCorrupt(dir) {
  const bad = readdirSync(dir).filter((name) => name.includes('corrupt'));
  assert.deepEqual(bad, []);
}

function ledgerWith(labelSeq) {
  return {
    nextSpaceId: 2,
    labelSeq,
    spaces: { 1: spaceStub(1, 'kept') },
  };
}

function assertRepairedLabelSeq(t, labelSeq) {
  const { dir, file, store } = fresh(t, ledgerWith(labelSeq));
  const created = store.create({ name: 'fresh' });
  assert.equal(created.id, 2);
  assert.equal(store.get(1).name, 'kept');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(Array.isArray(raw.labelSeq), false);
  assert.equal(raw.labelSeq !== null && typeof raw.labelSeq === 'object', true);
  assert.equal(raw.labelSeq['2'], 1);
  assert.equal(raw.spaces['1'].name, 'kept');
  assert.equal(raw.spaces['2'].name, 'fresh');
  assertNoCorrupt(dir);
}

test('陣列 labelSeq 會正規化，既有空間不進損壞備份', (t) => {
  assertRepairedLabelSeq(t, [9, 8]);
});

test('null labelSeq 會正規化，既有空間不進損壞備份', (t) => {
  assertRepairedLabelSeq(t, null);
});

test('數字純量 labelSeq 會正規化，既有空間不進損壞備份', (t) => {
  assertRepairedLabelSeq(t, 12);
});

test('字串純量 labelSeq 會正規化，既有空間不進損壞備份', (t) => {
  assertRepairedLabelSeq(t, 'nope');
});

function ledgerPages(pages) {
  const stub = spaceStub(1, 'kept');
  stub.pages = pages;
  return {
    nextSpaceId: 2,
    labelSeq: { 1: 1 },
    spaces: { 1: stub },
  };
}

test('pages 為 null 時 nextLabel 不拋錯', (t) => {
  const { dir, store } = fresh(t, ledgerPages(null));
  assert.equal(store.nextLabel(1), 'p2');
  assert.equal(store.get(1).name, 'kept');
  assertNoCorrupt(dir);
});

test('pages 為字串時 nextLabel 不拋錯', (t) => {
  const { dir, store } = fresh(t, ledgerPages('bad'));
  assert.equal(store.nextLabel(1), 'p2');
  assert.equal(store.get(1).name, 'kept');
  assertNoCorrupt(dir);
});

test('pages 為陣列時 nextLabel 不拋錯', (t) => {
  const { dir, store } = fresh(t, ledgerPages([]));
  assert.equal(store.nextLabel(1), 'p2');
  assert.equal(store.get(1).name, 'kept');
  assertNoCorrupt(dir);
});

test('繼承來的 pN 不算已佔用的標籤', (t) => {
  const { store } = emptyStore(t);
  const space = store.create({ name: 'alpha' });
  const proto = { p2: { targetId: 'inherited', openedBy: 'agent', title: '', url: '' } };
  const pages = Object.create(proto);
  pages.p1 = { targetId: null, openedBy: 'agent', title: '', url: '' };
  store.get(space.id).pages = pages;
  try {
    assert.equal(store.nextLabel(space.id), 'p2');
    assert.equal(store.nextLabel(space.id), 'p3');
    assert.equal(Object.prototype.targetId, undefined);
  } finally {
    delete Object.prototype.targetId;
    delete Object.prototype.p2;
  }
});

test('setPage 遇到 null 分頁值時不拋錯也不寫入', (t) => {
  const stub = spaceStub(1, 'kept');
  stub.pages.p1 = null;
  const { dir, file, store } = fresh(t, {
    nextSpaceId: 2,
    labelSeq: { 1: 1 },
    spaces: { 1: stub },
  });
  try {
    assert.doesNotThrow(() => store.setPage(1, 'p1', { title: 'should-not-apply' }));
    assert.equal(store.get(1).pages.p1, null);
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(raw.spaces['1'].pages.p1, null);
    assert.equal(raw.spaces['1'].name, 'kept');
    assert.equal(Object.prototype.title, undefined);
    assertNoCorrupt(dir);
  } finally {
    delete Object.prototype.title;
    delete Object.prototype.url;
  }
});
