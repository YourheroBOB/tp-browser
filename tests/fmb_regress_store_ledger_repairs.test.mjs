// 回歸：daemon/store.js 註解裡已修過、且未被既有 nextSpaceId 缺失／proto／collision／
// corrupt-backup 檔名對上的分支。只使用 tmpdir，不連線、不讀寫 repo 以外的路徑。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../daemon/store.js';

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-regress-store-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function loadStore(file) {
  const orig = console.error;
  const lines = [];
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  try {
    return { store: new Store(file), logs: lines };
  } finally {
    console.error = orig;
  }
}

function baseSpace(id, name, targetId) {
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

test('lagging nextSpaceId is raised above every positive integer key and does not clobber spaces', () => {
  withTmp((dir) => {
    const file = join(dir, 'ledger.json');
    writeFileSync(file, JSON.stringify({
      nextSpaceId: 1,
      labelSeq: { 1: 4 },
      spaces: {
        0: { id: 0, name: 'zero' },
        '-1': { id: -1, name: 'neg' },
        1: baseSpace(1, 'original', 'STILL-HERE'),
        4: baseSpace(4, 'high', null),
        note: { id: 'note', name: 'text-key', pages: {} },
      },
    }));
    const { store, logs } = loadStore(file);
    assert.equal(logs.length, 0);
    assert.equal(store.data.nextSpaceId, 5);
    assert.equal(store.data.labelSeq[1], 4);
    const created = store.create({ name: 'fresh' });
    assert.equal(created.id, 5);
    assert.equal(store.data.nextSpaceId, 6);
    assert.equal(store.get(1).pages.p1.targetId, 'STILL-HERE');
    assert.equal(store.get(1).activeTargetId, 'STILL-HERE');
    assert.equal(store.get(4).name, 'high');
    assert.equal(store.get('note').name, 'text-key');
    assert.equal(store.get(0).name, 'zero');
    assert.equal(Object.hasOwn(store.data.spaces, 'NaN'), false);
    const disk = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(disk.nextSpaceId, 6);
    assert.equal(disk.spaces['1'].pages.p1.targetId, 'STILL-HERE');
    assert.equal(disk.labelSeq['1'], 4);
    assert.equal(disk.labelSeq['5'], 1);
  });
});

test('non-integer nextSpaceId is rewritten so create never persists a NaN id', () => {
  for (const bad of ['x', 1.5, 0, -2, true]) {
    withTmp((dir) => {
      const file = join(dir, 'ledger.json');
      writeFileSync(file, JSON.stringify({
        nextSpaceId: bad,
        labelSeq: {},
        spaces: { 4: baseSpace(4, 'high', 'KEEP-4') },
      }));
      const { store } = loadStore(file);
      const created = store.create({ name: 'fresh' });
      assert.equal(created.id, 5, `nextSpaceId ${JSON.stringify(bad)}`);
      assert.equal(store.get(4).pages.p1.targetId, 'KEEP-4');
      const disk = JSON.parse(readFileSync(file, 'utf8'));
      assert.equal(Object.hasOwn(disk.spaces, 'NaN'), false);
      assert.equal(Number.isInteger(disk.nextSpaceId), true);
      assert.equal(disk.spaces['5'].name, 'fresh');
    });
  }
});

test('labelSeq that is null, an array, or a scalar is replaced before create', () => {
  for (const bad of [null, [], 'abc', 5, 1.2]) {
    withTmp((dir) => {
      const file = join(dir, 'ledger.json');
      writeFileSync(file, JSON.stringify({
        nextSpaceId: 3,
        labelSeq: bad,
        spaces: { 2: baseSpace(2, 'kept', 'KEEP-2') },
      }));
      const { store } = loadStore(file);
      assert.equal(Array.isArray(store.data.labelSeq), false);
      assert.equal(typeof store.data.labelSeq, 'object');
      const created = store.create({ name: 'fresh' });
      assert.equal(created.id, 3, `labelSeq ${JSON.stringify(bad)}`);
      assert.equal(store.get(2).pages.p1.targetId, 'KEEP-2');
      assert.equal(store.data.labelSeq[3], 1);
      const disk = JSON.parse(readFileSync(file, 'utf8'));
      assert.equal(Array.isArray(disk.labelSeq), false);
      assert.equal(disk.labelSeq['3'], 1);
      assert.equal(disk.spaces['2'].name, 'kept');
    });
  }
});

test('deleteSpace drops that space labelSeq entry and leaves the sibling intact', () => {
  withTmp((dir) => {
    const file = join(dir, 'ledger.json');
    const { store } = loadStore(file);
    const a = store.create({ name: 'a' });
    const b = store.create({ name: 'b' });
    assert.equal(store.nextLabel(a.id), 'p2');
    store.deleteSpace(a.id);
    assert.equal(store.get(a.id), null);
    assert.equal(Object.hasOwn(store.data.labelSeq, String(a.id)), false);
    assert.equal(store.data.labelSeq[b.id], 1);
    assert.equal(store.get(b.id).name, 'b');
    const disk = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(Object.hasOwn(disk.labelSeq, String(a.id)), false);
    assert.equal(disk.labelSeq[String(b.id)], 1);
    assert.equal(disk.spaces[String(b.id)].pages.p1.targetId, null);
    const { store: again } = loadStore(file);
    assert.equal(again.get(a.id), null);
    assert.equal(again.get(b.id).name, 'b');
    assert.equal(Object.hasOwn(again.data.labelSeq, String(a.id)), false);
  });
});

test('removePage clears activeTargetId only when the removed page owns that target', () => {
  withTmp((dir) => {
    const file = join(dir, 'ledger.json');
    const { store } = loadStore(file);
    const space = store.create({ name: 'ride' });
    store.bindPage(space.id, 'p2', 'TARGET-KEEP');
    store.bindPage(space.id, 'p3', 'TARGET-DROP');
    space.activeTargetId = 'TARGET-DROP';
    store.removePage(space.id, 'p1');
    assert.equal(store.get(space.id).activeTargetId, 'TARGET-DROP');
    const afterP1 = JSON.parse(readFileSync(file, 'utf8')).spaces[String(space.id)];
    assert.equal(afterP1.activeTargetId, 'TARGET-DROP');
    assert.equal(afterP1.pages.p2.targetId, 'TARGET-KEEP');
    assert.equal(afterP1.pages.p3.targetId, 'TARGET-DROP');
    assert.equal(Object.hasOwn(afterP1.pages, 'p1'), false);
    store.removePage(space.id, 'p2');
    assert.equal(store.get(space.id).activeTargetId, 'TARGET-DROP');
    const afterP2 = JSON.parse(readFileSync(file, 'utf8')).spaces[String(space.id)];
    assert.equal(afterP2.activeTargetId, 'TARGET-DROP');
    assert.equal(Object.hasOwn(afterP2.pages, 'p2'), false);
    assert.equal(afterP2.pages.p3.targetId, 'TARGET-DROP');
    store.removePage(space.id, 'p3');
    assert.equal(store.get(space.id).activeTargetId, null);
    const saved = JSON.parse(readFileSync(file, 'utf8')).spaces[String(space.id)];
    assert.equal(saved.activeTargetId, null);
    assert.equal(Object.hasOwn(saved.pages, 'p1'), false);
    assert.equal(Object.hasOwn(saved.pages, 'p2'), false);
    assert.equal(Object.hasOwn(saved.pages, 'p3'), false);
  });
});

test('removePage ignores inherited labels and does not clear activeTargetId', () => {
  withTmp((dir) => {
    const file = join(dir, 'ledger.json');
    const { store } = loadStore(file);
    const space = store.create({ name: 'ride' });
    const ghost = { targetId: 'NO-TOUCH', openedBy: 'agent', title: 'safe', url: '' };
    const pages = Object.create({ ghost });
    pages.p1 = space.pages.p1;
    space.pages = pages;
    space.activeTargetId = 'NO-TOUCH';
    store.persist();
    store.removePage(space.id, 'ghost');
    assert.equal(space.activeTargetId, 'NO-TOUCH');
    assert.equal(ghost.targetId, 'NO-TOUCH');
    assert.equal(ghost.title, 'safe');
    assert.equal(Object.hasOwn(pages, 'ghost'), false);
    const disk = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(disk.spaces[String(space.id)].activeTargetId, 'NO-TOUCH');
  });
});

test('setPage does not assign through an inherited label or __proto__', () => {
  try {
    withTmp((dir) => {
      const file = join(dir, 'ledger.json');
      const { store } = loadStore(file);
      const space = store.create({ name: 'ride' });
      const proto = { inherited: { targetId: 'T', openedBy: 'agent', title: 'safe', url: '' } };
      const pages = Object.create(proto);
      pages.p1 = space.pages.p1;
      space.pages = pages;
      store.persist();
      const before = readFileSync(file);
      assert.doesNotThrow(() => store.setPage(space.id, 'inherited', { title: 'pwned' }));
      assert.doesNotThrow(() => store.setPage(space.id, '__proto__', { fmbRegressTitle: 'pwned' }));
      assert.equal(proto.inherited.title, 'safe');
      assert.equal(Object.prototype.fmbRegressTitle, undefined);
      assert.deepEqual(readFileSync(file), before);
    });
  } finally {
    delete Object.prototype.fmbRegressTitle;
  }
});

test('get returns null for a space id that exists only on the prototype', () => {
  withTmp((dir) => {
    const file = join(dir, 'ledger.json');
    const { store } = loadStore(file);
    const ghost = { id: 99, name: 'ghost', pages: {} };
    store.data.spaces = Object.create({ 99: ghost });
    store.data.spaces[1] = baseSpace(1, 'own', 'OWN-T');
    assert.equal(store.get(99), null);
    assert.equal(store.get('99'), null);
    assert.equal(store.get(1).name, 'own');
    assert.equal(store.get(1).pages.p1.targetId, 'OWN-T');
  });
});

test('a JSON array, null, or scalar ledger root is copied aside and the store starts empty', () => {
  const cases = [
    ['[]', /got array/],
    ['null', /got object/],
    ['true', /got boolean/],
    ['"x"', /got string/],
  ];
  for (const [raw, message] of cases) {
    withTmp((dir) => {
      const file = join(dir, 'ledger.json');
      writeFileSync(file, raw);
      const { store, logs } = loadStore(file);
      assert.match(logs.join('\n'), /store load failed, starting fresh:/);
      assert.match(logs.join('\n'), message);
      assert.deepEqual(store.list(), []);
      const backups = readdirSync(dir).filter((name) => name.includes('.corrupt-'));
      assert.equal(backups.length, 1);
      assert.match(backups[0], /\.corrupt-\d+$/);
      assert.equal(backups[0].endsWith('.tmp'), false);
      assert.equal(readFileSync(join(dir, backups[0]), 'utf8'), raw);
      const created = store.create({ name: 'recovered' });
      assert.equal(created.id, 1);
      assert.equal(readFileSync(join(dir, backups[0]), 'utf8'), raw);
      const disk = JSON.parse(readFileSync(file, 'utf8'));
      assert.equal(disk.spaces['1'].name, 'recovered');
    });
  }
});

test('persist removes the pid tmp file when rename and the direct write both fail', () => {
  withTmp((dir) => {
    const asDir = join(dir, 'ledger.json');
    mkdirSync(asDir);
    const { store, logs } = loadStore(asDir);
    assert.match(logs.join('\n'), /store load failed/);
    assert.equal(statSync(asDir).isDirectory(), true);
    assert.deepEqual(store.list(), []);
    assert.throws(() => store.persist());
    const leftovers = readdirSync(dir).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
    assert.equal(statSync(asDir).isDirectory(), true);
  });
});

test('nextLabel tolerates a null pages object and a numeric-string sequence', () => {
  withTmp((dir) => {
    const file = join(dir, 'ledger.json');
    const { store } = loadStore(file);
    const space = store.create({ name: 'ride' });
    space.pages = null;
    assert.equal(store.nextLabel(space.id), 'p2');
    assert.equal(store.data.labelSeq[space.id], 2);
    space.pages = {
      p1: { targetId: null, openedBy: 'agent', title: '', url: '' },
      p2: { targetId: 'A', openedBy: 'agent', title: '', url: '' },
      p3: { targetId: 'B', openedBy: 'agent', title: '', url: '' },
    };
    store.data.labelSeq[space.id] = '2';
    assert.equal(store.nextLabel(space.id), 'p4');
    assert.equal(store.data.labelSeq[space.id], 4);
    const disk = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(disk.labelSeq[String(space.id)], 4);
    assert.equal(disk.spaces[String(space.id)].pages.p2.targetId, 'A');
    assert.equal(disk.spaces[String(space.id)].pages.p3.targetId, 'B');
  });
});

test('nextLabel on an unknown space returns p? and does not rewrite the ledger', () => {
  withTmp((dir) => {
    const file = join(dir, 'ledger.json');
    const { store } = loadStore(file);
    store.create({ name: 'a' });
    const before = readFileSync(file);
    assert.equal(store.nextLabel(999999), 'p?');
    assert.deepEqual(readFileSync(file), before);
  });
});
