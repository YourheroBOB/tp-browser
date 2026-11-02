// Boundary / error-path characterization for daemon/store.js.
// Temp files stay under os.tmpdir(). No network. No real credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../daemon/store.js';

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tp-fmb-edge-store-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function ledgerFile(dir, data) {
  const file = join(dir, 'ledger.json');
  writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  return file;
}

const FRESH = { nextSpaceId: 1, labelSeq: {}, spaces: {} };

test('可解析但根節點不是物件的 ledger 會原樣備份並在記憶體中重置', () => {
  for (const body of ['true', 'null', '[]', '"FAKE_VALUE_FOR_TEST"', '0']) {
    withTmp((dir) => {
      const file = ledgerFile(dir, body);
      const store = new Store(file);
      assert.deepEqual(store.data, FRESH);
      const backups = readdirSync(dir).filter((name) => name.startsWith('ledger.json.corrupt-'));
      assert.equal(backups.length, 1);
      assert.equal(backups[0].endsWith('.tmp'), false);
      assert.equal(readFileSync(join(dir, backups[0]), 'utf8'), body);
      assert.equal(readFileSync(file, 'utf8'), body);
    });
  }
});

test('BOM 或空白毀損檔會備份原位元組，合法 ledger 不會產生 corrupt 備份', () => {
  withTmp((dir) => {
    const file = ledgerFile(dir, '\uFEFF{"spaces":');
    const store = new Store(file);
    assert.deepEqual(store.data, FRESH);
    const backups = readdirSync(dir).filter((name) => name.includes('.corrupt-'));
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(join(dir, backups[0]), 'utf8'), '\uFEFF{"spaces":');
  });
  withTmp((dir) => {
    const file = ledgerFile(dir, ' \n\t');
    new Store(file);
    assert.equal(readdirSync(dir).filter((name) => name.includes('.corrupt-')).length, 1);
  });
  withTmp((dir) => {
    const file = ledgerFile(dir, { nextSpaceId: 1, labelSeq: {}, spaces: {}, note: 'FAKE_VALUE_FOR_TEST' });
    const store = new Store(file);
    assert.equal(store.data.note, 'FAKE_VALUE_FOR_TEST');
    assert.equal(readdirSync(dir).some((name) => name.includes('.corrupt-')), false);
    assert.equal(Object.prototype.polluted, undefined);
  });
});

test('ledger 路徑是目錄時不備份，persist 失敗後不留 .tmp', () => {
  withTmp((dir) => {
    const ledger = join(dir, 'ledger.json');
    mkdirSync(ledger);
    const store = new Store(ledger);
    assert.deepEqual(store.data, FRESH);
    assert.equal(readdirSync(dir).some((name) => name.includes('.corrupt-')), false);
    assert.throws(() => store.persist(), (err) => err?.code === 'EISDIR');
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
  });
});

test('父路徑是檔案時 persist 在建立暫存檔前就失敗', () => {
  withTmp((dir) => {
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x');
    const store = new Store(join(blocker, 'ledger.json'));
    assert.deepEqual(store.data, FRESH);
    // recursive mkdir 要把既有檔案當成目錄來建，Node 回 EEXIST（syscall mkdir），
    // 而且發生在寫入 ${file}.${pid}.tmp 之前，所以不會留下暫存檔、也不改原檔。
    assert.throws(() => store.persist(), (err) => {
      assert.equal(err.code, 'EEXIST');
      assert.equal(err.syscall, 'mkdir');
      return true;
    });
    assert.equal(readFileSync(blocker, 'utf8'), 'x');
    assert.deepEqual(readdirSync(dir), ['blocker']);
  });
});

test('空物件 ledger 只補計數器，list/create 仍拋錯且失敗的 create 已把 nextSpaceId 加一', () => {
  withTmp((dir) => {
    const file = ledgerFile(dir, '{}\n');
    const store = new Store(file);
    assert.equal(store.data.nextSpaceId, 1);
    assert.deepEqual(store.data.labelSeq, {});
    assert.equal(store.data.spaces, undefined);
    assert.equal(Object.hasOwn(store.data, 'spaces'), false);
    assert.throws(() => store.list(), TypeError);
    assert.throws(() => store.get(1), TypeError);
    assert.throws(() => store.create({ name: 'x' }), TypeError);
    assert.equal(store.data.nextSpaceId, 2);
    assert.equal(readFileSync(file, 'utf8'), '{}\n');
  });
});

test('spaces 為 null 時保留仍合法的 nextSpaceId 與 labelSeq，create 失敗不覆寫檔案', () => {
  withTmp((dir) => {
    const body = '{"spaces":null,"nextSpaceId":4,"labelSeq":{"keep":3},"note":"FAKE_VALUE_FOR_TEST"}';
    const file = ledgerFile(dir, body);
    const store = new Store(file);
    assert.equal(store.data.nextSpaceId, 4);
    assert.deepEqual(store.data.labelSeq, { keep: 3 });
    assert.equal(store.data.spaces, null);
    assert.equal(store.data.note, 'FAKE_VALUE_FOR_TEST');
    assert.throws(() => store.create({ name: 'x' }), TypeError);
    assert.equal(store.data.nextSpaceId, 5);
    assert.equal(readFileSync(file, 'utf8'), body);
  });
});

test('spaces 為陣列時 create 寫入索引，重新載入後洞被 JSON 編成 null', () => {
  withTmp((dir) => {
    const file = ledgerFile(dir, { spaces: [], labelSeq: {}, nextSpaceId: 1 });
    const store = new Store(file);
    const created = store.create({ name: 'arr' });
    assert.equal(created.id, 1);
    assert.equal(store.list().length, 1);
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(onDisk.spaces[0], null);
    assert.equal(onDisk.spaces[1].name, 'arr');
    const reloaded = new Store(file);
    const values = reloaded.list();
    assert.equal(values.length, 2);
    assert.equal(values[0], null);
    assert.equal(values[1].name, 'arr');
    assert.equal(reloaded.get(1).name, 'arr');
    assert.equal(reloaded.get(0), null);
    assert.equal(reloaded.data.nextSpaceId, 2);
  });
});

test('非整數 nextSpaceId 整段丟棄而不是進位，避免覆寫既有空間', () => {
  withTmp((dir) => {
    const file = ledgerFile(dir, {
      nextSpaceId: 5.5,
      labelSeq: {},
      spaces: { '3': { id: 3, name: 'old', pages: {}, activeTargetId: null } },
    });
    const store = new Store(file);
    assert.equal(store.data.nextSpaceId, 4);
    const created = store.create({ name: 'new' });
    assert.equal(created.id, 4);
    assert.equal(store.get(3).name, 'old');
    assert.equal(store.get(4).name, 'new');
  });
});

test('字串 nextSpaceId 與非十進位鍵不會變成同一個 space id', () => {
  withTmp((dir) => {
    const file = ledgerFile(dir, {
      nextSpaceId: '9',
      labelSeq: {},
      spaces: {
        '05': { id: 5, name: 'pad', pages: { p1: { targetId: null, title: '', url: '' } }, activeTargetId: null },
        '1e2': { id: 100, name: 'exp', pages: { p1: { targetId: null, title: '', url: '' } }, activeTargetId: null },
      },
    });
    const store = new Store(file);
    assert.equal(store.data.nextSpaceId, 101);
    assert.equal(store.get('05').name, 'pad');
    assert.equal(store.get('1e2').name, 'exp');
    assert.equal(store.get(5), null);
    assert.equal(store.get(100), null);
    const created = store.create({ name: 'fresh' });
    assert.equal(created.id, 101);
    assert.equal(store.get('05').name, 'pad');
    assert.equal(store.get(101).name, 'fresh');
  });
});

test('nextSpaceId 等於最大 id 時加一，比最大 id 大一則保留', () => {
  withTmp((dir) => {
    const equalFile = ledgerFile(dir, {
      nextSpaceId: 5,
      labelSeq: {},
      spaces: { '5': { id: 5, name: 'max', pages: {}, activeTargetId: null } },
    });
    const equalStore = new Store(equalFile);
    assert.equal(equalStore.data.nextSpaceId, 6);
    assert.equal(equalStore.create({ name: 'after' }).id, 6);
    assert.equal(equalStore.get(5).name, 'max');

    const above = join(dir, 'above.json');
    writeFileSync(above, JSON.stringify({
      nextSpaceId: 6,
      labelSeq: {},
      spaces: { '5': { id: 5, name: 'max', pages: {}, activeTargetId: null } },
    }));
    const aboveStore = new Store(above);
    assert.equal(aboveStore.data.nextSpaceId, 6);
    assert.equal(aboveStore.get(5).name, 'max');
  });
});

test('布林與字串型 nextSpaceId 都會被正規化成最大 id 之後', () => {
  for (const nextSpaceId of [true, false, '0', '']) {
    withTmp((dir) => {
      const file = ledgerFile(dir, { nextSpaceId, labelSeq: {}, spaces: {} });
      const store = new Store(file);
      assert.equal(store.data.nextSpaceId, 1);
    });
  }
});

test('錯誤型別的 labelSeq 會換成一般物件，之後 create 與 nextLabel 可用', () => {
  for (const labelSeq of [[1], 'bad', 0]) {
    withTmp((dir) => {
      const file = ledgerFile(dir, { nextSpaceId: 1, labelSeq, spaces: {} });
      const store = new Store(file);
      assert.deepEqual(store.data.labelSeq, {});
      const space = store.create({ name: 'ok' });
      assert.equal(store.data.labelSeq[space.id], 1);
      assert.equal(store.nextLabel(space.id), 'p2');
      assert.equal(store.data.labelSeq[space.id], 2);
    });
  }
});

test('labelSeq 的數字字串會當數字用，並跳過已存在的 pN 洞', () => {
  withTmp((dir) => {
    const file = ledgerFile(dir, {
      nextSpaceId: 2,
      labelSeq: { '1': '4' },
      spaces: {
        '1': {
          id: 1,
          name: 'holes',
          activeTargetId: null,
          pages: {
            p1: { targetId: null, title: '', url: '' },
            p4: { targetId: 'T4', title: '', url: '' },
            p5: { targetId: 'T5', title: '', url: '' },
          },
        },
      },
    });
    const store = new Store(file);
    assert.equal(store.nextLabel(1), 'p6');
    assert.equal(store.data.labelSeq['1'], 6);
    assert.equal(store.get(1).pages.p4.targetId, 'T4');
    assert.equal(store.nextLabel('nope'), 'p?');
  });
});

test('一萬個空間 id 仍能正規化 nextSpaceId', () => {
  withTmp((dir) => {
    const spaces = {};
    for (let i = 1; i <= 10000; i += 1) spaces[String(i)] = { id: i, pages: {} };
    const file = ledgerFile(dir, { nextSpaceId: 1, labelSeq: {}, spaces });
    const store = new Store(file);
    assert.equal(store.data.nextSpaceId, 10001);
    assert.equal(store.list().length, 10000);
    assert.equal(store.get(1).id, 1);
    assert.equal(store.get(10000).id, 10000);
    assert.equal(store.get(0), null);
    assert.equal(store.get(10001), null);
  });
});

test('原型鏈上的 label 被拒且不寫檔，大小寫不同的同名 label 可以', () => {
  withTmp((dir) => {
    const store = new Store(join(dir, 'ledger.json'));
    const space = store.create({ name: 's' });
    writeFileSync(store.file, 'TAMPER');
    for (const label of ['toLocaleString', 'valueOf', 'hasOwnProperty', '__defineSetter__', '__lookupGetter__']) {
      assert.throws(() => store.addPage(space.id, label, 'T'), { message: `invalid page label ${label}` });
      assert.throws(() => store.bindPage(space.id, label, 'T'), { message: `invalid page label ${label}` });
    }
    assert.equal(readFileSync(store.file, 'utf8'), 'TAMPER');
    assert.equal(Object.hasOwn(space.pages, 'valueOf'), false);
    store.bindPage(space.id, 'ToString', 'T-case');
    assert.equal(space.pages.ToString.targetId, 'T-case');
    assert.equal(JSON.parse(readFileSync(store.file, 'utf8')).spaces[String(space.id)].pages.ToString.targetId, 'T-case');
  });
});

test('未知空間比非法 label 先被拒絕，且不會覆寫磁碟', () => {
  withTmp((dir) => {
    const store = new Store(join(dir, 'ledger.json'));
    store.create({ name: 's' });
    writeFileSync(store.file, 'TAMPER');
    assert.throws(() => store.addPage('no-such', '__proto__', 'T'), { message: 'unknown space no-such' });
    assert.throws(() => store.bindPage('no-such', 'constructor', 'T'), { message: 'unknown space no-such' });
    assert.equal(readFileSync(store.file, 'utf8'), 'TAMPER');
    assert.equal(Object.prototype.polluted, undefined);
  });
});

test('setPage 對 null、缺頁、頁值為 null 都不寫檔；有頁時只合併 patch', () => {
  withTmp((dir) => {
    const store = new Store(join(dir, 'ledger.json'));
    const space = store.create({ name: 's' });
    const before = readFileSync(store.file, 'utf8');
    store.setPage(space.id, 'p1', null);
    store.setPage(space.id, 'p1', undefined);
    store.setPage(space.id, 'p1', {});
    store.setPage(space.id, 'missing', { title: 'nope' });
    assert.equal(readFileSync(store.file, 'utf8'), before);
    store.setPage(space.id, 'p1', { title: 'hello', url: 'http://127.0.0.1/' });
    assert.equal(space.pages.p1.title, 'hello');
    assert.equal(space.pages.p1.url, 'http://127.0.0.1/');
    assert.equal(space.pages.p1.targetId, null);
    assert.notEqual(readFileSync(store.file, 'utf8'), before);
    const mid = readFileSync(store.file, 'utf8');
    space.pages.p1 = null;
    store.setPage(space.id, 'p1', { title: 'x' });
    assert.equal(space.pages.p1, null);
    assert.equal(readFileSync(store.file, 'utf8'), mid);
  });
});

test('pages 為 null 時 nextLabel 仍發號，set/remove/bind 拋 TypeError', () => {
  withTmp((dir) => {
    const file = ledgerFile(dir, {
      nextSpaceId: 2,
      labelSeq: { '1': 1 },
      spaces: { '1': { id: 1, name: 'bare', activeTargetId: 'keep', pages: null } },
    });
    const store = new Store(file);
    assert.equal(store.nextLabel(1), 'p2');
    let saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.spaces['1'].pages, null);
    assert.equal(saved.spaces['1'].activeTargetId, 'keep');
    assert.equal(saved.labelSeq['1'], 2);
    assert.throws(() => store.setPage(1, 'p2', { title: 'x' }), TypeError);
    assert.throws(() => store.removePage(1, 'p2'), TypeError);
    assert.throws(() => store.bindPage(1, 'p3', 'T-x'), TypeError);
    saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.labelSeq['1'], 2);
    assert.equal(saved.spaces['1'].pages, null);
    assert.equal(saved.spaces['1'].activeTargetId, 'keep');
  });
});

test('removePage 只在 targetId 嚴格相等時清掉 activeTargetId', () => {
  withTmp((dir) => {
    const store = new Store(join(dir, 'ledger.json'));
    const space = store.create({ name: 's' });
    store.bindPage(space.id, 'p1', 'T-1');
    store.bindPage(space.id, 'p2', '');
    store.bindPage(space.id, 'p9', 'OTHER');
    space.activeTargetId = 'KEEP';
    store.removePage(space.id, 'p9');
    assert.equal(space.activeTargetId, 'KEEP');
    space.activeTargetId = 'T-1';
    store.removePage(space.id, 'p1');
    assert.equal(space.activeTargetId, null);
    assert.equal(Object.hasOwn(space.pages, 'p1'), false);
    space.activeTargetId = '';
    store.removePage(space.id, 'p2');
    assert.equal(space.activeTargetId, null);
    store.bindPage(space.id, 'p4', 1);
    space.activeTargetId = '1';
    store.removePage(space.id, 'p4');
    assert.equal(space.activeTargetId, '1');
    store.bindPage(space.id, 'p5', 0);
    space.activeTargetId = 0;
    store.removePage(space.id, 'p5');
    assert.equal(space.activeTargetId, null);
    writeFileSync(store.file, 'TAMPER');
    store.removePage(space.id, 'missing');
    store.removePage('missing-space', 'p1');
    assert.equal(readFileSync(store.file, 'utf8'), 'TAMPER');
  });
});

test('deleteSpace 清掉 labelSeq 且不重用 id；刪不存在的 id 仍會重寫檔案', () => {
  withTmp((dir) => {
    const store = new Store(join(dir, 'ledger.json'));
    const first = store.create({ name: 'a' });
    const second = store.create({ name: 'b' });
    store.deleteSpace(first.id);
    const third = store.create({ name: 'c' });
    assert.equal(store.get(first.id), null);
    assert.equal(third.id, first.id + 2);
    assert.equal(Object.hasOwn(store.data.labelSeq, String(first.id)), false);
    assert.equal(store.data.labelSeq[second.id], 1);
    assert.equal(store.data.labelSeq[third.id], 1);
    const reloaded = new Store(store.file);
    assert.equal(reloaded.get(first.id), null);
    assert.equal(reloaded.get(third.id).name, 'c');
    assert.equal(Object.hasOwn(reloaded.data.labelSeq, String(first.id)), false);

    writeFileSync(store.file, 'TAMPER');
    store.deleteSpace('missing-space');
    const saved = JSON.parse(readFileSync(store.file, 'utf8'));
    assert.equal(saved.spaces[String(second.id)].name, 'b');
    assert.equal(saved.spaces[String(third.id)].name, 'c');
    assert.equal(Object.hasOwn(saved.spaces, String(first.id)), false);
  });
});

test('profileId 與 name 的預設值邊界在重新載入後仍成立', () => {
  withTmp((dir) => {
    const store = new Store(join(dir, 'ledger.json'));
    const nulled = store.create({ name: 'a', profileId: null });
    const omitted = store.create({ name: null });
    const blank = store.create({ profileId: '' });
    assert.equal(nulled.profileId, null);
    assert.equal(omitted.profileId, 'agent');
    assert.equal(omitted.name, null);
    assert.equal(blank.profileId, '');
    assert.equal(blank.name, undefined);
    assert.equal(blank.ownership, 'agent');
    assert.equal(blank.state, 'active');
    assert.equal(blank.activeTargetId, null);
    assert.equal(blank.pages.p1.targetId, null);
    const reloaded = new Store(store.file);
    assert.equal(reloaded.get(nulled.id).profileId, null);
    assert.equal(reloaded.get(omitted.id).name, null);
    assert.equal(reloaded.get(omitted.id).profileId, 'agent');
    assert.equal(reloaded.get(blank.id).profileId, '');
    assert.equal('name' in reloaded.get(blank.id), false);
  });
});

test('list 與 get 回傳 ledger 內部參照，null 空間項與裸空間可被刪除', () => {
  withTmp((dir) => {
    const store = new Store(join(dir, 'ledger.json'));
    const space = store.create({ name: 'live-ref' });
    space.name = 'changed';
    assert.equal(store.get(space.id).name, 'changed');
    assert.equal(store.list()[0], space);
    store.persist();
    assert.equal(new Store(store.file).get(space.id).name, 'changed');
  });
  withTmp((dir) => {
    const file = ledgerFile(dir, {
      nextSpaceId: 3,
      labelSeq: { '1': 4, '2': 1 },
      spaces: {
        '1': null,
        '2': { id: 2, name: 'ok', pages: { p1: { targetId: null, title: '', url: '' } }, activeTargetId: null },
      },
    });
    const store = new Store(file);
    assert.equal(store.get(1), null);
    assert.equal(store.list().length, 2);
    assert.equal(store.list()[0], null);
    writeFileSync(file, 'TAMPER');
    assert.equal(store.nextLabel(1), 'p?');
    assert.equal(store.data.labelSeq['1'], 4);
    assert.equal(readFileSync(file, 'utf8'), 'TAMPER');
    assert.throws(() => store.bindPage(1, 'p9', 'T'), { message: 'unknown space 1' });
    store.deleteSpace(1);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(Object.hasOwn(saved.spaces, '1'), false);
    assert.equal(Object.hasOwn(saved.labelSeq, '1'), false);
    assert.equal(saved.spaces['2'].name, 'ok');
    assert.equal(saved.labelSeq['2'], 1);
  });
});

test('get 不把原型上的 constructor 當成空間', () => {
  withTmp((dir) => {
    const store = new Store(join(dir, 'ledger.json'));
    assert.equal(store.get('constructor'), null);
    assert.equal(store.get('__proto__'), null);
    assert.equal(store.get('toString'), null);
  });
});
