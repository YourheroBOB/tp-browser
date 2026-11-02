// 回歸：舊 ledger 的 nextSpaceId 落後、等於既有 id，或不是正整數時，
// create() 會重用 id 蓋掉空間，或寫出 "NaN"／"0" 鍵。
// normalizeLedger 必須把 nextSpaceId 抬到「大於所有正整數 space id」。
// 不覆蓋「整鍵缺 nextSpaceId」——該案例已有別的測試。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../daemon/store.js';

function space(id, name, targetId) {
  return {
    id,
    name,
    profileId: 'agent',
    ownership: 'agent',
    state: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    pages: { p1: { targetId, openedBy: 'agent', title: '', url: '' } },
    activeTargetId: targetId,
  };
}

function openWith(t, ledger) {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-regress-reuse-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'ledger.json');
  writeFileSync(file, JSON.stringify(ledger));
  const store = new Store(file);
  return { file, store };
}

test('nextSpaceId equal to the max space id allocates the next id and does not clobber', (t) => {
  const { file, store } = openWith(t, {
    nextSpaceId: 4,
    labelSeq: { 4: 2 },
    spaces: { 4: space(4, 'do-not-clobber', 'T-keep') },
  });
  const created = store.create({ name: 'fresh' });
  assert.equal(created.id, 5);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.nextSpaceId, 6);
  assert.equal(raw.spaces['4'].name, 'do-not-clobber');
  assert.equal(raw.spaces['4'].pages.p1.targetId, 'T-keep');
  assert.equal(raw.spaces['4'].activeTargetId, 'T-keep');
  assert.equal(raw.labelSeq['4'], 2);
  assert.equal(raw.labelSeq['5'], 1);
  assert.equal(Object.hasOwn(raw.spaces, 'NaN'), false);
});

test('nextSpaceId behind several ids allocates max+1', (t) => {
  const { file, store } = openWith(t, {
    nextSpaceId: 1,
    labelSeq: { 2: 1, 7: 3 },
    spaces: {
      2: space(2, 'low', 'T-low'),
      7: space(7, 'high', 'T-high'),
    },
  });
  const created = store.create({ name: 'fresh' });
  assert.equal(created.id, 8);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.spaces['2'].pages.p1.targetId, 'T-low');
  assert.equal(raw.spaces['7'].pages.p1.targetId, 'T-high');
  assert.equal(raw.spaces['8'].name, 'fresh');
  assert.equal(raw.labelSeq['2'], 1);
  assert.equal(raw.labelSeq['7'], 3);
});

test('non-integer nextSpaceId does not mint NaN, 0, or a reused id', (t) => {
  const cases = [
    { nextSpaceId: 'x', keep: 3, expectId: 4 },
    { nextSpaceId: '', keep: 3, expectId: 4 },
    { nextSpaceId: null, keep: 4, expectId: 5 },
    { nextSpaceId: true, keep: 1, expectId: 2 },
    { nextSpaceId: 4.9, keep: 4, expectId: 5 },
    { nextSpaceId: 0, keep: 4, expectId: 5 },
    { nextSpaceId: -3, keep: 4, expectId: 5 },
  ];
  for (const item of cases) {
    const { file, store } = openWith(t, {
      nextSpaceId: item.nextSpaceId,
      labelSeq: { [item.keep]: 1 },
      spaces: { [item.keep]: space(item.keep, 'kept', 'T-keep') },
    });
    const created = store.create({ name: 'fresh' });
    assert.equal(created.id, item.expectId, `nextSpaceId=${JSON.stringify(item.nextSpaceId)}`);
    assert.equal(Number.isInteger(created.id), true);
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(raw.spaces[String(item.keep)].name, 'kept');
    assert.equal(raw.spaces[String(item.keep)].pages.p1.targetId, 'T-keep');
    assert.equal(Object.hasOwn(raw.spaces, 'NaN'), false);
    assert.equal(Object.hasOwn(raw.spaces, '0'), false);
    assert.equal(raw.spaces[String(item.expectId)].name, 'fresh');
  }
});
