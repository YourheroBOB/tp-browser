// Regression: removePage used to leave activeTargetId pointing at a target
// that had just been deleted, so the ledger kept a dangling active page.
// Removing some other page must not clear it. A null targetId must not
// compare equal to a null activeTargetId (the guard is `!= null`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../daemon/store.js';

function tempLedger() {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-regress-active-'));
  return { dir, file: join(dir, 'ledger.json') };
}

test('removePage clears activeTargetId only when the removed page owns it', () => {
  const { dir, file } = tempLedger();
  try {
    const store = new Store(file);
    const space = store.create({ name: 'regress-space' });
    const other = store.create({ name: 'other-space' });
    store.bindPage(space.id, 'p1', 'T-active', 'agent');
    store.addPage(space.id, 'p2', 'T-other', 'agent');
    space.activeTargetId = 'T-active';
    other.activeTargetId = 'T-other-space';
    store.persist();

    store.removePage(space.id, 'p1');

    assert.equal(space.activeTargetId, null);
    assert.equal(Object.hasOwn(space.pages, 'p1'), false);
    assert.equal(space.pages.p2.targetId, 'T-other');
    assert.equal(other.activeTargetId, 'T-other-space');
    assert.equal(store.data.labelSeq[space.id], 1);

    const reloaded = new Store(file);
    const again = reloaded.get(space.id);
    assert.ok(again);
    assert.equal(again.activeTargetId, null);
    assert.equal(Object.hasOwn(again.pages, 'p1'), false);
    assert.equal(again.pages.p2.targetId, 'T-other');
    assert.equal(reloaded.get(other.id).activeTargetId, 'T-other-space');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removePage keeps activeTargetId when a different page is removed', () => {
  const { dir, file } = tempLedger();
  try {
    const store = new Store(file);
    const space = store.create({ name: 'regress-space' });
    store.bindPage(space.id, 'p1', 'T-active', 'agent');
    store.addPage(space.id, 'p2', 'T-other', 'agent');
    space.activeTargetId = 'T-active';
    store.persist();

    store.removePage(space.id, 'p2');

    assert.equal(space.activeTargetId, 'T-active');
    assert.equal(space.pages.p1.targetId, 'T-active');
    assert.equal(Object.hasOwn(space.pages, 'p2'), false);

    const again = new Store(file).get(space.id);
    assert.equal(again.activeTargetId, 'T-active');
    assert.equal(again.pages.p1.targetId, 'T-active');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removePage does not clear activeTargetId when the page targetId is null', () => {
  const { dir, file } = tempLedger();
  try {
    const store = new Store(file);
    const space = store.create({ name: 'regress-space' });
    assert.equal(space.pages.p1.targetId, null);
    space.activeTargetId = 'T-still';
    store.persist();

    store.removePage(space.id, 'p1');

    assert.equal(space.activeTargetId, 'T-still');
    assert.equal(Object.hasOwn(space.pages, 'p1'), false);
    assert.equal(new Store(file).get(space.id).activeTargetId, 'T-still');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removePage of a missing label or space does not throw or rewrite activeTargetId', () => {
  const { dir, file } = tempLedger();
  try {
    const store = new Store(file);
    const space = store.create({ name: 'regress-space' });
    store.bindPage(space.id, 'p1', 'T-active', 'agent');
    space.activeTargetId = 'T-active';
    store.persist();
    const before = JSON.parse(JSON.stringify(store.data));

    assert.doesNotThrow(() => store.removePage(space.id, 'p-missing'));
    assert.doesNotThrow(() => store.removePage(space.id + 100, 'p1'));
    assert.doesNotThrow(() => store.removePage(space.id, '__proto__'));

    assert.equal(space.activeTargetId, 'T-active');
    assert.equal(space.pages.p1.targetId, 'T-active');
    const disk = JSON.parse(JSON.stringify(new Store(file).data));
    assert.equal(disk.spaces[String(space.id)].activeTargetId, 'T-active');
    assert.deepEqual(disk.spaces[String(space.id)].pages, before.spaces[String(space.id)].pages);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
