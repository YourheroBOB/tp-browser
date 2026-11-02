// Store 載入形狀、label 與 persist 失敗邊界。
// 暫存檔只在 os.tmpdir()；不連線、不使用真實憑證。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../daemon/store.js';

function emptyStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-edge-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'ledger.json');
  return { dir, file, store: new Store(file) };
}

function loadLedger(t, data) {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-edge-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'ledger.json');
  writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  const orig = console.error;
  console.error = () => {};
  try {
    return { dir, file, store: new Store(file) };
  } finally {
    console.error = orig;
  }
}

describe('nextSpaceId 與 labelSeq 形狀', () => {
  test('nextSpaceId 只有在不是「大於所有正整數鍵」的整數時才被抬高', (t) => {
    const cases = [
      [{ nextSpaceId: 3, spaces: { 3: { id: 3 } } }, 4],
      [{ nextSpaceId: 4, spaces: { 3: { id: 3 } } }, 4],
      [{ nextSpaceId: '4', spaces: { 3: { id: 3 } } }, 4],
      [{ nextSpaceId: 2.5, spaces: { 2: { id: 2 } } }, 3],
      [{ nextSpaceId: 0, spaces: {} }, 1],
      [{ nextSpaceId: -5, spaces: { 4: { id: 4 } } }, 5],
      [{ nextSpaceId: null, spaces: { 8: { id: 8 } } }, 9],
      [{
        nextSpaceId: 2,
        spaces: { 0: { id: 0 }, '-3': { id: -3 }, abc: { id: 1 }, '1.5': { id: 1.5 } },
      }, 2],
      // "02" 與 "1e2" 會被 Number() 吃進去，這是目前的高水位規則。
      [{ nextSpaceId: 2, spaces: { '02': { id: 2 } } }, 3],
      [{ nextSpaceId: 50, spaces: { '1e2': { id: 1 } } }, 101],
    ];
    for (const [data, expected] of cases) {
      const { store } = loadLedger(t, { labelSeq: {}, ...data });
      assert.equal(store.data.nextSpaceId, expected, JSON.stringify(data.nextSpaceId));
    }
  });

  test('修正 nextSpaceId 時保留既有 labelSeq，包含孤兒鍵', (t) => {
    const { store } = loadLedger(t, {
      nextSpaceId: '1',
      labelSeq: { 5: 4, 9: '2' },
      spaces: { 5: { id: 5, name: 'k', pages: { p1: { targetId: null } } } },
    });
    assert.equal(store.data.nextSpaceId, 6);
    assert.equal(store.data.labelSeq[5], 4);
    assert.equal(store.data.labelSeq[9], '2');
    assert.equal(store.nextLabel(5), 'p5');
    assert.equal(store.data.labelSeq[5], 5);
    assert.equal(store.data.labelSeq[9], '2');
  });

  test('labelSeq 為 null、陣列、字串或數字時會換成一般物件，create 才寫得進去', (t) => {
    for (const labelSeq of [null, ['x'], 'nope', 3]) {
      const { file, store } = loadLedger(t, { nextSpaceId: 1, labelSeq, spaces: {} });
      assert.equal(Array.isArray(store.data.labelSeq), false);
      assert.equal(store.data.labelSeq !== null && typeof store.data.labelSeq, 'object');
      const space = store.create({ name: 'n' });
      assert.equal(store.data.labelSeq[space.id], 1);
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      assert.equal(Array.isArray(saved.labelSeq), false);
      assert.equal(saved.labelSeq[String(space.id)], 1);
    }
  });

  test('spaces 為 null 時整份物件仍保留，list 與 create 才丟 TypeError', (t) => {
    const { dir, store } = loadLedger(t, { nextSpaceId: 5, labelSeq: { 1: 1 }, spaces: null });
    assert.equal(readdirSync(dir).some((name) => name.includes('corrupt')), false);
    assert.equal(store.data.nextSpaceId, 5);
    assert.equal(store.data.labelSeq[1], 1);
    assert.throws(() => store.list(), TypeError);
    assert.throws(() => store.create({ name: 'n' }), TypeError);
  });

  test('spaces 為陣列時不拿它掃 id，create 仍可把空間放進該陣列', (t) => {
    const { store } = loadLedger(t, { nextSpaceId: 5, labelSeq: {}, spaces: [] });
    assert.equal(store.data.nextSpaceId, 5);
    const space = store.create({ name: 'from-array' });
    assert.equal(space.id, 5);
    assert.equal(store.get(5).name, 'from-array');
    assert.equal(store.get('5').name, 'from-array');
    assert.equal(store.list().some((item) => item && item.id === 5), true);
  });

  test('空間值為 null 時 list、get、nextLabel 不丟例外', (t) => {
    const { store } = loadLedger(t, {
      nextSpaceId: 3,
      labelSeq: {},
      spaces: {
        1: null,
        2: { id: 2, name: 'ok', pages: { p1: { targetId: null } }, activeTargetId: null },
      },
    });
    assert.equal(store.data.nextSpaceId, 3);
    assert.equal(store.list().length, 2);
    assert.equal(store.list().filter((item) => item === null).length, 1);
    assert.equal(store.get(1), null);
    assert.equal(store.nextLabel(1), 'p?');
    assert.equal(store.get(2).name, 'ok');
    store.deleteSpace(1);
    assert.equal(store.list().length, 1);
    assert.equal(store.get(2).name, 'ok');
  });
});

describe('pages 與 label 異常', () => {
  test('pages 為 null 時寫入會丟 TypeError，nextLabel 仍只推進序號', (t) => {
    const { store } = loadLedger(t, {
      nextSpaceId: 2,
      labelSeq: {},
      spaces: { 1: { id: 1, name: 'n', pages: null, activeTargetId: 'STALE' } },
    });
    assert.throws(() => store.setPage(1, 'p1', { title: 'x' }), TypeError);
    assert.throws(() => store.removePage(1, 'p1'), TypeError);
    assert.throws(() => store.bindPage(1, 'p2', 'T'), TypeError);
    assert.throws(() => store.addPage(1, 'p2', 'T'), TypeError);
    assert.equal(store.get(1).activeTargetId, 'STALE');
    assert.equal(store.nextLabel(1), 'p2');
    assert.equal(store.data.labelSeq[1], 2);
    assert.equal(store.get(1).pages, null);
  });

  test('nextLabel 接受奇怪的序號，並跳過值為 null 的已佔用 pN', (t) => {
    const textual = loadLedger(t, {
      nextSpaceId: 2,
      labelSeq: { 1: '3' },
      spaces: { 1: { id: 1, name: 'n', pages: { p1: { targetId: null } }, activeTargetId: null } },
    });
    assert.equal(textual.store.nextLabel(1), 'p4');

    const fractional = loadLedger(t, {
      nextSpaceId: 2,
      labelSeq: { 1: 2.9 },
      spaces: {
        1: {
          id: 1,
          name: 'n',
          pages: { p1: { targetId: null }, p2: { targetId: 'T' } },
          activeTargetId: null,
        },
      },
    });
    assert.equal(fractional.store.nextLabel(1), 'p3');

    const occupiedNull = loadLedger(t, {
      nextSpaceId: 2,
      labelSeq: { 1: 0 },
      spaces: {
        1: {
          id: 1,
          name: 'n',
          pages: { p1: { targetId: null }, p2: null },
          activeTargetId: null,
        },
      },
    });
    assert.equal(occupiedNull.store.nextLabel(1), 'p3');

    const negative = loadLedger(t, {
      nextSpaceId: 2,
      labelSeq: { 1: -4 },
      spaces: { 1: { id: 1, name: 'n', pages: { p1: { targetId: null } }, activeTargetId: null } },
    });
    assert.equal(negative.store.nextLabel(1), 'p2');
  });

  test('不存在的空間不會建立 ledger；未知 label 不會重寫檔案', (t) => {
    const { file, store } = emptyStore(t);
    assert.equal(store.get(1), null);
    assert.deepEqual(store.list(), []);
    assert.equal(store.nextLabel(1), 'p?');
    store.setPage(1, 'p1', { title: 'x' });
    store.removePage(1, 'p1');
    assert.equal(existsSync(file), false);

    const space = store.create({ name: 'n' });
    const before = readFileSync(file);
    store.setPage(space.id, 'missing', { title: 'x' });
    store.removePage(space.id, 'missing');
    store.nextLabel(999);
    assert.deepEqual(readFileSync(file), before);
  });

  test('較少見的原型 label 被拒絕，大小寫不同的名稱可以寫入', (t) => {
    const { file, store } = emptyStore(t);
    const space = store.create({ name: 'n' });
    const before = readFileSync(file);
    for (const label of ['toLocaleString', 'isPrototypeOf', 'propertyIsEnumerable']) {
      assert.throws(() => store.bindPage(space.id, label, 'T'), (err) => {
        assert.equal(err.message, `invalid page label ${label}`);
        return true;
      });
      assert.throws(() => store.addPage(space.id, label, 'T'), (err) => {
        assert.equal(err.message, `invalid page label ${label}`);
        return true;
      });
    }
    assert.throws(() => store.bindPage(999, 'p9', 'T'), /unknown space 999/);
    assert.throws(() => store.addPage('missing', 'p9', 'T'), /unknown space missing/);
    assert.deepEqual(readFileSync(file), before);
    store.bindPage(space.id, 'prototype', 'T-ok', 'human');
    store.addPage(space.id, 'Constructor', 'T-ok2');
    assert.equal(store.get(space.id).pages.prototype.targetId, 'T-ok');
    assert.equal(store.get(space.id).pages.prototype.openedBy, 'human');
    assert.equal(store.get(space.id).pages.Constructor.targetId, 'T-ok2');
  });

  test('nextLabel 忽略非 pN 標籤', (t) => {
    const { store } = emptyStore(t);
    const space = store.create({ name: 'n' });
    store.bindPage(space.id, 'main', 'T-custom', 'human');
    assert.equal(store.nextLabel(space.id), 'p2');
    assert.equal(store.get(space.id).pages.main.targetId, 'T-custom');
    assert.equal(store.get(space.id).pages.main.openedBy, 'human');
  });

  test('addPage 整筆取代分頁，不保留原本的 title', (t) => {
    const { store } = emptyStore(t);
    const space = store.create({ name: 'n' });
    store.bindPage(space.id, 'p2', 'T1', 'human');
    store.setPage(space.id, 'p2', { title: 'keep', url: 'http://127.0.0.1/' });
    assert.equal(store.get(space.id).pages.p2.title, 'keep');
    store.addPage(space.id, 'p2', 'T2');
    const page = store.get(space.id).pages.p2;
    assert.equal(page.targetId, 'T2');
    assert.equal(page.title, '');
    assert.equal(page.url, '');
    assert.equal(page.openedBy, 'agent');
  });

  test('removePage 只在 targetId 嚴格相等時清掉 activeTargetId', (t) => {
    const { store } = emptyStore(t);
    const space = store.create({ name: 'n' });
    store.removePage(space.id, 'p1');
    assert.equal(store.get(space.id).activeTargetId, null);
    assert.equal(Object.hasOwn(store.get(space.id).pages, 'p1'), false);

    store.bindPage(space.id, 'p2', 0);
    store.get(space.id).activeTargetId = 0;
    store.removePage(space.id, 'p2');
    assert.equal(store.get(space.id).activeTargetId, null);

    store.bindPage(space.id, 'p3', 0);
    store.get(space.id).activeTargetId = 1;
    store.removePage(space.id, 'p3');
    assert.equal(store.get(space.id).activeTargetId, 1);

    store.bindPage(space.id, 'p4', null);
    store.get(space.id).activeTargetId = 'KEEP';
    store.removePage(space.id, 'p4');
    assert.equal(store.get(space.id).activeTargetId, 'KEEP');
    assert.equal(Object.hasOwn(store.get(space.id).pages, 'p4'), false);
  });
});

describe('create、delete 與 persist 失敗', () => {
  test('create 拒絕 null 與 undefined，空物件與陣列使用預設 profileId', (t) => {
    const { file, store } = emptyStore(t);
    assert.throws(() => store.create(), TypeError);
    assert.throws(() => store.create(null), TypeError);
    assert.throws(() => store.create(undefined), TypeError);
    assert.equal(store.data.nextSpaceId, 1);
    assert.equal(existsSync(file), false);

    const fromEmpty = store.create({});
    assert.equal(fromEmpty.name, undefined);
    assert.equal(fromEmpty.profileId, 'agent');
    assert.equal(fromEmpty.pages.p1.targetId, null);
    assert.equal(fromEmpty.activeTargetId, null);
    assert.equal(store.get(String(fromEmpty.id)).id, fromEmpty.id);

    const fromArray = store.create([]);
    assert.equal(fromArray.name, undefined);
    assert.equal(fromArray.profileId, 'agent');
    assert.ok(fromArray.id > fromEmpty.id);
  });

  test('deleteSpace 清掉 labelSeq，而且不重用 id', (t) => {
    const { store } = emptyStore(t);
    const a = store.create({ name: 'a' });
    const b = store.create({ name: 'b' });
    store.nextLabel(a.id);
    store.deleteSpace(a.id);
    assert.equal(store.get(a.id), null);
    assert.equal(Object.hasOwn(store.data.labelSeq, String(a.id)), false);
    assert.equal(store.data.labelSeq[b.id], 1);
    assert.equal(store.get(b.id).name, 'b');
    const c = store.create({ name: 'c' });
    assert.ok(c.id > b.id);
    assert.notEqual(c.id, a.id);
    store.deleteSpace('missing');
    assert.equal(store.get(b.id).name, 'b');
    assert.equal(store.get(c.id).name, 'c');
  });

  test('list() 回傳 ledger 內部物件', (t) => {
    const { store } = emptyStore(t);
    const space = store.create({ name: 'alpha' });
    const listed = store.list().find((item) => item.id === space.id);
    listed.name = 'mutated';
    assert.equal(store.get(space.id).name, 'mutated');
  });

  test('ledger 路徑是目錄時不丟例外，也不寫 corrupt 備份', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'fmb-edge-store-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const asDir = join(dir, 'ledger.json');
    mkdirSync(asDir);
    const orig = console.error;
    let logged = '';
    console.error = (...args) => { logged += args.map(String).join(' '); };
    try {
      const store = new Store(asDir);
      assert.match(logged, /store load failed/);
      assert.equal(store.data.nextSpaceId, 1);
      assert.deepEqual(store.list(), []);
      assert.equal(readdirSync(dir).some((name) => name.includes('corrupt')), false);
    } finally {
      console.error = orig;
    }
  });

  test('persist 目標是目錄時會丟例外、清掉 tmp，且原本的 ledger 還在', (t) => {
    const { dir, file, store } = emptyStore(t);
    store.create({ name: 'ok' });
    const dest = join(dir, 'blocked');
    mkdirSync(dest);
    store.file = dest;
    assert.throws(() => store.persist());
    assert.equal(readdirSync(dir).some((name) => name.endsWith('.tmp')), false);
    assert.equal(statSync(dest).isDirectory(), true);
    assert.equal(store.data.spaces[1].name, 'ok');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.spaces['1'].name, 'ok');
  });
});
