import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../daemon/store.js';

const temporaryRoots = [];

after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function newFixture() {
  const root = mkdtempSync(join(tmpdir(), 'tp-browser-fmb-edge-store-'));
  temporaryRoots.push(root);
  const stateDir = join(root, 'state');
  mkdirSync(stateDir, { recursive: true });
  return {
    root,
    file: join(stateDir, 'spaces.json'),
  };
}

test('Store recovers from empty or malformed ledger JSON', () => {
  const malformedBodies = ['', '{ definitely-not-json'];
  const loggedErrors = [];
  const originalError = console.error;

  try {
    console.error = (...args) => {
      loggedErrors.push(args.map(String).join(' '));
    };

    for (const body of malformedBodies) {
      const { file } = newFixture();
      writeFileSync(file, body, 'utf8');

      const store = new Store(file);
      assert.equal(store.data.nextSpaceId, 1);
      assert.deepEqual(store.data.spaces, {});
      assert.deepEqual(store.list(), []);

      const created = store.create({ name: 'after-recovery' });
      assert.equal(created.id, 1);
      assert.equal(created.profileId, 'agent');
      assert.equal(created.pages.p1.targetId, null);

      const persisted = JSON.parse(readFileSync(file, 'utf8'));
      assert.equal(persisted.nextSpaceId, 2);
      assert.equal(persisted.spaces['1'].name, 'after-recovery');
      assert.equal(existsSync(`${file}.${process.pid}.tmp`), false);
    }
  } finally {
    console.error = originalError;
  }

  assert.equal(loggedErrors.length, malformedBodies.length);
});

test('Store treats unknown spaces as errors or no-ops without corrupting an existing space', () => {
  const { file } = newFixture();
  const store = new Store(file);
  const space = store.create({ name: 'edge-space' });
  const bytesBeforeUnknownOperations = readFileSync(file, 'utf8');

  assert.equal(store.nextLabel(999), 'p?');
  assert.doesNotThrow(() => store.setPage(999, 'p1', { title: 'ignored' }));
  assert.doesNotThrow(() => store.removePage(999, 'p1'));
  assert.throws(
    () => store.bindPage(999, 'p1', 'target-edge'),
    /unknown space 999/,
  );
  assert.throws(
    () => store.addPage(999, 'p2', 'target-edge'),
    /unknown space 999/,
  );
  assert.equal(readFileSync(file, 'utf8'), bytesBeforeUnknownOperations);

  assert.equal(store.nextLabel(space.id), 'p2');
  store.bindPage(space.id, 'p1', 'target-edge', 'human');
  assert.equal(store.get(space.id).pages.p1.targetId, 'target-edge');
  assert.equal(store.get(space.id).pages.p1.openedBy, 'human');

  store.setPage(space.id, 'p1', { title: 'Edge title', url: 'https://example.invalid/edge' });
  assert.equal(store.get(space.id).pages.p1.title, 'Edge title');

  store.addPage(space.id, 'p2', 'target-edge-2');
  assert.equal(Object.keys(store.get(space.id).pages).length, 2);
  store.removePage(space.id, 'p2');
  assert.equal(store.get(space.id).pages.p2, undefined);

  const reloaded = new Store(file);
  assert.equal(reloaded.get(space.id).pages.p1.targetId, 'target-edge');
  assert.equal(reloaded.get(space.id).pages.p1.title, 'Edge title');

  store.deleteSpace(space.id);
  assert.equal(store.get(space.id), null);
});

test('Store restores a default label sequence when an older ledger lacks labelSeq', () => {
  const { file } = newFixture();
  const initial = new Store(file);
  const space = initial.create({ name: 'legacy-ledger' });

  const ledger = JSON.parse(readFileSync(file, 'utf8'));
  delete ledger.labelSeq[space.id];
  writeFileSync(file, JSON.stringify(ledger), 'utf8');

  const reloaded = new Store(file);
  assert.equal(reloaded.nextLabel(space.id), 'p2');
  assert.equal(reloaded.data.labelSeq[space.id], 2);
});
