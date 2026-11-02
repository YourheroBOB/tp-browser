// Boundary / error-path coverage for daemon/store.js.
// Selects cases that are not the named nextSpaceId-missing, labelSeq-missing,
// prototype-key, nextLabel-collision, corrupt-JSON, or persist-tmp scenarios.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../daemon/store.js';

function withSilentConsole(fn) {
  const prev = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = prev;
  }
}

function withStore(fixture, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tp-fmb-edge-'));
  const file = join(dir, 'ledger.json');
  try {
    if (fixture !== undefined) {
      writeFileSync(file, typeof fixture === 'string' ? fixture : JSON.stringify(fixture));
    }
    const store = withSilentConsole(() => new Store(file));
    return fn({ dir, file, store });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('non-integer nextSpaceId becomes maxId+1 and numeric strings are not parsed', () => {
  withStore({ nextSpaceId: '100', labelSeq: {}, spaces: { 7: { id: 7 } } }, ({ store }) => {
    assert.equal(store.data.nextSpaceId, 8);
  });
  withStore({ nextSpaceId: 4.2, labelSeq: {}, spaces: {} }, ({ store }) => {
    assert.equal(store.data.nextSpaceId, 1);
  });
  withStore({ nextSpaceId: 0, labelSeq: {}, spaces: { 3: { id: 3 } } }, ({ store }) => {
    assert.equal(store.data.nextSpaceId, 4);
  });
  withStore({ nextSpaceId: -5, labelSeq: {}, spaces: { 3: { id: 3 } } }, ({ store }) => {
    assert.equal(store.data.nextSpaceId, 4);
  });
  withStore({ nextSpaceId: true, labelSeq: {}, spaces: { 3: { id: 3 } } }, ({ store }) => {
    assert.equal(store.data.nextSpaceId, 4);
  });
  withStore({ nextSpaceId: 9, labelSeq: {}, spaces: { 2: { id: 2 } } }, ({ store }) => {
    assert.equal(store.data.nextSpaceId, 9);
    assert.equal(store.create({ name: 'gap' }).id, 9);
  });
});

test('only positive integer space keys raise the nextSpaceId floor', () => {
  withStore({
    nextSpaceId: 3,
    labelSeq: {},
    spaces: { '0': { id: 0 }, '-2': { id: -2 }, '1.5': { id: 1.5 }, x: {}, '08': { id: '08' } },
  }, ({ store }) => {
    assert.equal(store.data.nextSpaceId, 9);
  });
  withStore({
    nextSpaceId: 50,
    labelSeq: {},
    spaces: { '1e2': { id: '1e2' }, 5: { id: 5 } },
  }, ({ store }) => {
    assert.equal(store.data.nextSpaceId, 101);
  });
});

test('a non-object labelSeq is replaced and its previous counter is discarded', () => {
  for (const labelSeq of [null, 5, 'seq', [5], true, false]) {
    withStore({
      nextSpaceId: 2,
      labelSeq,
      spaces: { 1: { id: 1, pages: { p1: { targetId: null } } } },
    }, ({ store }) => {
      assert.deepEqual(store.data.labelSeq, {}, `shape ${JSON.stringify(labelSeq)}`);
      assert.equal(store.nextLabel(1), 'p2');
      assert.equal(store.data.labelSeq[1], 2);
    });
  }
  withStore({
    nextSpaceId: 2,
    labelSeq: { 1: 4 },
    spaces: { 1: { id: 1, pages: { p1: { targetId: null } } } },
  }, ({ store }) => {
    assert.equal(store.nextLabel(1), 'p5');
    assert.equal(store.data.labelSeq[1], 5);
  });
});

test('nextLabel coerces bad counters and never emits p1', () => {
  withStore(undefined, ({ store }) => {
    const cases = [
      [0, 'p2', 2],
      [-3, 'p2', 2],
      [1.5, 'p2', 2],
      [Infinity, 'p2', 2],
      ['4', 'p5', 5],
      ['4.5', 'p2', 2],
      [true, 'p2', 2],
      [false, 'p2', 2],
      ['', 'p2', 2],
      [{}, 'p2', 2],
    ];
    for (const [seq, label, stored] of cases) {
      const space = store.create({ name: 'seq' });
      store.data.labelSeq[space.id] = seq;
      assert.equal(store.nextLabel(space.id), label, `seq ${JSON.stringify(seq)}`);
      assert.equal(store.data.labelSeq[space.id], stored);
    }
  });
});

test('nextLabel does not treat inherited pN keys as occupied', () => {
  withStore(undefined, ({ store }) => {
    const space = store.create({ name: 'own-keys' });
    const proto = { p2: { targetId: 'T-PROTO' } };
    const pages = Object.create(proto);
    pages.p1 = space.pages.p1;
    space.pages = pages;
    store.data.labelSeq[space.id] = 1;
    assert.equal(store.nextLabel(space.id), 'p2');
    assert.equal(Object.hasOwn(space.pages, 'p2'), false);
    assert.equal(proto.p2.targetId, 'T-PROTO');
  });
});

test('setPage ignores inherited labels and null pages and does not persist them', () => {
  withStore(undefined, ({ file, store }) => {
    const space = store.create({ name: 'inherit' });
    const before = readFileSync(file, 'utf8');
    const inherited = { targetId: 'T-INHERITED', openedBy: 'agent', title: '', url: '' };
    const pages = Object.create({ pInherit: inherited });
    pages.p1 = space.pages.p1;
    space.pages = pages;
    store.setPage(space.id, 'pInherit', { title: 'mutated' });
    assert.equal(inherited.title, '');
    assert.equal(Object.hasOwn(pages, 'pInherit'), false);
    space.pages.pNull = null;
    store.setPage(space.id, 'pNull', { title: 'mutated' });
    assert.equal(space.pages.pNull, null);
    assert.equal(readFileSync(file, 'utf8'), before);
  });
});

test('setPage merges a patch and leaves unspecified page fields in place', () => {
  withStore(undefined, ({ store }) => {
    const space = store.create({ name: 'merge' });
    store.bindPage(space.id, 'p2', 'T-EDGE', 'edge-opener');
    store.setPage(space.id, 'p2', { title: 'edge-title', url: 'http://127.0.0.1/edge' });
    const page = store.get(space.id).pages.p2;
    assert.equal(page.targetId, 'T-EDGE');
    assert.equal(page.openedBy, 'edge-opener');
    assert.equal(page.title, 'edge-title');
    assert.equal(page.url, 'http://127.0.0.1/edge');
  });
});

test('removePage clears activeTargetId only on an exact target match', () => {
  withStore(undefined, ({ file, store }) => {
    const space = store.create({ name: 'active' });
    const id = space.id;
    store.bindPage(id, 'p2', 'T-A', 'agent');
    store.bindPage(id, 'p3', 'T-B', 'agent');
    space.activeTargetId = 'T-B';
    store.setPage(id, 'p2', {});
    store.removePage(id, 'p2');
    assert.equal(space.activeTargetId, 'T-B');
    store.removePage(id, 'p3');
    assert.equal(space.activeTargetId, null);

    store.bindPage(id, 'p4', 'T-SHARED', 'agent');
    store.bindPage(id, 'p5', 'T-SHARED', 'agent');
    space.activeTargetId = 'T-SHARED';
    store.setPage(id, 'p4', {});
    store.removePage(id, 'p4');
    assert.equal(space.activeTargetId, null);
    assert.equal(space.pages.p5.targetId, 'T-SHARED');

    store.bindPage(id, 'p6', 'T-TEMP', 'agent');
    space.pages.p6.targetId = 0;
    space.activeTargetId = 0;
    store.setPage(id, 'p6', { title: 'zero' });
    store.removePage(id, 'p6');
    assert.equal(space.activeTargetId, null);

    store.bindPage(id, 'p7', 'T-TEMP', 'agent');
    space.pages.p7.targetId = 0;
    space.activeTargetId = '0';
    store.setPage(id, 'p7', {});
    store.removePage(id, 'p7');
    assert.equal(space.activeTargetId, '0');

    store.bindPage(id, 'p8', 'T-NULL', 'agent');
    space.pages.p8.targetId = null;
    space.activeTargetId = 'T-STILL';
    store.setPage(id, 'p8', {});
    store.removePage(id, 'p8');
    assert.equal(space.activeTargetId, 'T-STILL');

    const reloaded = new Store(file);
    assert.equal(reloaded.get(id).activeTargetId, 'T-STILL');
    assert.equal(reloaded.get(id).pages.p5.targetId, 'T-SHARED');
    assert.equal(Object.hasOwn(reloaded.get(id).pages, 'p3'), false);
  });
});

test('removePage and setPage ignore unknown targets without rewriting the file', () => {
  withStore(undefined, ({ file, store }) => {
    const space = store.create({ name: 'quiet' });
    const before = readFileSync(file, 'utf8');
    store.removePage(space.id, 'missing');
    store.removePage(999999, 'p1');
    store.setPage(space.id, 'missing', { title: 'nope' });
    store.setPage(999999, 'p1', { title: 'nope' });
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.equal(space.pages.p1.title, '');
  });
});

test('a corrupt space throws on page mutation but nextLabel still returns p2', () => {
  withStore(undefined, ({ store }) => {
    const bad = store.create({ name: 'bad-shape' });
    store.data.spaces[bad.id] = 'bad';
    assert.throws(() => store.bindPage(bad.id, 'p9', 'T-EDGE'), TypeError);
    assert.throws(() => store.setPage(bad.id, 'p1', { title: 'x' }), TypeError);
    assert.throws(() => store.removePage(bad.id, 'p1'), TypeError);
    assert.equal(store.nextLabel(bad.id), 'p2');

    const nullPages = store.create({ name: 'null-pages' });
    nullPages.pages = null;
    assert.throws(() => store.removePage(nullPages.id, 'p1'), TypeError);
    assert.throws(() => store.addPage(nullPages.id, 'p9', 'T-EDGE'), TypeError);
    assert.equal(store.nextLabel(nullPages.id), 'p2');
  });
});

test('null or missing spaces fail closed and do not persist a partial create', () => {
  for (const fixture of [
    { nextSpaceId: 4, labelSeq: {}, spaces: null },
    { nextSpaceId: 4, labelSeq: {} },
  ]) {
    withStore(fixture, ({ file, store }) => {
      assert.throws(() => store.list(), TypeError);
      assert.throws(() => store.get(1), TypeError);
      const before = readFileSync(file, 'utf8');
      assert.throws(() => store.create({ name: 'x' }), TypeError);
      assert.equal(store.data.nextSpaceId, 5);
      assert.equal(readFileSync(file, 'utf8'), before);
    });
  }
});

test('loading spaces as an array lets create punch a null hole that round-trips', () => {
  withStore({ nextSpaceId: 1, labelSeq: {}, spaces: [] }, ({ file, store }) => {
    assert.ok(Array.isArray(store.data.spaces));
    const space = store.create({ name: 'hole' });
    assert.equal(space.id, 1);
    const reloaded = new Store(file);
    assert.ok(Array.isArray(reloaded.data.spaces));
    assert.equal(reloaded.list()[0], null);
    assert.equal(reloaded.get(1).name, 'hole');
    assert.equal(reloaded.data.labelSeq[1], 1);
  });
});

test('page labels are rejected only for exact Object.prototype names', () => {
  withStore(undefined, ({ file, store }) => {
    const space = store.create({ name: 'labels' });
    const before = readFileSync(file, 'utf8');
    assert.throws(
      () => store.bindPage(space.id, '__lookupGetter__', 'T-EDGE'),
      (err) => err instanceof Error && err.message === 'invalid page label __lookupGetter__',
    );
    assert.throws(
      () => store.addPage(space.id, 'toLocaleString', 'T-EDGE'),
      (err) => err instanceof Error && err.message === 'invalid page label toLocaleString',
    );
    assert.equal(readFileSync(file, 'utf8'), before);
    store.bindPage(space.id, '__lookupGetter__ ', 'T-TRAIL');
    store.addPage(space.id, '', 'T-EMPTY');
    store.bindPage(space.id, 12, 'T-NUM');
    const pages = new Store(file).get(space.id).pages;
    assert.equal(pages['__lookupGetter__ '].targetId, 'T-TRAIL');
    assert.equal(pages[''].targetId, 'T-EMPTY');
    assert.equal(pages['12'].targetId, 'T-NUM');
    assert.equal(Object.hasOwn(pages, '__lookupGetter__'), false);
  });
});

test('create omits an undefined name and keeps an explicit null profileId', () => {
  withStore(undefined, ({ file, store }) => {
    const a = store.create({});
    assert.equal(a.profileId, 'agent');
    assert.equal(a.name, undefined);
    assert.equal(a.ownership, 'agent');
    assert.equal(a.state, 'active');
    assert.equal(a.pages.p1.targetId, null);
    assert.equal(Number.isNaN(Date.parse(a.createdAt)), false);

    const b = store.create({ name: 'edge', profileId: null });
    assert.equal(b.profileId, null);
    const c = store.create({ name: 'edge-default', profileId: undefined });
    assert.equal(c.profileId, 'agent');

    const disk = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(Object.hasOwn(disk.spaces[String(a.id)], 'name'), false);
    assert.equal(disk.spaces[String(b.id)].profileId, null);
    assert.equal(disk.spaces[String(c.id)].profileId, 'agent');
  });
});

test('deleteSpace removes that labelSeq entry and does not reuse the id', () => {
  withStore(undefined, ({ file, store }) => {
    const a = store.create({ name: 'a' });
    const b = store.create({ name: 'b' });
    store.deleteSpace(a.id);
    store.deleteSpace('missing');
    const disk = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(Object.hasOwn(disk.spaces, String(a.id)), false);
    assert.equal(Object.hasOwn(disk.labelSeq, String(a.id)), false);
    assert.equal(disk.labelSeq[String(b.id)], 1);
    assert.equal(store.get(b.id).name, 'b');
    const c = store.create({ name: 'c' });
    assert.equal(c.id, b.id + 1);
    assert.equal(Object.hasOwn(store.data.labelSeq, String(a.id)), false);
  });
});

test('a boolean ledger root is backed up and replaced with an empty ledger', () => {
  withStore('true', ({ dir, store }) => {
    const backups = readdirSync(dir).filter((name) => name.startsWith('ledger.json.corrupt-'));
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(join(dir, backups[0]), 'utf8'), 'true');
    assert.deepEqual(store.data, { nextSpaceId: 1, labelSeq: {}, spaces: {} });
  });
});

test('loading a directory does not throw and does not write a corrupt backup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-fmb-edge-'));
  const asFile = join(dir, 'not-a-file');
  mkdirSync(asFile);
  try {
    const store = withSilentConsole(() => new Store(asFile));
    assert.deepEqual(store.data, { nextSpaceId: 1, labelSeq: {}, spaces: {} });
    assert.deepEqual(readdirSync(dir), ['not-a-file']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
