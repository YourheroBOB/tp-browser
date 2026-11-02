// Regression: deleteSpace removed the space but left labelSeq[id] behind,
// so every reap grew the ledger. The counter is per-space and must go with it.
// A missing labelSeq must not make delete throw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../daemon/store.js';

function tempLedger() {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-regress-delsq-'));
  return { dir, file: join(dir, 'ledger.json') };
}

function disk(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

test('deleteSpace drops that space labelSeq entry and keeps the sibling counter', () => {
  const { dir, file } = tempLedger();
  try {
    const store = new Store(file);
    const a = store.create({ name: 'space-a' });
    const b = store.create({ name: 'space-b' });
    assert.equal(store.nextLabel(a.id), 'p2');
    assert.equal(store.nextLabel(b.id), 'p2');

    store.deleteSpace(a.id);

    assert.equal(store.get(a.id), null);
    assert.equal(store.get(b.id).name, 'space-b');
    assert.equal(Object.hasOwn(store.data.labelSeq, String(a.id)), false);
    assert.equal(store.data.labelSeq[b.id], 2);

    const saved = disk(file);
    assert.equal(Object.hasOwn(saved.spaces, String(a.id)), false);
    assert.equal(Object.hasOwn(saved.labelSeq, String(a.id)), false);
    assert.equal(saved.labelSeq[String(b.id)], 2);
    assert.equal(saved.spaces[String(b.id)].name, 'space-b');

    const reloaded = new Store(file);
    assert.equal(reloaded.get(a.id), null);
    assert.equal(reloaded.data.labelSeq[b.id], 2);
    assert.equal(Object.hasOwn(reloaded.data.labelSeq, String(a.id)), false);

    const c = reloaded.create({ name: 'space-c' });
    assert.notEqual(c.id, a.id);
    assert.equal(reloaded.data.labelSeq[c.id], 1);
    assert.equal(Object.hasOwn(reloaded.data.labelSeq, String(a.id)), false);
    assert.equal(disk(file).labelSeq[String(a.id)], undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deleteSpace on an unknown id does not throw or drop other counters', () => {
  const { dir, file } = tempLedger();
  try {
    const store = new Store(file);
    const space = store.create({ name: 'keep' });
    assert.equal(store.nextLabel(space.id), 'p2');
    const before = disk(file);

    assert.doesNotThrow(() => store.deleteSpace(space.id + 50));

    const after = disk(file);
    assert.equal(after.nextSpaceId, before.nextSpaceId);
    assert.deepEqual(after.labelSeq, before.labelSeq);
    assert.deepEqual(after.spaces, before.spaces);
    assert.equal(store.get(space.id).name, 'keep');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deleteSpace does not throw when labelSeq is missing in memory', () => {
  const { dir, file } = tempLedger();
  try {
    const store = new Store(file);
    const space = store.create({ name: 'solo' });
    store.data.labelSeq = undefined;

    assert.doesNotThrow(() => store.deleteSpace(space.id));

    assert.equal(store.get(space.id), null);
    const saved = disk(file);
    assert.equal(Object.hasOwn(saved.spaces, String(space.id)), false);
    const reloaded = new Store(file);
    assert.equal(reloaded.get(space.id), null);
    assert.equal(typeof reloaded.data.labelSeq, 'object');
    assert.equal(Array.isArray(reloaded.data.labelSeq), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
