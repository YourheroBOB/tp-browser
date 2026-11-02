// Regression: create() did `labelSeq[id] = 1` and threw when an old ledger
// stored labelSeq as null, an array, or a scalar. nextLabel also treated
// inherited keys (and non-integers) as real counters.
// Missing labelSeq / missing nextSpaceId are covered elsewhere; this file
// locks the other shapes and the counter parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../daemon/store.js';

function tempLedger() {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-regress-lsq-'));
  return { dir, file: join(dir, 'ledger.json') };
}

function keptSpace() {
  return {
    id: 4,
    name: 'kept',
    profileId: 'agent',
    ownership: 'agent',
    state: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    pages: { p1: { targetId: null, openedBy: 'agent', title: '', url: '' } },
    activeTargetId: null,
  };
}

test('load replaces null, array, and scalar labelSeq so create still works', () => {
  for (const labelSeq of [null, [], 'nope', 3, true]) {
    const { dir, file } = tempLedger();
    try {
      writeFileSync(file, JSON.stringify({
        nextSpaceId: 5,
        labelSeq,
        spaces: { 4: keptSpace() },
      }));
      const store = new Store(file);
      assert.equal(Array.isArray(store.data.labelSeq), false);
      assert.equal(store.data.labelSeq !== null && typeof store.data.labelSeq, 'object');
      assert.equal(store.get(4).name, 'kept');
      assert.equal(store.data.nextSpaceId, 5);

      const created = store.create({ name: 'fresh' });
      assert.equal(created.id, 5);
      assert.equal(store.get(4).name, 'kept');
      assert.equal(store.data.labelSeq[5], 1);
      assert.equal(store.data.labelSeq[4], undefined);

      const disk = JSON.parse(readFileSync(file, 'utf8'));
      assert.equal(disk.spaces['4'].name, 'kept');
      assert.equal(disk.spaces['5'].name, 'fresh');
      assert.equal(Array.isArray(disk.labelSeq), false);
      assert.equal(disk.labelSeq['5'], 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('load keeps a plain-object labelSeq and nextLabel continues from it', () => {
  const { dir, file } = tempLedger();
  try {
    writeFileSync(file, JSON.stringify({
      nextSpaceId: 5,
      labelSeq: { 4: 8 },
      spaces: { 4: keptSpace() },
    }));
    const store = new Store(file);
    assert.equal(store.data.labelSeq[4], 8);
    assert.equal(store.nextLabel(4), 'p9');
    assert.equal(store.data.labelSeq[4], 9);
    assert.equal(store.get(4).name, 'kept');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).labelSeq['4'], 9);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nextLabel coerces non-integer own counters instead of emitting NaN labels', () => {
  const { dir, file } = tempLedger();
  try {
    const store = new Store(file);
    const space = store.create({ name: 'counters' });
    const cases = [
      ['3', 'p4'],
      [0, 'p2'],
      [-5, 'p2'],
      [1.5, 'p2'],
      ['foo', 'p2'],
      [true, 'p2'],
    ];
    for (const [raw, expected] of cases) {
      store.data.labelSeq[space.id] = raw;
      assert.equal(store.nextLabel(space.id), expected, `counter ${JSON.stringify(raw)}`);
      store.data.labelSeq[space.id] = 1;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nextLabel ignores an inherited labelSeq value and writes an own integer', () => {
  const { dir, file } = tempLedger();
  try {
    const store = new Store(file);
    const space = store.create({ name: 'inherited-seq' });
    const proto = {};
    proto[space.id] = 50;
    store.data.labelSeq = Object.create(proto);
    assert.equal(Object.hasOwn(store.data.labelSeq, String(space.id)), false);

    assert.equal(store.nextLabel(space.id), 'p2');
    assert.equal(store.data.labelSeq[space.id], 2);
    assert.equal(Object.hasOwn(store.data.labelSeq, String(space.id)), true);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).labelSeq[String(space.id)], 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nextLabel repairs a null or undefined labelSeq instead of throwing', () => {
  for (const broken of [null, undefined]) {
    const { dir, file } = tempLedger();
    try {
      const store = new Store(file);
      const space = store.create({ name: 'repair' });
      store.data.labelSeq = broken;
      assert.equal(store.nextLabel(space.id), 'p2');
      assert.equal(store.data.labelSeq[space.id], 2);
      assert.equal(JSON.parse(readFileSync(file, 'utf8')).labelSeq[String(space.id)], 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
