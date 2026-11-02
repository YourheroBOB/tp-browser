// Ledger reaper 與 Store 的邊界回歸。
// 只讀 repo 內模組；暫存檔只在 os.tmpdir()；不連線、不讀寫家目錄、不啟動瀏覽器。
// 產品缺陷用 node:test 的 todo（等同 xfail）：斷言的是應有行為，現況失敗不讓整組變紅。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../daemon/store.js';
import { buildPlan } from '../fmb_feature2/cli.js';
import {
  DEFAULT_POLICY,
  applyReapPlan,
  classifySpace,
  pageEntries,
  planReap,
  toTargetSet,
} from '../fmb_feature2/reaper.js';

const NOW = Date.parse('2026-06-01T00:00:00.000Z');
const IDLE = 30 * 60 * 1000;

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-reaper-edges-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function freshStore(dir) {
  const file = join(dir, 'ledger.json');
  return { file, store: new Store(file) };
}

function writeStore(dir, data) {
  const file = join(dir, 'ledger.json');
  writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  return { file, store: new Store(file) };
}

function pg(targetId) {
  return { targetId, openedBy: 'agent', title: '', url: '' };
}

function makeSpace({ id, name, createdAt, pages, activeTargetId = null, pinned = false }) {
  return {
    id,
    name: name ?? `s${id}`,
    createdAt: createdAt ?? new Date(NOW).toISOString(),
    pages: pages ?? { p1: pg(null) },
    activeTargetId,
    pinned,
  };
}

test('DEFAULT_POLICY 被凍結，且覆寫不會改到預設物件', () => {
  assert.throws(() => {
    DEFAULT_POLICY.idleSpaceMs = 1;
  }, TypeError);
  assert.equal(DEFAULT_POLICY.idleSpaceMs, IDLE);
  assert.equal(DEFAULT_POLICY.maxSpaces, 50);
  const plan = planReap({
    spaces: [],
    liveTargetIds: ['T-anchor'],
    policy: { idleSpaceMs: 5 },
  });
  assert.equal(plan.stats.examined, 0);
  assert.equal(plan.reason, undefined);
  assert.equal(DEFAULT_POLICY.idleSpaceMs, IDLE);
});

test('空的 live target 集合完全不回收，連過期 dead 空間也留著', () => {
  const ancient = makeSpace({
    id: 1,
    createdAt: '2020-01-01T00:00:00.000Z',
    pages: { p1: pg('GONE') },
    activeTargetId: 'GONE',
  });
  const plan = planReap({ spaces: [ancient], liveTargetIds: [], now: NOW });
  assert.equal(plan.reason, 'no-live-targets');
  assert.deepEqual(plan.closeSpaces, []);
  assert.deepEqual(plan.dropPages, []);
  assert.deepEqual(plan.staleActiveTargets, []);
  assert.equal(plan.stats.examined, 1);
  assert.equal(plan.stats.closed, 0);
});

test('live target 只承認非空字串；純數字清單會觸發空集合安全閥', () => {
  const numericOnly = planReap({
    spaces: [makeSpace({ id: 1, pages: { p1: pg('1') } })],
    liveTargetIds: [1, '', null],
    now: NOW,
  });
  assert.equal(numericOnly.reason, 'no-live-targets');
  assert.deepEqual(numericOnly.closeSpaces, []);

  const mixed = planReap({
    spaces: [makeSpace({ id: 1, pages: { p1: pg('1') } })],
    liveTargetIds: [1, '', null, 'T-anchor'],
    now: NOW,
  });
  assert.equal(mixed.reason, undefined);
  assert.deepEqual(mixed.closeSpaces, [1]);
  assert.equal(mixed.stats.live, 0);
  assert.deepEqual([...toTargetSet(['A', '', 1, null, 'B'])].sort(), ['A', 'B']);
  assert.deepEqual([...toTargetSet(new Set(['A', '']))], ['A']);
  assert.equal(toTargetSet('A').size, 0);
  assert.equal(toTargetSet(null).size, 0);
});

test('閒置邊界含等號，差 1 毫秒則保留未綁定空間', () => {
  const exact = planReap({
    spaces: [makeSpace({
      id: 1,
      createdAt: new Date(NOW - IDLE).toISOString(),
    })],
    liveTargetIds: ['T-anchor'],
    now: NOW,
  });
  assert.deepEqual(exact.closeSpaces, [1]);
  assert.equal(exact.stats.closed, 1);

  const justUnder = planReap({
    spaces: [makeSpace({
      id: 2,
      createdAt: new Date(NOW - IDLE + 1).toISOString(),
    })],
    liveTargetIds: ['T-anchor'],
    now: NOW,
  });
  assert.deepEqual(justUnder.closeSpaces, []);
  assert.equal(justUnder.stats.closed, 0);
});

test('createdAt 無法解析就不算閒置；dead 仍立即回收，empty 舊空間才回收', () => {
  const plan = planReap({
    spaces: [
      makeSpace({ id: 1, createdAt: 'not-a-date', pages: { p1: pg('GONE') } }),
      makeSpace({ id: 2, createdAt: 'not-a-date', pages: { p1: pg(null) } }),
      makeSpace({ id: 3, createdAt: '', pages: {} }),
      makeSpace({ id: 4, createdAt: '2020-01-01T00:00:00.000Z', pages: {} }),
      makeSpace({ id: 5, createdAt: new Date(NOW + 60_000).toISOString() }),
    ],
    liveTargetIds: ['T-anchor'],
    now: NOW,
  });
  assert.deepEqual(plan.closeSpaces, [1, 4]);

  const unbound = classifySpace(
    makeSpace({ id: 2, createdAt: 'not-a-date' }),
    { liveTargets: ['T-anchor'], now: NOW },
  );
  assert.equal(unbound.kind, 'unbound');
  assert.equal(unbound.ageMs, null);
  assert.equal(unbound.idle, false);

  const future = classifySpace(
    makeSpace({ id: 5, createdAt: new Date(NOW + 60_000).toISOString() }),
    { liveTargets: ['T-anchor'], now: NOW },
  );
  assert.equal(future.ageMs, 0);
  assert.equal(future.idle, false);
});

test('存活空間即使已閒置也不關閉，只丟掉其中的 dead 分頁', () => {
  const space = makeSpace({
    id: 1,
    createdAt: '2020-01-01T00:00:00.000Z',
    pages: { p1: pg('T-live'), p2: pg('T-dead') },
    activeTargetId: 'T-live',
  });
  const info = classifySpace(space, { liveTargets: ['T-live'], now: NOW });
  assert.equal(info.kind, 'live');
  assert.equal(info.idle, true);
  assert.equal(info.deadPages.length, 1);

  const plan = planReap({
    spaces: [space],
    liveTargetIds: ['T-live'],
    now: NOW,
  });
  assert.deepEqual(plan.closeSpaces, []);
  assert.deepEqual(plan.dropPages, [{ spaceId: 1, label: 'p2', targetId: 'T-dead' }]);
  assert.deepEqual(plan.staleActiveTargets, []);
  assert.equal(plan.stats.live, 1);
});

test('maxSpaces 為 0 或受害者不足時，仍不犧牲存活或釘選空間', () => {
  const zeroCap = planReap({
    spaces: [
      makeSpace({ id: 1, pages: { p1: pg('T-live') } }),
      makeSpace({ id: 2 }),
    ],
    liveTargetIds: ['T-live'],
    now: NOW,
    policy: { maxSpaces: 0 },
  });
  assert.deepEqual(zeroCap.closeSpaces, [2]);
  assert.equal(zeroCap.stats.live, 1);
  assert.equal(zeroCap.stats.overCap, 1);

  const shortlist = planReap({
    spaces: [
      makeSpace({ id: 1, pinned: true }),
      makeSpace({ id: 2, pages: { p1: pg('T-live') } }),
      makeSpace({ id: 3 }),
    ],
    liveTargetIds: ['T-live'],
    now: NOW,
    policy: { maxSpaces: 1 },
  });
  assert.deepEqual(shortlist.closeSpaces, [3]);
  assert.equal(shortlist.stats.protected, 1);
  assert.equal(shortlist.stats.live, 1);
  assert.equal(shortlist.stats.overCap, 1);

  const uncapped = planReap({
    spaces: [makeSpace({ id: 1 }), makeSpace({ id: 2 })],
    liveTargetIds: ['T-anchor'],
    now: NOW,
    policy: { maxSpaces: Number.NaN },
  });
  assert.deepEqual(uncapped.closeSpaces, []);
  assert.equal(uncapped.stats.overCap, 0);
});

test('空字串 targetId 視為未綁定；非物件分頁被略過', () => {
  const entries = pageEntries({
    pages: {
      p1: pg(''),
      p2: pg('T-live'),
      p3: null,
      p4: pg(12),
      p5: [],
      p6: { title: 'no-target' },
    },
  });
  assert.deepEqual(entries.map((e) => [e.label, e.targetId]), [
    ['p1', null],
    ['p2', 'T-live'],
    ['p4', null],
    ['p6', null],
  ]);

  const info = classifySpace(
    makeSpace({ id: 1, pages: { p1: pg(''), p2: null } }),
    { liveTargets: ['T-anchor'], now: NOW },
  );
  assert.equal(info.kind, 'unbound');

  const plan = planReap({
    spaces: [makeSpace({ id: 1, pages: { p1: pg('') } })],
    liveTargetIds: ['T-anchor'],
    now: NOW,
  });
  assert.deepEqual(plan.closeSpaces, []);
  assert.equal(classifySpace(null, { liveTargets: [], now: NOW }).kind, 'empty');
});

test('protect 接受數字、數字字串與單一純量，釘選空間連 dead 分頁與 stale target 都不動', () => {
  const pinned = makeSpace({
    id: 1,
    pinned: true,
    pages: { p1: pg('GONE') },
    activeTargetId: 'GONE',
  });
  const byNumber = planReap({
    spaces: [
      makeSpace({ id: 2, pages: { p1: pg('GONE') }, activeTargetId: 'GONE' }),
      makeSpace({ id: 3, pages: { p1: pg('GONE') } }),
    ],
    liveTargetIds: ['T-anchor'],
    now: NOW,
    protect: 2,
  });
  assert.deepEqual(byNumber.closeSpaces, [3]);
  assert.equal(byNumber.stats.protected, 1);
  assert.deepEqual(byNumber.dropPages, []);

  const both = planReap({
    spaces: [pinned],
    liveTargetIds: ['T-anchor'],
    now: NOW,
    protect: ['1'],
  });
  assert.deepEqual(both.closeSpaces, []);
  assert.deepEqual(both.dropPages, []);
  assert.deepEqual(both.staleActiveTargets, []);
  assert.equal(both.stats.protected, 1);
  assert.equal(both.stats.live, 0);
});

test('關閉 reapDeadSpaces 時，年輕 dead 空間留著但可逐頁丟棄', () => {
  const kept = planReap({
    spaces: [makeSpace({
      id: 1,
      pages: { p1: pg('GONE'), p2: pg(null) },
      activeTargetId: 'GONE',
    })],
    liveTargetIds: ['T-anchor'],
    now: NOW,
    policy: { reapDeadSpaces: false, dropDeadPages: true },
  });
  assert.deepEqual(kept.closeSpaces, []);
  assert.deepEqual(kept.dropPages, [{ spaceId: 1, label: 'p1', targetId: 'GONE' }]);
  assert.deepEqual(kept.staleActiveTargets, [{ spaceId: 1, targetId: 'GONE' }]);

  const noDrop = planReap({
    spaces: [makeSpace({
      id: 1,
      pages: { p1: pg('T-live'), p2: pg('GONE') },
      activeTargetId: 'GONE',
    })],
    liveTargetIds: ['T-live'],
    now: NOW,
    policy: { dropDeadPages: false },
  });
  assert.deepEqual(noDrop.dropPages, []);
  assert.deepEqual(noDrop.staleActiveTargets, [{ spaceId: 1, targetId: 'GONE' }]);
});

test('明確開啟離線回收時，空 live 集合會把所有已綁定分頁當成 dead', () => {
  const plan = planReap({
    spaces: [
      makeSpace({ id: 1, pages: { p1: pg('GONE') } }),
      makeSpace({ id: 2, pages: { p1: pg(null) } }),
      makeSpace({
        id: 3,
        createdAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
        pages: { p1: pg(null) },
      }),
    ],
    liveTargetIds: [],
    now: NOW,
    policy: { reapIdleWhenNoLiveTargets: true, reapDeadSpaces: true },
  });
  assert.equal(plan.reason, undefined);
  assert.deepEqual(plan.closeSpaces, [1, 3]);
});

test('非法空間項目記入 skipped，且計畫不改動輸入', () => {
  const spaces = [
    null,
    { id: null, pages: {} },
    { name: 'missing-id' },
    makeSpace({ id: 4 }),
    5,
  ];
  const snapshot = structuredClone(spaces);
  const plan = planReap({ spaces, liveTargetIds: ['T-anchor'], now: NOW });
  assert.deepEqual(spaces, snapshot);
  assert.equal(plan.stats.examined, 1);
  assert.equal(plan.stats.skipped, 4);
  assert.deepEqual(plan.closeSpaces, []);
  assert.equal(planReap().reason, 'invalid-input');
  assert.equal(planReap({ spaces: null, liveTargetIds: ['T'] }).reason, 'invalid-input');
});

test('分類涵蓋 live、dead、unbound、mixed、empty', () => {
  const live = new Set(['T-live']);
  const opts = { liveTargets: live, now: NOW };
  assert.equal(classifySpace(makeSpace({ id: 1, pages: { p1: pg('T-live'), p2: pg('GONE') } }), opts).kind, 'live');
  assert.equal(classifySpace(makeSpace({ id: 1, pages: { p1: pg('GONE') } }), opts).kind, 'dead');
  assert.equal(classifySpace(makeSpace({ id: 1, pages: { p1: pg(null) } }), opts).kind, 'unbound');
  assert.equal(classifySpace(makeSpace({ id: 1, pages: { p1: pg('GONE'), p2: pg(null) } }), opts).kind, 'mixed');
  assert.equal(classifySpace(makeSpace({ id: 1, pages: {} }), opts).kind, 'empty');
});

test('applyReapPlan 缺方法時是 no-op，並跳過已關閉空間的分頁與無 label 項目', () => {
  const calls = [];
  const store = {
    deleteSpace(id) { calls.push(['del', id]); },
    removePage(id, label) { calls.push(['drop', id, label]); },
  };
  const applied = applyReapPlan(store, {
    closeSpaces: [1],
    dropPages: [
      { spaceId: 1, label: 'p9', targetId: 'x' },
      { spaceId: 2, label: 'p2', targetId: 'y' },
      { spaceId: 3, targetId: 'z' },
      { spaceId: 3, label: null },
      null,
    ],
  });
  assert.deepEqual(calls, [['del', 1], ['drop', 2, 'p2']]);
  assert.deepEqual(applied.closedSpaces, [1]);
  assert.deepEqual(applied.droppedPages, [{ spaceId: 2, label: 'p2', targetId: 'y' }]);

  const dropOnly = [];
  const partial = applyReapPlan(
    { removePage(id, label) { dropOnly.push([id, label]); } },
    { closeSpaces: [1], dropPages: [{ spaceId: 1, label: 'p1' }, { spaceId: 2, label: 'p2' }] },
  );
  assert.deepEqual(partial.closedSpaces, []);
  assert.deepEqual(dropOnly, [[2, 'p2']]);

  const inert = { deleteSpace() {}, removePage() {} };
  assert.deepEqual(applyReapPlan(inert, null), { closedSpaces: [], droppedPages: [] });
  assert.deepEqual(applyReapPlan({}, { closeSpaces: [1], dropPages: [{ spaceId: 2, label: 'p1' }] }), {
    closedSpaces: [],
    droppedPages: [],
  });
});

test('套到真實 Store：關閉 dead 空間並清 labelSeq，丟掉 dead 分頁時一併清 activeTargetId', () => {
  withTempDir((dir) => {
    const { file, store } = freshStore(dir);
    const live = store.create({ name: 'live' });
    const dead = store.create({ name: 'dead' });
    store.setPage(live.id, 'p1', { targetId: 'T-live', title: 'keep', url: 'http://127.0.0.1/keep' });
    store.addPage(live.id, 'p2', 'T-gone', 'agent');
    store.setPage(dead.id, 'p1', { targetId: 'T-dead', title: 'gone', url: 'http://127.0.0.1/gone' });
    store.get(live.id).activeTargetId = 'T-gone';
    store.get(dead.id).activeTargetId = 'T-dead';
    store.persist();

    const plan = planReap({
      spaces: store.list(),
      liveTargetIds: ['T-live'],
      now: Date.now(),
    });
    assert.deepEqual(plan.closeSpaces, [dead.id]);
    assert.deepEqual(plan.dropPages.map((d) => d.label), ['p2']);
    assert.deepEqual(plan.staleActiveTargets, [{ spaceId: live.id, targetId: 'T-gone' }]);

    const applied = applyReapPlan(store, plan);
    assert.deepEqual(applied.closedSpaces, [dead.id]);
    assert.equal(applied.droppedPages.length, 1);
    assert.equal(store.get(dead.id), null);
    assert.equal(Object.hasOwn(store.data.labelSeq, String(dead.id)), false);
    assert.equal(store.get(live.id).pages.p2, undefined);
    assert.equal(store.get(live.id).pages.p1.targetId, 'T-live');
    assert.equal(store.get(live.id).pages.p1.title, 'keep');
    assert.equal(store.get(live.id).pages.p1.url, 'http://127.0.0.1/keep');
    assert.equal(store.get(live.id).pages.p1.openedBy, 'agent');
    assert.equal(store.get(live.id).activeTargetId, null);
    assert.equal(store.data.labelSeq[live.id], 1);

    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.spaces[String(dead.id)], undefined);
    assert.equal(saved.labelSeq[String(dead.id)], undefined);
    assert.equal(saved.spaces[String(live.id)].pages.p1.title, 'keep');
    assert.equal(saved.spaces[String(live.id)].activeTargetId, null);

    const reloaded = new Store(file);
    assert.equal(reloaded.get(dead.id), null);
    assert.equal(reloaded.get(String(live.id)).pages.p1.url, 'http://127.0.0.1/keep');
    assert.equal(reloaded.get(live.id).activeTargetId, null);

    const disk = readFileSync(file, 'utf8');
    const again = planReap({
      spaces: reloaded.list(),
      liveTargetIds: ['T-live'],
      now: Date.now(),
    });
    assert.deepEqual(again.closeSpaces, []);
    assert.deepEqual(again.dropPages, []);
    assert.deepEqual(again.staleActiveTargets, []);
    const second = applyReapPlan(reloaded, again);
    assert.deepEqual(second.closedSpaces, []);
    assert.deepEqual(second.droppedPages, []);
    assert.equal(readFileSync(file, 'utf8'), disk);
  });
});

test('不存在的空間或分頁不會改寫 ledger；list() 回傳的是內部物件', () => {
  withTempDir((dir) => {
    const { file, store } = freshStore(dir);
    const space = store.create({ name: 'keep' });
    const before = readFileSync(file, 'utf8');
    store.setPage(space.id, 'missing', { title: 'nope' });
    store.removePage(space.id, 'missing');
    store.removePage(999, 'p1');
    store.deleteSpace(999);
    assert.equal(store.nextLabel(999), 'p?');
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.equal(store.get(space.id).pages.p1.title, '');
    assert.equal(store.get(String(space.id)), space);
    assert.equal(store.list()[0], space);
    space.name = 'mutated-in-memory';
    assert.equal(store.get(space.id).name, 'mutated-in-memory');
  });
});

test('成功 persist 不留下 pid 暫存檔', () => {
  withTempDir((dir) => {
    const { file, store } = freshStore(dir);
    const space = store.create({ name: 'a' });
    assert.equal(readdirSync(dir).some((name) => name.endsWith('.tmp')), false);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.nextSpaceId, 2);
    assert.equal(saved.spaces[String(space.id)].name, 'a');
    assert.deepEqual(Object.keys(saved.spaces[String(space.id)].pages), ['p1']);
  });
});

test('nextSpaceId 落後於既有 id 時會抬高，避免 create 覆蓋舊空間', () => {
  withTempDir((dir) => {
    const { file, store } = writeStore(dir, {
      nextSpaceId: 1,
      labelSeq: { 2: 4 },
      spaces: {
        2: {
          id: 2,
          name: 'kept',
          profileId: 'agent',
          ownership: 'agent',
          state: 'active',
          createdAt: '2026-01-01T00:00:00.000Z',
          pages: { p1: { targetId: 'T-keep', openedBy: 'agent', title: 'old', url: 'http://127.0.0.1/old' } },
          activeTargetId: 'T-keep',
        },
      },
    });
    assert.equal(store.data.nextSpaceId, 3);
    assert.equal(store.data.labelSeq['2'], 4);
    const created = store.create({ name: 'new' });
    assert.equal(created.id, 3);
    assert.equal(store.get(2).name, 'kept');
    assert.equal(store.get('2').pages.p1.targetId, 'T-keep');
    assert.equal(store.get(2).activeTargetId, 'T-keep');
    const reloaded = new Store(file);
    assert.equal(reloaded.get(2).pages.p1.title, 'old');
    assert.equal(reloaded.get(3).name, 'new');
    assert.equal(reloaded.data.nextSpaceId, 4);
  });
});

test('labelSeq 不是一般物件時會換成空物件，既有空間仍在', () => {
  for (const labelSeq of [[1, 2], null, 'bad', 3]) {
    withTempDir((dir) => {
      const { store } = writeStore(dir, {
        nextSpaceId: 5,
        labelSeq,
        spaces: {
          4: {
            id: 4,
            name: 'kept',
            profileId: 'agent',
            ownership: 'agent',
            state: 'active',
            createdAt: '2026-01-01T00:00:00.000Z',
            pages: { p1: pg('T-keep') },
            activeTargetId: null,
          },
        },
      });
      assert.deepEqual(store.data.labelSeq, {});
      assert.equal(store.data.nextSpaceId, 5);
      assert.equal(store.get(4).pages.p1.targetId, 'T-keep');
      assert.equal(store.list().length, 1);
    });
  }
});

test('nextLabel 在 pages 為 null 時不拋錯，也不會憑空補回分頁', () => {
  withTempDir((dir) => {
    const { file, store } = freshStore(dir);
    const space = store.create({ name: 's' });
    space.pages = null;
    store.persist();
    assert.equal(store.nextLabel(space.id), 'p2');
    assert.equal(space.pages, null);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.spaces['1'].pages, null);
    assert.equal(saved.labelSeq['1'], 2);
  });
});

for (const raw of ['null', '[]', '0', '"nope"']) {
  test(`ledger 根節點 ${raw} 會原樣備份且不被採用`, () => {
    withTempDir((dir) => {
      const file = join(dir, 'ledger.json');
      writeFileSync(file, raw);
      const store = new Store(file);
      const backups = readdirSync(dir).filter((name) => name.startsWith('ledger.json.corrupt-'));
      assert.equal(backups.length, 1);
      assert.equal(backups[0].endsWith('.tmp'), false);
      assert.equal(readFileSync(join(dir, backups[0]), 'utf8'), raw);
      assert.equal(readFileSync(file, 'utf8'), raw);
      assert.equal(store.list().length, 0);
      assert.equal(store.data.nextSpaceId, 1);
      assert.deepEqual(store.data.labelSeq, {});
      const created = store.create({ name: 'fresh' });
      assert.equal(created.id, 1);
      assert.equal(readFileSync(join(dir, backups[0]), 'utf8'), raw);
    });
  });
}

test('buildPlan 拒絕非物件 JSON，缺欄位時用空清單', () => {
  assert.throws(() => buildPlan('{'), /invalid JSON input/);
  assert.throws(() => buildPlan(''), /invalid JSON input/);
  assert.throws(() => buildPlan(undefined), /invalid JSON input/);
  assert.throws(() => buildPlan('null'), /payload must be a JSON object/);
  assert.throws(() => buildPlan('[]'), /payload must be a JSON object/);
  assert.throws(() => buildPlan('"x"'), /payload must be a JSON object/);

  const empty = buildPlan('{}');
  assert.equal(empty.reason, 'no-live-targets');
  assert.deepEqual(empty.closeSpaces, []);

  const anchored = buildPlan('{"liveTargetIds":["T-anchor"]}');
  assert.equal(anchored.reason, undefined);
  assert.equal(anchored.stats.examined, 0);

  const notArray = buildPlan('{"spaces":{"1":{}},"liveTargetIds":["T-anchor"]}');
  assert.equal(notArray.reason, 'invalid-input');

  const ignored = buildPlan('{"spaces":[],"liveTargetIds":["T-anchor"],"policy":"nope","protect":null}');
  assert.equal(ignored.reason, undefined);
  assert.deepEqual(ignored.closeSpaces, []);
});

test('buildPlan 的 now 為 0 時仍用來計算閒置', () => {
  const plan = buildPlan(JSON.stringify({
    spaces: [makeSpace({
      id: 4,
      createdAt: '1970-01-01T00:00:00.000Z',
      pages: { p1: pg(null) },
    })],
    liveTargetIds: ['T-anchor'],
    now: 0,
    policy: { idleSpaceMs: 0 },
  }));
  assert.deepEqual(plan.closeSpaces, [4]);
});

test('載入時把缺漏或非物件的 spaces 補成一般物件', { todo: 'normalizeLedger 只修 nextSpaceId 與 labelSeq，spaces 缺欄、null、陣列或純量時 list()/create() 仍壞掉' }, () => {
  const payloads = ['{}', '{"spaces":null}', '{"spaces":[]}', '{"spaces":1}', '{"nextSpaceId":5}'];
  for (const raw of payloads) {
    withTempDir((dir) => {
      const file = join(dir, 'ledger.json');
      writeFileSync(file, raw);
      const store = new Store(file);
      assert.equal(Array.isArray(store.data.spaces), false);
      assert.equal(store.data.spaces !== null && typeof store.data.spaces === 'object', true);
      assert.doesNotThrow(() => store.list());
      const expectedId = raw.includes('"nextSpaceId":5') ? 5 : 1;
      const created = store.create({ name: 'repaired' });
      assert.equal(created.id, expectedId);
      assert.equal(store.list().length, 1);
      assert.equal(store.get(expectedId).name, 'repaired');
    });
  }
});

test('setPage 不得套用 patch 裡的 __proto__', { todo: 'Object.assign 會觸發 __proto__ setter，改變該分頁物件的原型' }, () => {
  withTempDir((dir) => {
    const { store } = freshStore(dir);
    const space = store.create({ name: 's' });
    try {
      store.setPage(space.id, 'p1', { ['__proto__']: { fmbPolluted: 'FAKE_VALUE_FOR_TEST' } });
      assert.equal(Object.getPrototypeOf(store.get(space.id).pages.p1), Object.prototype);
      assert.equal(Object.prototype.fmbPolluted, undefined);
      assert.equal(store.get(space.id).pages.p1.fmbPolluted, undefined);
    } finally {
      const page = store.get(space.id)?.pages?.p1;
      if (page && typeof page === 'object') Object.setPrototypeOf(page, Object.prototype);
      delete Object.prototype.fmbPolluted;
    }
  });
});

test('pages 為 null 時 removePage、setPage、addPage 不應拋錯', { todo: '這三個方法直接對 pages 做 hasOwn 或賦值，null 會丟 TypeError；nextLabel 已自行容錯' }, () => {
  withTempDir((dir) => {
    const { store } = freshStore(dir);
    const space = store.create({ name: 's' });
    space.pages = null;
    assert.doesNotThrow(() => store.removePage(space.id, 'p1'));
    assert.doesNotThrow(() => store.setPage(space.id, 'p1', { title: 'x' }));
    assert.doesNotThrow(() => store.addPage(space.id, 'p2', 'T-2'));
  });
});

test('buildPlan 把 maxSpaces null 當成不設上限', { todo: '文件寫 null／NaN 表示不設上限，但 Number(null)===0，會變成上限 0 而回收所有非存活空間' }, () => {
  const plan = buildPlan(JSON.stringify({
    spaces: [makeSpace({ id: 1 }), makeSpace({ id: 2 })],
    liveTargetIds: ['T-anchor'],
    now: NOW,
    policy: { maxSpaces: null },
  }));
  assert.equal(plan.stats.examined, 2);
  assert.deepEqual(plan.closeSpaces, []);
  assert.equal(plan.stats.overCap, 0);
});
