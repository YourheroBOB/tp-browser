// Store 回歸：activeTargetId、labelSeq、nextSpaceId 正規化、保留 label、畸形 ledger。
// 只讀寫 os.tmpdir()。node:test 的 todo 等同 xfail：斷言失敗不讓行程失敗。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../daemon/store.js';

const NOW_ISO = '2026-06-01T00:00:00.000Z';

function page(targetId, extra = {}) {
  return {
    targetId,
    openedBy: extra.openedBy ?? 'agent',
    title: extra.title ?? '',
    url: extra.url ?? '',
  };
}

function space(id, pages, extra = {}) {
  return {
    id,
    name: extra.name ?? `s${id}`,
    profileId: 'agent',
    ownership: 'agent',
    state: 'active',
    createdAt: extra.createdAt ?? NOW_ISO,
    pages,
    activeTargetId: extra.activeTargetId ?? null,
  };
}

describe('Store activeTarget, labelSeq, and ledger shape', { concurrency: false }, () => {
  let root;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'tp-fmb-store-'));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const file = (name) => join(root, name);

  function writeLedger(name, data) {
    const path = file(name);
    writeFileSync(path, JSON.stringify(data));
    return path;
  }

  function backupsFor(name) {
    return readdirSync(root).filter((entry) => entry.startsWith(`${name}.corrupt-`));
  }

  it('does not create a ledger until the first persist, and creates nested parents', () => {
    const missing = file('missing.json');
    const store = new Store(missing);
    assert.equal(existsSync(missing), false);
    assert.equal(store.list().length, 0);
    assert.equal(store.get(1), null);

    const nested = join(root, 'nested', 'a', 'ledger.json');
    const deep = new Store(nested);
    deep.create({ name: 'deep' });
    assert.equal(JSON.parse(readFileSync(nested, 'utf8')).spaces['1'].name, 'deep');
  });

  it('backs up a non-object ledger root without using a .tmp suffix, then create works', () => {
    const samples = [
      ['root-array.json', '[]'],
      ['root-null.json', 'null'],
      ['root-text.json', '"x"'],
      ['root-ws.json', ' \n'],
    ];
    for (const [name, raw] of samples) {
      const path = file(name);
      writeFileSync(path, raw);
      const store = new Store(path);
      const backups = backupsFor(name);
      assert.equal(backups.length, 1, name);
      assert.equal(backups[0].endsWith('.tmp'), false);
      assert.equal(readFileSync(join(root, backups[0]), 'utf8'), raw);
      assert.equal(readFileSync(path, 'utf8'), raw);
      const created = store.create({ name: 'fresh' });
      assert.equal(created.id, 1);
      assert.equal(readFileSync(join(root, backups[0]), 'utf8'), raw);
      const disk = JSON.parse(readFileSync(path, 'utf8'));
      assert.equal(disk.spaces['1'].name, 'fresh');
      assert.equal(disk.labelSeq['1'], 1);
      assert.equal(disk.nextSpaceId, 2);
    }
  });

  it('does not back up a valid ledger and keeps unknown fields', () => {
    const path = writeLedger('extra.json', {
      nextSpaceId: 2,
      labelSeq: { 1: 1 },
      spaces: {
        1: { ...space(1, { p1: page('T-keep', { openedBy: 'human', title: 'stay' }) }), custom: 'keep' },
      },
    });
    const store = new Store(path);
    assert.deepEqual(backupsFor('extra.json'), []);
    assert.equal(store.get(1).custom, 'keep');
    assert.equal(store.get(1).pages.p1.openedBy, 'human');
    assert.equal(store.get(1).pages.p1.title, 'stay');
    store.create({ name: 'next' });
    const disk = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(disk.spaces['1'].custom, 'keep');
    assert.equal(disk.spaces['1'].pages.p1.targetId, 'T-keep');
    assert.equal(disk.nextSpaceId, 3);
  });

  it('bumps a nextSpaceId that is behind the max id and does not overwrite that space', () => {
    const path = writeLedger('behind.json', {
      nextSpaceId: 2,
      labelSeq: { 1: 1, 5: 3 },
      spaces: {
        1: space(1, { p1: page(null) }),
        5: space(5, { p1: page('T-keep', { title: 'stay' }) }, { name: 'keep-me' }),
      },
    });
    const store = new Store(path);
    const created = store.create({ name: 'new' });
    assert.equal(created.id, 6);
    assert.equal(store.get(5).name, 'keep-me');
    assert.equal(store.get(5).pages.p1.targetId, 'T-keep');
    assert.equal(store.get(5).pages.p1.title, 'stay');
    const disk = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(disk.nextSpaceId, 7);
    assert.equal(disk.labelSeq['5'], 3);
    assert.equal(disk.labelSeq['1'], 1);
    assert.equal(disk.labelSeq['6'], 1);
    assert.equal(disk.spaces['5'].pages.p1.title, 'stay');
  });

  it('keeps a nextSpaceId already past the max id', () => {
    const path = writeLedger('ahead.json', {
      nextSpaceId: 10,
      labelSeq: {},
      spaces: { 2: space(2, { p1: page(null) }) },
    });
    const store = new Store(path);
    assert.equal(store.create({ name: 'n' }).id, 10);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).nextSpaceId, 11);
  });

  it('replaces a non-integer nextSpaceId with maxId+1', () => {
    const path = writeLedger('str-next.json', {
      nextSpaceId: '99',
      labelSeq: {},
      spaces: { 2: space(2, { p1: page(null) }, { name: 'kept' }) },
    });
    const store = new Store(path);
    assert.equal(store.create({ name: 'n' }).id, 3);
    assert.equal(store.get(2).name, 'kept');

    const fractional = writeLedger('frac-next.json', {
      nextSpaceId: 5.5,
      labelSeq: {},
      spaces: {},
    });
    assert.equal(new Store(fractional).create({ name: 'n' }).id, 1);

    const negative = writeLedger('neg-next.json', {
      nextSpaceId: -3,
      labelSeq: {},
      spaces: {},
    });
    assert.equal(new Store(negative).create({ name: 'n' }).id, 1);
  });

  it('ignores non-integer space keys when computing nextSpaceId', () => {
    const path = writeLedger('odd-keys.json', {
      nextSpaceId: 1,
      labelSeq: {},
      spaces: {
        abc: space(1, { p1: page(null) }, { name: 'weird' }),
        2: space(2, { p1: page(null) }, { name: 'real' }),
      },
    });
    const store = new Store(path);
    assert.equal(store.create({ name: 'n' }).id, 3);
    assert.equal(store.get(2).name, 'real');
    assert.equal(store.get('abc').name, 'weird');
  });

  for (const [name, bad] of [
    ['null', null],
    ['array', []],
    ['zero', 0],
    ['str', 'x'],
    ['bool', true],
  ]) {
    it(`create works when labelSeq is ${name}`, () => {
      const path = writeLedger(`seq-${name}.json`, {
        nextSpaceId: 4,
        labelSeq: bad,
        spaces: {},
      });
      const store = new Store(path);
      const created = store.create({ name: 'ok' });
      assert.equal(created.id, 4);
      const disk = JSON.parse(readFileSync(path, 'utf8'));
      assert.equal(Array.isArray(disk.labelSeq), false);
      assert.equal(typeof disk.labelSeq, 'object');
      assert.equal(disk.labelSeq['4'], 1);
    });
  }

  it('create shape, deleteSpace clears labelSeq, and ids are not reused', () => {
    const path = file('lifecycle.json');
    const store = new Store(path);
    const created = store.create({ name: 'a', profileId: 'custom' });
    assert.equal(created.id, 1);
    assert.equal(created.profileId, 'custom');
    assert.equal(created.ownership, 'agent');
    assert.equal(created.state, 'active');
    assert.equal(created.activeTargetId, null);
    assert.equal(created.pages.p1.targetId, null);
    assert.equal(Number.isFinite(Date.parse(created.createdAt)), true);

    const before = readFileSync(path, 'utf8');
    assert.equal(store.nextLabel(999), 'p?');
    assert.equal(readFileSync(path, 'utf8'), before);

    assert.equal(store.nextLabel(created.id), 'p2');
    store.deleteSpace(created.id);
    assert.equal(store.get(created.id), null);
    assert.equal(store.nextLabel(created.id), 'p?');
    const disk = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(Object.hasOwn(disk.spaces, '1'), false);
    assert.equal(Object.hasOwn(disk.labelSeq, '1'), false);
    assert.equal(disk.nextSpaceId, 2);

    const again = store.create({ name: 'b' });
    assert.equal(again.id, 2);
    assert.equal(again.profileId, 'agent');
    const disk2 = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(Object.keys(disk2.labelSeq), ['2']);
    assert.equal(disk2.labelSeq['2'], 1);
  });

  it('deleteSpace on an unknown id leaves existing spaces in place', () => {
    const path = file('delete-missing.json');
    const store = new Store(path);
    const created = store.create({ name: 'stay' });
    store.deleteSpace(999);
    assert.equal(store.get(created.id).name, 'stay');
    const disk = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(disk.spaces['1'].name, 'stay');
    assert.equal(disk.labelSeq['1'], 1);
  });

  it('removePage clears activeTargetId only when the removed page held it', () => {
    const path = file('active.json');
    const store = new Store(path);
    const created = store.create({ name: 'a' });
    store.bindPage(created.id, 'p1', 'T-active');
    store.addPage(created.id, 'p2', 'T-other');
    created.activeTargetId = 'T-active';
    store.setPage(created.id, 'p1', { title: 'keep' });

    store.removePage(created.id, 'p2');
    assert.equal(store.get(created.id).activeTargetId, 'T-active');
    assert.equal(Object.hasOwn(store.get(created.id).pages, 'p2'), false);
    assert.equal(store.get(created.id).pages.p1.title, 'keep');

    store.removePage(created.id, 'p1');
    assert.equal(store.get(created.id).activeTargetId, null);
    assert.equal(Object.hasOwn(store.get(created.id).pages, 'p1'), false);

    const reloaded = new Store(path);
    assert.equal(reloaded.get(created.id).activeTargetId, null);
    assert.equal(reloaded.get(created.id).name, 'a');
    assert.deepEqual(reloaded.get(created.id).pages, {});
  });

  it('removePage keeps activeTargetId when another page is removed', () => {
    const path = file('active-other.json');
    const store = new Store(path);
    const created = store.create({ name: 'a' });
    store.bindPage(created.id, 'p1', 'T-active', 'human');
    store.addPage(created.id, 'p2', 'T-other');
    created.activeTargetId = 'T-active';
    store.setPage(created.id, 'p1', { title: 'stay' });
    store.removePage(created.id, 'p2');
    const reloaded = new Store(path);
    assert.equal(reloaded.get(created.id).activeTargetId, 'T-active');
    assert.equal(reloaded.get(created.id).pages.p1.openedBy, 'human');
    assert.equal(reloaded.get(created.id).pages.p1.title, 'stay');
  });

  it('removePage uses strict equality for activeTargetId', () => {
    const path = file('active-strict.json');
    const store = new Store(path);
    const created = store.create({ name: 'a' });
    store.bindPage(created.id, 'p1', '1');
    created.activeTargetId = 1;
    store.setPage(created.id, 'p1', { title: '' });
    store.removePage(created.id, 'p1');
    assert.equal(store.get(created.id).activeTargetId, 1);
  });

  it('removePage clears activeTargetId even if another page still has that target', () => {
    const path = file('active-shared.json');
    const store = new Store(path);
    const created = store.create({ name: 'a' });
    store.bindPage(created.id, 'p1', 'T-same');
    store.addPage(created.id, 'p2', 'T-same');
    created.activeTargetId = 'T-same';
    store.setPage(created.id, 'p2', { title: 'remains' });
    store.removePage(created.id, 'p1');
    assert.equal(store.get(created.id).activeTargetId, null);
    assert.equal(store.get(created.id).pages.p2.targetId, 'T-same');
    assert.equal(store.get(created.id).pages.p2.title, 'remains');
  });

  it('removePage ignores missing spaces, missing labels, and inherited names', () => {
    const path = file('remove-noop.json');
    const store = new Store(path);
    const created = store.create({ name: 'a' });
    const before = readFileSync(path, 'utf8');
    store.removePage(created.id, 'missing');
    store.removePage(created.id, '__proto__');
    store.removePage(created.id, 'constructor');
    store.removePage(4242, 'p1');
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.equal(typeof Object.prototype.toString, 'function');
    assert.equal(typeof Object.prototype.constructor, 'function');
  });

  it('removePage deletes a null page slot and does not clear a different active target', () => {
    const path = writeLedger('null-slot.json', {
      nextSpaceId: 2,
      labelSeq: { 1: 1 },
      spaces: {
        1: space(1, {
          p1: null,
          p2: page('T-keep', { title: 'stay' }),
        }, { activeTargetId: 'T-keep' }),
      },
    });
    const store = new Store(path);
    store.removePage(1, 'p1');
    assert.equal(Object.hasOwn(store.get(1).pages, 'p1'), false);
    assert.equal(store.get(1).activeTargetId, 'T-keep');
    assert.equal(store.get(1).pages.p2.title, 'stay');
    const reloaded = new Store(path);
    assert.equal(Object.hasOwn(reloaded.get(1).pages, 'p1'), false);
    assert.equal(reloaded.get(1).activeTargetId, 'T-keep');
  });

  it('setPage on a null page slot or unknown label does not persist', () => {
    const path = writeLedger('set-noop.json', {
      nextSpaceId: 2,
      labelSeq: { 1: 1 },
      spaces: {
        1: space(1, { p1: null, p2: page('T-keep') }),
      },
    });
    const store = new Store(path);
    const before = readFileSync(path, 'utf8');
    assert.equal(store.setPage(1, 'p1', { title: 'x' }), undefined);
    assert.equal(store.setPage(1, 'missing', { title: 'x' }), undefined);
    assert.equal(store.setPage(1, '__proto__', { title: 'x' }), undefined);
    assert.equal(store.setPage(4242, 'p1', { title: 'x' }), undefined);
    assert.equal(store.get(1).pages.p1, null);
    assert.equal(readFileSync(path, 'utf8'), before);
  });

  it('setPage merges onto an own toString page without touching Object.prototype', () => {
    const path = writeLedger('own-tostring.json', {
      nextSpaceId: 2,
      labelSeq: { 1: 1 },
      spaces: {
        1: space(1, {
          toString: page('T-x', { title: 'old' }),
        }, { activeTargetId: 'T-x' }),
      },
    });
    const store = new Store(path);
    store.setPage(1, 'toString', { title: 'safe', url: 'http://127.0.0.1/' });
    assert.equal(store.get(1).pages.toString.title, 'safe');
    assert.equal(store.get(1).pages.toString.url, 'http://127.0.0.1/');
    assert.equal(store.get(1).pages.toString.targetId, 'T-x');
    assert.equal(typeof Object.prototype.toString, 'function');

    store.removePage(1, 'toString');
    assert.equal(Object.hasOwn(store.get(1).pages, 'toString'), false);
    assert.equal(store.get(1).activeTargetId, null);
    assert.equal(typeof Object.prototype.toString, 'function');
    const reloaded = new Store(path);
    assert.equal(Object.hasOwn(reloaded.get(1).pages, 'toString'), false);
    assert.equal(reloaded.get(1).activeTargetId, null);
  });

  it('get does not surface inherited prototype names as spaces', () => {
    const path = file('get-inherited.json');
    const store = new Store(path);
    store.create({ name: 'a' });
    assert.equal(store.get('__proto__'), null);
    assert.equal(store.get('constructor'), null);
    assert.equal(store.get('toString'), null);
    assert.equal(store.get(999), null);
  });

  it('rejects reserved page labels before any write', () => {
    const path = file('reserved.json');
    const store = new Store(path);
    const created = store.create({ name: 'a' });
    const before = readFileSync(path, 'utf8');
    for (const label of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      assert.throws(() => store.bindPage(created.id, label, 'T-x'), {
        message: `invalid page label ${label}`,
      });
      assert.throws(() => store.addPage(created.id, label, 'T-x'), {
        message: `invalid page label ${label}`,
      });
    }
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.throws(() => store.bindPage(999, '__proto__', 'T-x'), { message: 'unknown space 999' });
    assert.throws(() => store.addPage(999, 'p9', 'T-x'), { message: 'unknown space 999' });
    assert.equal(readFileSync(path, 'utf8'), before);
  });

  it('round-trips a non-ascii page label and default openedBy', () => {
    const path = file('unicode-label.json');
    const store = new Store(path);
    const created = store.create({ name: 'a' });
    store.addPage(created.id, '頁籤', 'T-zh', 'human');
    const reloaded = new Store(path);
    assert.equal(reloaded.get(created.id).pages['頁籤'].targetId, 'T-zh');
    assert.equal(reloaded.get(created.id).pages['頁籤'].openedBy, 'human');
    assert.equal(reloaded.get(created.id).pages['頁籤'].title, '');
    assert.equal(reloaded.get(created.id).pages['頁籤'].url, '');
  });

  it('rebind replaces the page record instead of merging title and url', () => {
    const path = file('rebind.json');
    const store = new Store(path);
    const created = store.create({ name: 'a' });
    store.bindPage(created.id, 'p1', 'T-1', 'human');
    store.setPage(created.id, 'p1', { title: 'hello', url: 'http://127.0.0.1/' });
    store.addPage(created.id, 'p1', 'T-2');
    const current = store.get(created.id).pages.p1;
    assert.equal(current.targetId, 'T-2');
    assert.equal(current.title, '');
    assert.equal(current.url, '');
    assert.equal(current.openedBy, 'agent');
  });

  it('bindPage on a different label keeps activeTargetId', () => {
    const path = file('bind-other.json');
    const store = new Store(path);
    const created = store.create({ name: 'a' });
    store.bindPage(created.id, 'p1', 'T-active');
    created.activeTargetId = 'T-active';
    store.setPage(created.id, 'p1', { title: 'stay' });
    store.addPage(created.id, 'p2', 'T-other');
    assert.equal(store.get(created.id).activeTargetId, 'T-active');
    assert.equal(store.get(created.id).pages.p1.targetId, 'T-active');
    assert.equal(store.get(created.id).pages.p2.targetId, 'T-other');
  });

  for (const method of ['bindPage', 'addPage']) {
    it(`${method} clears a stale activeTargetId when replacing that page`, {
      todo: 'overwrite leaves the previous activeTargetId in place',
    }, () => {
      const path = file(`stale-${method}.json`);
      const store = new Store(path);
      const created = store.create({ name: 'a' });
      store.bindPage(created.id, 'p1', 'T-old');
      created.activeTargetId = 'T-old';
      store.setPage(created.id, 'p1', { title: 'old' });
      store[method](created.id, 'p1', 'T-new');
      const active = store.get(created.id).activeTargetId;
      assert.ok(active === null || active === 'T-new');
      const reloaded = new Store(path);
      const persisted = reloaded.get(created.id).activeTargetId;
      assert.ok(persisted === null || persisted === 'T-new');
    });
  }

  it('nextLabel coerces numeric strings and falls back when the counter is unusable', () => {
    const path = file('seq-coerce.json');
    const store = new Store(path);
    const created = store.create({ name: 'a' });
    const cases = [
      ['3', 'p4'],
      [0, 'p2'],
      ['nope', 'p2'],
      [1.5, 'p2'],
      [-4, 'p2'],
    ];
    for (const [raw, expected] of cases) {
      store.data.labelSeq[created.id] = raw;
      assert.equal(store.nextLabel(created.id), expected);
    }
  });

  it('nextLabel skips occupied labels and does not rewind below the counter', () => {
    const path = file('holes.json');
    const store = new Store(path);
    const created = store.create({ name: 'a' });
    store.addPage(created.id, 'p2', 'T-a');
    store.addPage(created.id, 'p4', 'T-b');
    assert.equal(store.nextLabel(created.id), 'p3');
    assert.equal(store.nextLabel(created.id), 'p5');

    const disk = JSON.parse(readFileSync(path, 'utf8'));
    disk.labelSeq[String(created.id)] = 8;
    writeFileSync(path, JSON.stringify(disk));
    const reloaded = new Store(path);
    assert.equal(reloaded.nextLabel(created.id), 'p9');
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).labelSeq[String(created.id)], 9);
  });

  it('nextLabel tolerates pages that are not a plain object', () => {
    const path = file('pages-bad.json');
    const store = new Store(path);
    const created = store.create({ name: 'a' });
    created.pages = null;
    assert.equal(store.nextLabel(created.id), 'p2');
    created.pages = ['not-a-map'];
    store.data.labelSeq[created.id] = 1;
    assert.equal(store.nextLabel(created.id), 'p2');
  });

  it('null, string, or number spaces are normalized so create() works', {
    todo: 'spaces:null|string|number survives load and then create throws TypeError',
  }, () => {
    for (const [name, spaces] of [['null', null], ['str', 'x'], ['num', 1]]) {
      const path = file(`spaces-${name}.json`);
      writeFileSync(path, JSON.stringify({ nextSpaceId: 1, labelSeq: {}, spaces }));
      const store = new Store(path);
      const created = store.create({ name: 'recovered' });
      assert.equal(created.name, 'recovered');
      assert.equal(store.list().length, 1);
      assert.equal(store.get(created.id).name, 'recovered');
    }
  });

  it('an array-valued spaces map is stored as an object map', {
    todo: 'spaces:[] stays an array and reloads with a null hole',
  }, () => {
    const path = writeLedger('spaces-array.json', {
      nextSpaceId: 1,
      labelSeq: {},
      spaces: [],
    });
    const store = new Store(path);
    const created = store.create({ name: 'recovered' });
    assert.equal(created.id, 1);
    const reloaded = new Store(path);
    const listed = reloaded.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, 'recovered');
    assert.equal(Array.isArray(JSON.parse(readFileSync(path, 'utf8')).spaces), false);
  });

  it('null pages does not throw and bindPage can attach a page', {
    todo: 'setPage/removePage/bindPage call Object.hasOwn or assign on pages:null',
  }, () => {
    const path = writeLedger('pages-null.json', {
      nextSpaceId: 2,
      labelSeq: { 1: 1 },
      spaces: {
        1: {
          id: 1,
          name: 'n',
          createdAt: NOW_ISO,
          pages: null,
          activeTargetId: null,
        },
      },
    });
    const store = new Store(path);
    assert.equal(store.nextLabel(1), 'p2');
    assert.doesNotThrow(() => store.setPage(1, 'p1', { title: 't' }));
    assert.doesNotThrow(() => store.removePage(1, 'p1'));
    assert.doesNotThrow(() => store.bindPage(1, 'p1', 'T-1'));
    assert.equal(store.get(1).pages.p1.targetId, 'T-1');
    const reloaded = new Store(path);
    assert.equal(reloaded.get(1).pages.p1.targetId, 'T-1');
  });

  it('a UTF-8 BOM in front of a valid ledger still loads', {
    todo: 'JSON.parse rejects the BOM and load starts a fresh ledger',
  }, () => {
    const path = file('bom.json');
    const body = JSON.stringify({
      nextSpaceId: 2,
      labelSeq: { 1: 1 },
      spaces: {
        1: space(1, { p1: page(null) }, { name: 'kept' }),
      },
    });
    writeFileSync(path, `\uFEFF${body}`);
    const store = new Store(path);
    assert.equal(store.get(1)?.name, 'kept');
    assert.equal(store.create({ name: 'next' }).id, 2);
  });
});
