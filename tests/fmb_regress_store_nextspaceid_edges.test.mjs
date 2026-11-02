// 回歸：normalizeLedger 的三個條件。不覆蓋「鍵完全不存在」的 nextSpaceId
// （既有 fmb_w4_s09 與待抽查項目）。這裡鎖：
//   非整數（null、'x'、4.5）會變成 NaN 或 0 鍵；
//   整數但 < 1（0）會配置 id 0；
//   整數但 <= 最大既有 id 會覆寫舊空間；
//   非正 space id 不得把下一個 id 拉到負數。
// 這些都是合法 JSON，應就地修正，不得走損壞備份。
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
  const dir = mkdtempSync(join(tmpdir(), 'fmb-regress-next-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'ledger.json');
  writeFileSync(file, `${JSON.stringify(body)}\n`);
  return { dir, file, store: new Store(file) };
}

function assertNoCorrupt(dir) {
  const bad = readdirSync(dir).filter((name) => name.includes('corrupt'));
  assert.deepEqual(bad, []);
}

test('落後的 nextSpaceId 不得覆寫既有空間', (t) => {
  const { dir, file, store } = fresh(t, {
    nextSpaceId: 1,
    labelSeq: { 1: 1, 4: 1 },
    spaces: {
      1: spaceStub(1, 'kept'),
      4: spaceStub(4, 'other'),
    },
  });
  const created = store.create({ name: 'fresh' });
  assert.equal(created.id, 5);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.spaces['1'].name, 'kept');
  assert.equal(raw.spaces['4'].name, 'other');
  assert.equal(raw.spaces['5'].name, 'fresh');
  assert.equal(raw.nextSpaceId, 6);
  assert.equal(Object.hasOwn(raw.spaces, 'NaN'), false);
  assertNoCorrupt(dir);
});

test('nextSpaceId 等於最大 space id 時改配下一個 id', (t) => {
  const { dir, file, store } = fresh(t, {
    nextSpaceId: 4,
    labelSeq: { 4: 1 },
    spaces: { 4: spaceStub(4, 'kept') },
  });
  const created = store.create({ name: 'fresh' });
  assert.equal(created.id, 5);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.spaces['4'].name, 'kept');
  assert.equal(raw.spaces['5'].name, 'fresh');
  assert.equal(raw.nextSpaceId, 6);
  assertNoCorrupt(dir);
});

test('非數字 nextSpaceId 不得寫出 NaN 空間鍵', (t) => {
  const { dir, file, store } = fresh(t, {
    nextSpaceId: 'x',
    labelSeq: {},
    spaces: { 3: spaceStub(3, 'kept') },
  });
  const created = store.create({ name: 'fresh' });
  assert.equal(created.id, 4);
  assert.equal(Number.isNaN(created.id), false);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.spaces['3'].name, 'kept');
  assert.equal(raw.spaces['4'].name, 'fresh');
  assert.equal(Object.hasOwn(raw.spaces, 'NaN'), false);
  assert.equal(Object.hasOwn(raw.spaces, 'x'), false);
  assertNoCorrupt(dir);
});

test('null nextSpaceId 不得配置 id 0', (t) => {
  const { dir, file, store } = fresh(t, {
    nextSpaceId: null,
    labelSeq: {},
    spaces: { 3: spaceStub(3, 'kept') },
  });
  const created = store.create({ name: 'fresh' });
  assert.equal(created.id, 4);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.spaces['3'].name, 'kept');
  assert.equal(raw.spaces['4'].name, 'fresh');
  assert.equal(Object.hasOwn(raw.spaces, '0'), false);
  assertNoCorrupt(dir);
});

test('0 nextSpaceId 不得配置 id 0', (t) => {
  const { dir, file, store } = fresh(t, {
    nextSpaceId: 0,
    labelSeq: {},
    spaces: { 3: spaceStub(3, 'kept') },
  });
  const created = store.create({ name: 'fresh' });
  assert.equal(created.id, 4);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.spaces['3'].name, 'kept');
  assert.equal(Object.hasOwn(raw.spaces, '0'), false);
  assert.equal(raw.spaces['4'].name, 'fresh');
  assertNoCorrupt(dir);
});

test('非整數 nextSpaceId 不得寫出小數空間鍵', (t) => {
  const { dir, file, store } = fresh(t, {
    nextSpaceId: 4.5,
    labelSeq: {},
    spaces: { 4: spaceStub(4, 'kept') },
  });
  const created = store.create({ name: 'fresh' });
  assert.equal(created.id, 5);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.spaces['4'].name, 'kept');
  assert.equal(raw.spaces['5'].name, 'fresh');
  assert.equal(Object.hasOwn(raw.spaces, '4.5'), false);
  assertNoCorrupt(dir);
});

test('已經合法且超前的 nextSpaceId 維持原值', (t) => {
  const { dir, file, store } = fresh(t, {
    nextSpaceId: 8,
    labelSeq: { 4: 1 },
    spaces: { 4: spaceStub(4, 'kept') },
  });
  const created = store.create({ name: 'fresh' });
  assert.equal(created.id, 8);
  assert.equal(store.get(4).name, 'kept');
  assert.equal(store.get(5), null);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.nextSpaceId, 9);
  assert.equal(raw.spaces['4'].name, 'kept');
  assert.equal(raw.spaces['8'].name, 'fresh');
  assertNoCorrupt(dir);
});

test('非正 space id 不參與最大值，null nextSpaceId 時新空間 id 為 1', (t) => {
  const { dir, file, store } = fresh(t, {
    nextSpaceId: null,
    labelSeq: {},
    spaces: { '-5': spaceStub(-5, 'neg') },
  });
  const created = store.create({ name: 'fresh' });
  assert.equal(created.id, 1);
  assert.equal(store.get(-5).name, 'neg');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.spaces['-5'].name, 'neg');
  assert.equal(raw.spaces['1'].name, 'fresh');
  assert.equal(raw.nextSpaceId, 2);
  assert.equal(Object.hasOwn(raw.spaces, '0'), false);
  assert.equal(Object.hasOwn(raw.spaces, 'NaN'), false);
  assertNoCorrupt(dir);
});
