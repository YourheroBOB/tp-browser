import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Store } from '../daemon/store.js';

function createFixture() {
  const directory = mkdtempSync(
    join(tmpdir(), 'tp-browser-fmb-contract-store-'),
  );
  const file = join(directory, 'store.json');
  return {
    directory,
    file,
    store: new Store(file),
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('Store exposes the documented method signatures', () => {
  assert.equal(typeof Store, 'function');
  assert.equal(Store.length, 1);
  assert.equal(Store.prototype.create.length, 1);
  assert.equal(Store.prototype.nextLabel.length, 1);
  assert.equal(Store.prototype.setPage.length, 3);
  assert.equal(Store.prototype.bindPage.length, 3);
  assert.equal(Store.prototype.addPage.length, 3);
  assert.equal(Store.prototype.removePage.length, 2);
  assert.equal(Store.prototype.deleteSpace.length, 1);
});

test('Store.create and Store.list return the current space structure', () => {
  const fixture = createFixture();

  try {
    const { store } = fixture;
    const created = store.create({ name: 'contract-space' });

    assert.equal(created.id, 1);
    assert.equal(created.name, 'contract-space');
    assert.equal(created.profileId, 'agent');
    assert.equal(created.ownership, 'agent');
    assert.equal(created.state, 'active');
    assert.equal(created.activeTargetId, null);
    assert.equal(new Date(created.createdAt).toISOString(), created.createdAt);
    assert.deepEqual(created.pages.p1, {
      targetId: null,
      openedBy: 'agent',
      title: '',
      url: '',
    });
    assert.deepEqual(Object.keys(created).sort(), [
      'activeTargetId',
      'createdAt',
      'id',
      'name',
      'ownership',
      'pages',
      'profileId',
      'state',
    ]);

    assert.equal(store.get(created.id), created);
    assert.deepEqual(store.list(), [created]);

    const custom = store.create({
      name: 'custom-profile-space',
      profileId: 'contract-profile',
    });
    assert.equal(custom.id, 2);
    assert.equal(custom.profileId, 'contract-profile');
    assert.deepEqual(store.list(), [created, custom]);
  } finally {
    fixture.cleanup();
  }
});

test('Store page labels, patches, bindings, and removals retain their behavior', () => {
  const fixture = createFixture();

  try {
    const { store } = fixture;
    const space = store.create({ name: 'page-contract-space' });

    assert.equal(store.nextLabel(space.id), 'p2');
    assert.equal(store.nextLabel('missing-space'), 'p?');
    assert.equal(store.nextLabel(space.id), 'p3');

    assert.equal(
      store.setPage(space.id, 'p1', {
        title: 'Updated title',
        url: 'about:blank',
      }),
      undefined,
    );
    assert.deepEqual(store.get(space.id).pages.p1, {
      targetId: null,
      openedBy: 'agent',
      title: 'Updated title',
      url: 'about:blank',
    });

    assert.equal(
      store.setPage(space.id, 'missing-page', { title: 'ignored' }),
      undefined,
    );
    assert.equal(store.get(space.id).pages['missing-page'], undefined);

    store.bindPage(space.id, 'p1', 'target-contract', 'human');
    assert.deepEqual(store.get(space.id).pages.p1, {
      targetId: 'target-contract',
      openedBy: 'human',
      title: '',
      url: '',
    });

    store.addPage(space.id, 'p2', 'target-added');
    assert.deepEqual(store.get(space.id).pages.p2, {
      targetId: 'target-added',
      openedBy: 'agent',
      title: '',
      url: '',
    });

    assert.equal(store.removePage(space.id, 'p2'), undefined);
    assert.equal(store.get(space.id).pages.p2, undefined);
    assert.equal(store.removePage(space.id, 'missing-page'), undefined);

    store.deleteSpace(space.id);
    assert.equal(store.get(space.id), null);
    assert.deepEqual(store.list(), []);
  } finally {
    fixture.cleanup();
  }
});

test('Store reports unknown spaces with the existing Error contract', () => {
  const fixture = createFixture();

  try {
    const { store } = fixture;

    assert.throws(
      () => store.bindPage(999, 'p1', 'target-contract'),
      { name: 'Error', message: 'unknown space 999' },
    );

    assert.throws(
      () => store.addPage(999, 'p1', 'target-contract'),
      { name: 'Error', message: 'unknown space 999' },
    );
  } finally {
    fixture.cleanup();
  }
});

test('Store persists spaces and page bindings across instances', () => {
  const fixture = createFixture();

  try {
    const { file, store } = fixture;
    const created = store.create({ name: 'persistent-space' });
    store.bindPage(created.id, 'p1', 'persistent-target', 'human');

    const reloaded = new Store(file);
    assert.deepEqual(reloaded.get(created.id).pages.p1, {
      targetId: 'persistent-target',
      openedBy: 'human',
      title: '',
      url: '',
    });
    assert.deepEqual(reloaded.list(), reloaded.list());

    const next = reloaded.create({ name: 'next-space' });
    assert.equal(next.id, 2);
    assert.equal(reloaded.list().length, 2);
  } finally {
    fixture.cleanup();
  }
});
