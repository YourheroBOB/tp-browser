// Store boundary / error-path tests that sit beside the existing ledger,
// proto-key, nextSpaceId, labelSeq, and corrupt-JSON suites.
// No network. Ledger files are created only under os.tmpdir().
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../daemon/store.js';

describe('store edge operations', { concurrency: false }, () => {
  let root;
  const origError = console.error;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'tp-fmb-edge-store-'));
  });

  after(() => {
    console.error = origError;
    rmSync(root, { recursive: true, force: true });
  });

  function fileOf(name) {
    return join(root, name);
  }

  function backups(file) {
    const base = basename(file);
    return readdirSync(dirname(file)).filter((n) => n.startsWith(`${base}.corrupt-`));
  }

  function quiet(fn) {
    console.error = () => {};
    try {
      return fn();
    } finally {
      console.error = origError;
    }
  }

  function openRaw(name, raw) {
    const file = fileOf(name);
    if (raw !== undefined) {
      writeFileSync(file, typeof raw === 'string' ? raw : JSON.stringify(raw));
    }
    return { file, store: new Store(file) };
  }

  test('missing file stays empty until a successful create, and delete does not rewind ids', () => {
    const { file, store } = openRaw('fresh.json');
    assert.equal(existsSync(file), false);
    assert.equal(store.nextLabel('missing'), 'p?');
    assert.equal(existsSync(file), false);

    const first = store.create({ name: 'a' });
    const second = store.create({});
    assert.equal(first.profileId, 'agent');
    assert.equal(second.profileId, 'agent');
    assert.equal(second.name, undefined);
    store.deleteSpace(first.id);
    const again = new Store(file);
    assert.equal(again.get(first.id), null);
    assert.equal(again.get(second.id).name, undefined);
    assert.equal(Object.hasOwn(again.data.labelSeq, String(first.id)), false);
    assert.equal(again.data.labelSeq[second.id], 1);
    assert.equal(again.data.nextSpaceId, 3);
    assert.equal(backups(file).length, 0);
  });

  test('create(undefined|null) throws before any ledger file exists', () => {
    const { file, store } = openRaw('create-throws.json');
    assert.throws(() => store.create(), TypeError);
    assert.throws(() => store.create(null), TypeError);
    assert.equal(existsSync(file), false);
    assert.equal(store.data.nextSpaceId, 1);
  });

  test('list returns the live internal object', () => {
    const { file, store } = openRaw('alias.json');
    const created = store.create({ name: 'orig' });
    store.list()[0].name = 'mutated';
    assert.equal(store.get(created.id).name, 'mutated');
    const again = new Store(file);
    assert.equal(again.get(created.id).name, 'orig');
  });

  test('get ignores missing ids and prototype names', () => {
    const { store } = openRaw('get.json');
    store.create({ name: 'n' });
    assert.equal(store.get('nope'), null);
    assert.equal(store.get('toString'), null);
    assert.equal(store.get('__proto__'), null);
  });

  test('setPage merges, addPage replaces, and non-pN labels do not advance nextLabel', () => {
    const { store } = openRaw('merge.json');
    const space = store.create({ name: 'n' });
    store.bindPage(space.id, 'p1', 'T1', 'human');
    assert.doesNotThrow(() => store.setPage(space.id, 'p1', undefined));
    assert.doesNotThrow(() => store.setPage(space.id, 'p1', null));
    store.setPage(space.id, 'p1', { title: 'Hello', url: 'http://127.0.0.1/' });
    assert.deepEqual(store.get(space.id).pages.p1, {
      targetId: 'T1',
      openedBy: 'human',
      title: 'Hello',
      url: 'http://127.0.0.1/',
    });
    store.addPage(space.id, 'p1', 'T2');
    assert.deepEqual(store.get(space.id).pages.p1, {
      targetId: 'T2', openedBy: 'agent', title: '', url: '',
    });
    assert.equal(store.data.labelSeq[space.id], 1);
    store.bindPage(space.id, 'p9', 'T9');
    assert.equal(store.data.labelSeq[space.id], 1);
    assert.equal(store.nextLabel(space.id), 'p2');
    store.addPage(space.id, undefined, 'U');
    assert.equal(store.get(space.id).pages.undefined.targetId, 'U');
    store.bindPage(space.id, '', 'E');
    assert.equal(store.get(space.id).pages[''].targetId, 'E');
  });

  test('reserved labels throw and do not pollute Object.prototype', () => {
    const { store } = openRaw('reserved.json');
    const space = store.create({ name: 'n' });
    for (const label of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      assert.throws(() => store.bindPage(space.id, label, 'T'), new RegExp(`invalid page label ${label}`));
      assert.throws(() => store.addPage(space.id, label, 'T'), new RegExp(`invalid page label ${label}`));
    }
    assert.deepEqual(Object.keys(store.get(space.id).pages), ['p1']);
    assert.equal(Object.prototype.targetId, undefined);
    assert.equal(Object.prototype.title, undefined);
    store.setPage(space.id, '__proto__', { title: 'nope' });
    store.setPage(space.id, 'toString', { title: 'nope' });
    assert.equal(Object.prototype.title, undefined);
    store.bindPage(space.id, 'ToString', 'OK');
    assert.equal(store.get(space.id).pages.ToString.targetId, 'OK');
  });

  test('unknown space throws; missing page and unknown space are no-ops', () => {
    const { store } = openRaw('unknown.json');
    const space = store.create({ name: 'n' });
    assert.throws(() => store.bindPage(99, 'p1', 'T'), /unknown space 99/);
    assert.throws(() => store.addPage('missing', 'p1', 'T'), /unknown space missing/);
    assert.equal(store.get(99), null);
    const keys = Object.keys(store.get(space.id).pages);
    assert.doesNotThrow(() => {
      store.removePage(space.id, 'nope');
      store.setPage(space.id, 'nope', { title: 'x' });
      store.removePage(999, 'p1');
      store.setPage(999, 'p1', { title: 'x' });
      store.deleteSpace(999);
    });
    assert.deepEqual(Object.keys(store.get(space.id).pages), keys);
  });

  test('activeTargetId clears only on strict target equality', () => {
    const { file, store } = openRaw('active.json');
    const space = store.create({ name: 'n' });
    store.bindPage(space.id, 'num', 1);
    store.bindPage(space.id, 'str', '1');
    store.bindPage(space.id, 'zero', 0);
    space.activeTargetId = '1';
    store.removePage(space.id, 'num');
    assert.equal(store.get(space.id).activeTargetId, '1');
    store.removePage(space.id, 'str');
    assert.equal(store.get(space.id).activeTargetId, null);

    store.bindPage(space.id, 'zero', 0);
    store.get(space.id).activeTargetId = 0;
    store.removePage(space.id, 'zero');
    const again = new Store(file);
    assert.equal(again.get(space.id).activeTargetId, null);
    assert.equal(Object.hasOwn(again.get(space.id).pages, 'zero'), false);
  });

  test('falsy own page values are not assigned and do not clear a foreign active id', () => {
    const { store } = openRaw('falsy-page.json');
    const space = store.create({ name: 'n' });
    space.pages.p0 = 0;
    space.pages.pFalse = false;
    space.activeTargetId = 'KEEP';
    store.setPage(space.id, 'p0', { title: 'x' });
    store.setPage(space.id, 'pFalse', { title: 'x' });
    assert.equal(space.pages.p0, 0);
    assert.equal(space.pages.pFalse, false);
    store.removePage(space.id, 'p0');
    assert.equal(space.activeTargetId, 'KEEP');
    assert.equal(Object.hasOwn(space.pages, 'p0'), false);
  });

  test('inherited page names are not updated, removed, or consumed by nextLabel', () => {
    const { store } = openRaw('inherited.json');
    const space = store.create({ name: 'n' });
    const protoPage = { targetId: 'GHOST', title: '', url: '', openedBy: 'agent' };
    const proto = { ghost: protoPage, p2: { targetId: 'INHERITED', title: '', url: '' } };
    space.pages = Object.create(proto);
    space.pages.p1 = { targetId: 'OWN', title: '', url: '', openedBy: 'agent' };
    space.activeTargetId = 'GHOST';
    store.setPage(space.id, 'ghost', { title: 'HACK' });
    assert.equal(protoPage.title, '');
    store.removePage(space.id, 'ghost');
    assert.equal(space.activeTargetId, 'GHOST');
    assert.equal(space.pages.ghost, protoPage);
    store.data.labelSeq[space.id] = 1;
    assert.equal(store.nextLabel(space.id), 'p2');
  });

  test('nextLabel coerces the counter and skips only own pN holes', () => {
    const { store } = openRaw('seq.json');
    const space = store.create({ name: 'n' });
    const cases = [
      [1, [], 'p2'],
      [' 2 ', [], 'p3'],
      ['2abc', [], 'p2'],
      [0, [], 'p2'],
      [-4, [], 'p2'],
      [2.5, [], 'p2'],
      [Infinity, [], 'p2'],
      [true, [], 'p2'],
      [false, [], 'p2'],
      ['', [], 'p2'],
      ['5', ['p2', 'p4'], 'p6'],
    ];
    for (const [current, extra, expected] of cases) {
      store.data.labelSeq[space.id] = current;
      space.pages = { p1: { targetId: null, openedBy: 'agent', title: '', url: '' } };
      for (const label of extra) {
        space.pages[label] = { targetId: null, openedBy: 'agent', title: '', url: '' };
      }
      assert.equal(store.nextLabel(space.id), expected, `current=${JSON.stringify(current)}`);
    }

    store.data.labelSeq[space.id] = 1;
    space.pages = {
      p1: { targetId: null, openedBy: 'agent', title: '', url: '' },
      p2: { targetId: null, openedBy: 'agent', title: '', url: '' },
      p4: { targetId: null, openedBy: 'agent', title: '', url: '' },
    };
    assert.equal(store.nextLabel(space.id), 'p3');
    assert.equal(store.nextLabel(space.id), 'p5');
  });

  test('runtime null labelSeq is repaired; an array labelSeq is wiped on the next load', () => {
    const { file, store } = openRaw('seq-shape.json');
    const space = store.create({ name: 'n' });
    store.data.labelSeq = null;
    assert.equal(store.nextLabel(space.id), 'p2');
    assert.equal(store.data.labelSeq[space.id], 2);

    store.data.labelSeq = [];
    store.nextLabel(space.id);
    const disk = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(Array.isArray(disk.labelSeq), true);
    const again = new Store(file);
    assert.deepEqual(again.data.labelSeq, {});
    assert.equal(again.get(space.id).pages.p1.targetId, null);
  });

  test('array or null pages: nextLabel survives, setPage and removePage throw', () => {
    const { store } = openRaw('pages-shape.json');
    const space = store.create({ name: 'n' });
    space.pages = ['not', 'a', 'map'];
    store.data.labelSeq[space.id] = 1;
    assert.equal(store.nextLabel(space.id), 'p2');

    space.pages = null;
    store.data.labelSeq[space.id] = 1;
    assert.equal(store.nextLabel(space.id), 'p2');
    assert.throws(() => store.setPage(space.id, 'p1', { title: 'x' }), TypeError);
    assert.throws(() => store.removePage(space.id, 'p1'), TypeError);
  });

  test('deleteSpace with a null labelSeq still removes the space', () => {
    const { file, store } = openRaw('del-seq.json');
    const space = store.create({ name: 'n' });
    store.data.labelSeq = null;
    assert.doesNotThrow(() => store.deleteSpace(space.id));
    assert.equal(store.get(space.id), null);
    const again = new Store(file);
    assert.equal(again.get(space.id), null);
    assert.deepEqual(again.data.labelSeq, {});
    assert.equal(again.data.nextSpaceId, 2);
  });

  test('load normalizes nextSpaceId and ignores non-positive or non-integer space keys', () => {
    const cases = [
      [{ nextSpaceId: '9', labelSeq: {}, spaces: { 2: { id: 2, pages: {} } } }, 3],
      [{ nextSpaceId: 2.5, labelSeq: {}, spaces: { 1: { id: 1, pages: {} } } }, 2],
      [{ nextSpaceId: -1, labelSeq: {}, spaces: {} }, 1],
      [{ nextSpaceId: 0, labelSeq: {}, spaces: {} }, 1],
      [{ nextSpaceId: 5, labelSeq: {}, spaces: { 2: { id: 2, pages: {} } } }, 5],
      [{ nextSpaceId: 2, labelSeq: {}, spaces: { 2: { id: 2, pages: {} } } }, 3],
      [{
        nextSpaceId: 1,
        labelSeq: {},
        spaces: {
          0: { id: 0, pages: {} },
          '-3': { id: -3, pages: {} },
          1.5: { id: 1.5, pages: {} },
          4: { id: 4, pages: {} },
        },
      }, 5],
    ];
    for (const [raw, expected] of cases) {
      const { store } = openRaw(`norm-${expected}-${raw.nextSpaceId}.json`, raw);
      assert.equal(store.data.nextSpaceId, expected);
    }

    const big = Number.MAX_SAFE_INTEGER;
    const { store } = openRaw('big.json', {
      nextSpaceId: 1,
      labelSeq: {},
      spaces: { [String(big)]: { id: big, pages: {} } },
    });
    assert.equal(store.data.nextSpaceId, big + 1);
  });

  test('load replaces bad labelSeq values and keeps a real object', () => {
    for (const labelSeq of [null, [], 0, 'x', true]) {
      const { store } = openRaw(`seq-bad-${typeof labelSeq}.json`, { nextSpaceId: 1, labelSeq, spaces: {} });
      assert.deepEqual(store.data.labelSeq, {});
    }
    const { store } = openRaw('seq-keep.json', { nextSpaceId: 1, labelSeq: { 3: 4 }, spaces: {} });
    assert.deepEqual(store.data.labelSeq, { 3: 4 });
  });

  test('space object keys, not the inner id field, drive nextSpaceId', () => {
    const { store } = openRaw('key-vs-id.json', {
      nextSpaceId: 1,
      labelSeq: {},
      spaces: { 10: { id: 1, name: 'm', pages: {} } },
    });
    assert.equal(store.data.nextSpaceId, 11);
    const created = store.create({ name: 'n' });
    assert.equal(created.id, 11);
    assert.equal(store.get(10).id, 1);
    assert.equal(store.list().length, 2);
  });

  test('spaces null is not defaulted; failed create still advances the in-memory counter', () => {
    const { file, store } = openRaw('spaces-null.json', {
      nextSpaceId: 4,
      labelSeq: { 1: 2 },
      spaces: null,
    });
    assert.equal(store.data.nextSpaceId, 4);
    assert.deepEqual(store.data.labelSeq, { 1: 2 });
    assert.equal(store.data.spaces, null);
    assert.throws(() => store.list(), TypeError);
    assert.throws(() => store.get(1), TypeError);
    assert.throws(() => store.create({ name: 'n' }), TypeError);
    assert.equal(store.data.nextSpaceId, 5);
    const disk = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(disk.spaces, null);
    assert.equal(disk.nextSpaceId, 4);
    const again = new Store(file);
    assert.equal(again.data.nextSpaceId, 4);
    assert.deepEqual(again.data.labelSeq, { 1: 2 });
  });

  test('non-object roots are backed up and replaced with an empty ledger', () => {
    const arrayCase = quiet(() => openRaw('root-array.json', '[]'));
    assert.equal(arrayCase.store.data.nextSpaceId, 1);
    assert.deepEqual(arrayCase.store.data.spaces, {});
    assert.equal(backups(arrayCase.file).length, 1);
    assert.equal(readFileSync(join(dirname(arrayCase.file), backups(arrayCase.file)[0]), 'utf8'), '[]');

    const messages = [];
    console.error = (...args) => messages.push(args.join(' '));
    let numberStore;
    const numberFile = fileOf('root-number.json');
    try {
      writeFileSync(numberFile, '0');
      numberStore = new Store(numberFile);
    } finally {
      console.error = origError;
    }
    assert.match(messages.join('\n'), /ledger root is not an object \(got number\)/);
    assert.equal(numberStore.data.nextSpaceId, 1);
    assert.equal(readFileSync(join(dirname(numberFile), backups(numberFile)[0]), 'utf8'), '0');
  });

  test('a UTF-8 BOM makes otherwise valid JSON unloadable and preserves the original bytes', () => {
    const body = `\uFEFF${JSON.stringify({ nextSpaceId: 3, labelSeq: { a: 1 }, spaces: {} })}`;
    const { file, store } = quiet(() => openRaw('bom.json', body));
    assert.equal(store.data.nextSpaceId, 1);
    assert.deepEqual(store.data.labelSeq, {});
    assert.equal(backups(file).length, 1);
    const saved = readFileSync(join(dirname(file), backups(file)[0]), 'utf8');
    assert.equal(saved.charCodeAt(0), 0xfeff);
    assert.equal(saved.includes('"nextSpaceId":3'), true);
  });

  test('a directory ledger path loads fresh and persist fails without leaving a tmp sibling', () => {
    const dir = fileOf('ledger-dir');
    mkdirSync(dir);
    const { store } = quiet(() => ({ store: new Store(dir) }));
    assert.equal(store.data.nextSpaceId, 1);
    assert.equal(backups(dir).length, 0);
    const tmp = `${dir}.${process.pid}.tmp`;
    assert.throws(() => store.persist());
    assert.equal(existsSync(tmp), false);
    assert.equal(statSync(dir).isDirectory(), true);
  });
});
