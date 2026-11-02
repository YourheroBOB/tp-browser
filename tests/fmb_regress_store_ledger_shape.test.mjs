// 回歸：daemon/store.js normalizeLedger / removePage / deleteSpace / nextLabel
// 的防禦分支。不覆蓋「整塊缺少 nextSpaceId／labelSeq」與 __proto__ 鍵名那些既有測試，
// 這裡鎖的是註解裡另外幾種會寫壞 ledger 的輸入。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../daemon/store.js';

function freshStore(initial) {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-regress-store-'));
  const file = join(dir, 'ledger.json');
  if (initial !== undefined) writeFileSync(file, JSON.stringify(initial));
  return { dir, file, store: new Store(file) };
}

function rm(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function space(id, name) {
  return {
    id,
    name,
    profileId: 'agent',
    ownership: 'agent',
    state: 'active',
    createdAt: '2020-01-01T00:00:00.000Z',
    pages: { p1: { targetId: null, openedBy: 'agent', title: '', url: '' } },
    activeTargetId: null,
  };
}

test('nextSpaceId 為非整數字串時不會寫出 NaN 空間', () => {
  const { dir, file, store } = freshStore({
    nextSpaceId: 'x',
    labelSeq: {},
    spaces: {},
  });
  try {
    const created = store.create({ name: 'new' });
    assert.equal(created.id, 1);
    assert.equal(store.data.nextSpaceId, 2);
    assert.equal(store.get('NaN'), null);
    assert.equal(readFileSync(file, 'utf8').includes('NaN'), false);
  } finally {
    rm(dir);
  }
});

test('看起來像數字的 nextSpaceId 字串不會被強制轉成整數來沿用', () => {
  // Number.isInteger('8') 為 false。若改成 Number() 強制轉型，id 會變成 8 而不是 max+1。
  const { dir, store } = freshStore({
    nextSpaceId: '8',
    labelSeq: { 2: 1 },
    spaces: { 2: space(2, 'keep') },
  });
  try {
    const created = store.create({ name: 'new' });
    assert.equal(created.id, 3);
    assert.equal(store.get(2).name, 'keep');
    assert.equal(store.get(3).name, 'new');
    assert.equal(store.get('NaN'), null);
  } finally {
    rm(dir);
  }
});

test('nextSpaceId 等於既有最大 space id 時不會覆蓋舊空間', () => {
  const { dir, store } = freshStore({
    nextSpaceId: 4,
    labelSeq: { 4: 1 },
    spaces: { 4: space(4, 'keep') },
  });
  try {
    const created = store.create({ name: 'new' });
    assert.equal(created.id, 5);
    assert.equal(store.get(4).name, 'keep');
    assert.equal(store.get(5).name, 'new');
    assert.notEqual(store.get(4), store.get(5));
  } finally {
    rm(dir);
  }
});

test('nextSpaceId 為 0、負數或小數時正規化成大於既有 id 的正整數', () => {
  const cases = [
    { nextSpaceId: 0, spaces: {}, expectId: 1 },
    { nextSpaceId: 1.5, spaces: {}, expectId: 1 },
    { nextSpaceId: -3, spaces: { 2: space(2, 'keep') }, expectId: 3 },
  ];
  for (const item of cases) {
    const { dir, store } = freshStore({
      nextSpaceId: item.nextSpaceId,
      labelSeq: {},
      spaces: item.spaces,
    });
    try {
      const created = store.create({ name: 'new' });
      assert.equal(created.id, item.expectId);
      if (item.spaces[2]) assert.equal(store.get(2).name, 'keep');
    } finally {
      rm(dir);
    }
  }
});

for (const labelSeq of [[], null, 0, true, 'bad']) {
  test(`labelSeq=${JSON.stringify(labelSeq)} 時 create 仍成功且序號是一般物件`, () => {
    const { dir, file, store } = freshStore({
      nextSpaceId: 1,
      labelSeq,
      spaces: {},
    });
    try {
      const created = store.create({ name: 'new' });
      assert.equal(created.id, 1);
      assert.equal(Array.isArray(store.data.labelSeq), false);
      assert.equal(typeof store.data.labelSeq, 'object');
      assert.equal(store.data.labelSeq[1], 1);
      const disk = JSON.parse(readFileSync(file, 'utf8'));
      assert.equal(Array.isArray(disk.labelSeq), false);
      assert.equal(disk.labelSeq['1'], 1);
    } finally {
      rm(dir);
    }
  });
}

test('removePage 只在被移除分頁的 targetId 等於 activeTargetId 時才清空', () => {
  const { dir, file, store } = freshStore();
  try {
    const s = store.create({ name: 'n' });
    store.bindPage(s.id, 'p2', 'T-ACT');
    store.bindPage(s.id, 'p3', 'T-KEEP');
    s.activeTargetId = 'T-ACT';

    store.removePage(s.id, 'p1');
    assert.equal(s.activeTargetId, 'T-ACT');

    store.removePage(s.id, 'p3');
    assert.equal(s.activeTargetId, 'T-ACT');

    store.removePage(s.id, 'p2');
    assert.equal(s.activeTargetId, null);

    const again = new Store(file).get(s.id);
    assert.equal(again.activeTargetId, null);
    assert.equal(Object.hasOwn(again.pages, 'p1'), false);
    assert.equal(Object.hasOwn(again.pages, 'p2'), false);
    assert.equal(Object.hasOwn(again.pages, 'p3'), false);
  } finally {
    rm(dir);
  }
});

test('deleteSpace 一併刪除該空間的 labelSeq，且重複刪除不會丟錯', () => {
  const { dir, file, store } = freshStore();
  try {
    const a = store.create({ name: 'a' });
    const b = store.create({ name: 'b' });
    assert.equal(store.nextLabel(a.id), 'p2');
    store.deleteSpace(a.id);
    assert.equal(store.get(a.id), null);
    assert.equal(Object.hasOwn(store.data.labelSeq, String(a.id)), false);
    assert.equal(store.data.labelSeq[b.id], 1);
    store.deleteSpace(a.id);

    const disk = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(Object.hasOwn(disk.labelSeq, String(a.id)), false);
    assert.equal(disk.labelSeq[String(b.id)], 1);
    const reloaded = new Store(file);
    assert.equal(reloaded.get(a.id), null);
    assert.equal(reloaded.get(b.id).name, 'b');
    assert.equal(Object.hasOwn(reloaded.data.labelSeq, String(a.id)), false);
  } finally {
    rm(dir);
  }
});

test('nextLabel 不採用原型鏈上的序號', () => {
  const { dir, store } = freshStore();
  try {
    const s = store.create({ name: 'n' });
    store.data.labelSeq = Object.create({ [s.id]: 40 });
    assert.equal(store.nextLabel(s.id), 'p2');
    assert.equal(Object.hasOwn(store.data.labelSeq, String(s.id)), true);
    assert.equal(store.data.labelSeq[s.id], 2);
  } finally {
    rm(dir);
  }
});

test('nextLabel 接受數字字串序號，並跳過已占用的 pN', () => {
  const { dir, store } = freshStore();
  try {
    const s = store.create({ name: 'n' });
    store.bindPage(s.id, 'p2', 'T-2');
    store.data.labelSeq[s.id] = '1';
    assert.equal(store.nextLabel(s.id), 'p3');
    assert.equal(store.data.labelSeq[s.id], 3);
  } finally {
    rm(dir);
  }
});

test('nextLabel 在 pages 為 null 時不丟 TypeError', () => {
  const { dir, store } = freshStore();
  try {
    const s = store.create({ name: 'n' });
    s.pages = null;
    assert.equal(store.nextLabel(s.id), 'p2');
    assert.equal(store.data.labelSeq[s.id], 2);
  } finally {
    rm(dir);
  }
});
