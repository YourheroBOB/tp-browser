// tests/fmb_w1_s01_store.test.mjs
// 回歸測試（fan-out s01）：daemon/store.js 的兩個缺陷
//   1) 缺少 findByTargetId()：兩個 daemon 的 broadcastPush 在 kind==='coride' 且帶
//      payload.mode 時會呼叫 store.findByTargetId(targetId)，缺方法 → TypeError，
//      space 的 ownership/state 永遠不會更新。
//   2) load() 未修補殘缺 JSON：'null' / '{}' / { spaces: {} } 會讓 this.data 變成殘缺
//      物件，之後呼叫 list()/create() 才炸 TypeError。
// 特性：所有檔案只寫在 mkdtempSync(tmpdir()) 內、測試結束即刪除；零網路、
// 零真實憑證，假 targetId 一律使用 *_FAKE_VALUE_FOR_TEST 這類明顯假字串。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../daemon/store.js';

function tmpLedger(t, content) {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-w1-s01-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'spaces.json');
  if (content !== undefined) writeFileSync(file, content, 'utf8');
  return file;
}

// ---------------------------------------------------------------- findByTargetId

test('findByTargetId：找得到時回傳 { space, label, page } 的活參考，改完可落盤', (t) => {
  const store = new Store(tmpLedger(t));
  const a = store.create({ name: 'space-a' });
  const b = store.create({ name: 'space-b' });
  store.bindPage(b.id, 'p1', 'TARGET_FAKE_VALUE_FOR_TEST', 'agent');

  const hit = store.findByTargetId('TARGET_FAKE_VALUE_FOR_TEST');
  assert.ok(hit, '應找到帶該 targetId 的分頁');
  assert.equal(hit.space.id, b.id);
  assert.equal(hit.label, 'p1');
  assert.equal(hit.page, hit.space.pages.p1, 'page 必須是 ledger 內的同一物件');
  assert.equal(hit.page.targetId, 'TARGET_FAKE_VALUE_FOR_TEST');
  assert.equal(store.get(a.id).pages.p1.targetId, null, '不得誤命中別的分頁');

  // 模擬 daemon 的 coride 行為：直接更新活參考後 persist，重啟後仍在。
  hit.space.ownership = 'human';
  hit.space.state = 'handover';
  store.persist();

  const reloaded = new Store(store.file);
  assert.equal(reloaded.get(b.id).ownership, 'human');
  assert.equal(reloaded.get(b.id).state, 'handover');
  assert.equal(reloaded.get(a.id).ownership, 'agent');
});

test('findByTargetId：找不到時回傳 null（不再拋 TypeError）', (t) => {
  const store = new Store(tmpLedger(t));
  store.create({ name: 'space' });
  store.bindPage(1, 'p1', 'TARGET_A_FAKE_VALUE_FOR_TEST');

  assert.equal(store.findByTargetId('TARGET_MISSING_FAKE_VALUE_FOR_TEST'), null);
  assert.equal(new Store(tmpLedger(t)).findByTargetId('TARGET_MISSING_FAKE_VALUE_FOR_TEST'), null);
});

test('findByTargetId：targetId 為 null 或 undefined 時回傳 null（不命中未綁定的 p1）', (t) => {
  const store = new Store(tmpLedger(t));
  store.create({ name: 'unbound' }); // 預設 p1.targetId === null

  assert.equal(store.findByTargetId(null), null);
  assert.equal(store.findByTargetId(undefined), null);
  assert.equal(store.findByTargetId(''), null);
});

test('findByTargetId：跨 label／跨 space 都找得到，重複 targetId 取第一個', (t) => {
  const store = new Store(tmpLedger(t));
  const s1 = store.create({ name: 'one' });
  const s2 = store.create({ name: 'two' });
  store.addPage(s1.id, 'p2', 'TARGET_DUP_FAKE_VALUE_FOR_TEST', 'human');
  store.addPage(s2.id, 'p1', 'TARGET_DUP_FAKE_VALUE_FOR_TEST');

  const hit = store.findByTargetId('TARGET_DUP_FAKE_VALUE_FOR_TEST');
  assert.equal(hit.space.id, s1.id);
  assert.equal(hit.label, 'p2');
});

// ---------------------------------------------------------------------- load()

for (const [desc, content] of [
  ["'null'", 'null'],
  ["'{}'", '{}'],
  ['{ spaces: {} }', JSON.stringify({ spaces: {} })],
  ["'[]'", '[]'],
]) {
  test(`load()：檔案內容為 ${desc} 時 create() 仍可運作且 id 從 1 開始`, (t) => {
    const file = tmpLedger(t, content);
    const store = new Store(file);

    assert.deepEqual(store.list(), []);
    assert.equal(store.get(1), null);
    assert.equal(store.nextLabel(1), 'p?');

    const space = store.create({ name: 'recovered' });
    assert.equal(space.id, 1);
    assert.deepEqual(Object.keys(space.pages), ['p1']);
    assert.equal(space.ownership, 'agent');
    assert.equal(store.nextLabel(space.id), 'p2');

    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(onDisk.nextSpaceId, 2);
    assert.equal(onDisk.spaces['1'].name, 'recovered');
    assert.equal(onDisk.labelSeq['1'], 2);
  });
}

test('load()：缺 nextSpaceId 的舊 ledger 會由既有 id 推回，create() 不產生 NaN', (t) => {
  const file = tmpLedger(t, JSON.stringify({
    labelSeq: { 3: 2 },
    spaces: {
      3: {
        id: 3, name: 'legacy', profileId: 'agent', ownership: 'human', state: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        pages: { p1: { targetId: 'TARGET_LEGACY_FAKE_VALUE_FOR_TEST', openedBy: 'agent', title: '', url: '' } },
        activeTargetId: 'TARGET_LEGACY_FAKE_VALUE_FOR_TEST',
      },
    },
  }));

  const store = new Store(file);
  assert.equal(store.data.nextSpaceId, 4);

  const created = store.create({ name: 'fresh' });
  assert.ok(Number.isInteger(created.id), `id 必須是整數，實際 ${created.id}`);
  assert.equal(created.id, 4);
  assert.equal(store.get(3).name, 'legacy', '既有空間不得被新 id 覆蓋');
  assert.equal(store.nextLabel(3), 'p3', 'labelSeq 應沿用既有值');

  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(onDisk.spaces.NaN, undefined);
  assert.ok(onDisk.spaces['3'] && onDisk.spaces['4']);
  assert.equal(onDisk.nextSpaceId, 5);
});

test('load()：nextSpaceId 落後於既有 id 時不會覆蓋既有空間', (t) => {
  const file = tmpLedger(t, JSON.stringify({
    nextSpaceId: 1,
    labelSeq: {},
    spaces: { 5: { id: 5, name: 'five', pages: {} } },
  }));

  const store = new Store(file);
  assert.equal(store.create({ name: 'six' }).id, 6);
  assert.equal(store.get(5).name, 'five');
});

test('load()：labelSeq 與 pages 的畸形值被修補，操作不再炸 TypeError', (t) => {
  const file = tmpLedger(t, JSON.stringify({
    nextSpaceId: 2,
    labelSeq: { 1: 'not-a-number' },
    spaces: { 1: { id: 1, name: 'half-written', pages: 'broken' } },
  }));

  const store = new Store(file);
  assert.deepEqual(Object.keys(store.get(1).pages), []);
  assert.doesNotThrow(() => store.setPage(1, 'p1', { title: 'x' }));
  assert.equal(store.nextLabel(1), 'p2', '畸形的 labelSeq 應被丟棄後重新起算');
  assert.equal(store.create({ name: 'next' }).id, 2);
});

test('load()：spaces 內的非物件條目被丟棄，其餘空間與查詢仍正常', (t) => {
  const file = tmpLedger(t, JSON.stringify({
    nextSpaceId: 3,
    labelSeq: {},
    spaces: {
      1: null,
      2: { id: 2, name: 'kept', pages: { p1: { targetId: null, openedBy: 'agent', title: '', url: '' } } },
    },
  }));

  const store = new Store(file);
  assert.deepEqual(store.list().map((s) => s.id), [2]);
  assert.equal(store.get(2).name, 'kept');
  assert.equal(store.findByTargetId('TARGET_MISSING_FAKE_VALUE_FOR_TEST'), null);
});

test('load()：合法 ledger 載入後再 persist 仍是位元組不動點（修補不得改寫既有資料）', (t) => {
  const file = tmpLedger(t);
  const first = new Store(file);
  const space = first.create({ name: 'stable' });
  first.bindPage(space.id, 'p1', 'TARGET_STABLE_FAKE_VALUE_FOR_TEST');
  const snapshot = readFileSync(file, 'utf8');

  const reloaded = new Store(file);
  assert.deepEqual(reloaded.data, first.data);
  reloaded.persist();
  assert.equal(readFileSync(file, 'utf8'), snapshot);
});

test('load()：缺少 space.id 時以鍵回填，回收／刪除不會因 undefined 靜默失效', (t) => {
  const file = tmpLedger(t, JSON.stringify({
    nextSpaceId: 2,
    labelSeq: {},
    spaces: {
      1: {
        name: 'no-id',
        pages: { p1: { targetId: 'TARGET_NOID_FAKE_VALUE_FOR_TEST', openedBy: 'agent', title: '', url: '' } },
      },
    },
  }));

  const store = new Store(file);
  assert.equal(store.get(1).id, 1, 'space.id 必須由鍵回填');
  assert.equal(store.list()[0].id, 1);
  assert.equal(store.findByTargetId('TARGET_NOID_FAKE_VALUE_FOR_TEST').space.id, 1);

  // 回收器是用 space.id 呼叫 deleteSpace()：id 為 undefined 時會靜默清不掉空間。
  store.deleteSpace(store.list()[0].id);
  assert.equal(store.get(1), null);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).spaces, {});
});
