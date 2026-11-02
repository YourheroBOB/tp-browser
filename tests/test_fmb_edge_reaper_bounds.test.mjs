// Boundary / error-path characterization for fmb_feature2/reaper.js.
// Does not repeat the happy-path matrix in fmb_feature2/reaper.test.js.
// Temp files stay under os.tmpdir(). No network. No real credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../daemon/store.js';
import {
  DEFAULT_POLICY,
  applyReapPlan,
  classifySpace,
  pageEntries,
  planReap,
  toTargetSet,
} from '../fmb_feature2/reaper.js';

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tp-fmb-edge-reaper-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('DEFAULT_POLICY 被凍結，呼叫端的 policy 不會改到預設值', () => {
  assert.throws(() => {
    DEFAULT_POLICY.maxSpaces = 1;
  }, TypeError);
  assert.equal(DEFAULT_POLICY.maxSpaces, 50);
  assert.equal(DEFAULT_POLICY.reapIdleWhenNoLiveTargets, false);
  planReap({
    spaces: [],
    liveTargetIds: ['x'],
    now: 0,
    policy: { maxSpaces: 0, idleSpaceMs: 1 },
  });
  assert.equal(DEFAULT_POLICY.maxSpaces, 50);
  assert.equal(DEFAULT_POLICY.idleSpaceMs, 30 * 60 * 1000);
});

test('toTargetSet 與 pageEntries 丟掉非字串 target、空字串與非一般物件分頁', () => {
  assert.deepEqual([...toTargetSet(new Set(['T', '', 1, null]))], ['T']);
  assert.equal(toTargetSet('T-live').size, 0);
  assert.equal(toTargetSet(null).size, 0);
  assert.equal(toTargetSet(0).size, 0);
  const entries = pageEntries({
    pages: { a: 1, b: null, c: [], d: { targetId: 'T' }, e: { targetId: '' }, f: { targetId: 0 } },
  });
  assert.deepEqual(entries.map((entry) => entry.targetId), ['T', null, null]);
  assert.deepEqual(pageEntries(null), []);
  assert.deepEqual(pageEntries({ pages: [{ targetId: 'LIVE' }] }), []);
});

test('target 型別與空白字串決定 dead 或 unbound，空 pages 陣列算 empty', () => {
  const info = classifySpace({
    createdAt: 0,
    pages: { p1: { targetId: '  ' }, p2: { targetId: '' }, p3: { targetId: 0 }, p4: { targetId: false } },
  }, { liveTargets: [], now: 10, policy: { idleSpaceMs: 99999 } });
  assert.equal(info.kind, 'mixed');
  assert.equal(info.ageMs, 10);
  assert.equal(info.idle, false);
  assert.deepEqual(info.deadPages.map((entry) => entry.label), ['p1']);
  assert.deepEqual(info.unboundPages.map((entry) => entry.label), ['p2', 'p3', 'p4']);

  const hidden = classifySpace({ id: 1, pages: [{ targetId: 'LIVE' }] }, { liveTargets: ['LIVE'], now: 0 });
  assert.equal(hidden.kind, 'empty');
  assert.equal(hidden.ageMs, null);

  const missing = classifySpace(undefined, { liveTargets: ['x'], now: 0, policy: { idleSpaceMs: 0 } });
  assert.equal(missing.kind, 'empty');
  assert.equal(missing.ageMs, null);
  assert.equal(missing.idle, false);
});

test('閒置邊界含等於、差 1 毫秒、未來時間與無法解析的 createdAt', () => {
  const created = '2026-01-01T00:00:00.000Z';
  const base = Date.parse(created);
  const space = { id: 1, createdAt: created, pages: { p1: { targetId: null } } };
  const at = classifySpace(space, { liveTargets: ['x'], now: base + 1000, policy: { idleSpaceMs: 1000 } });
  const under = classifySpace(space, { liveTargets: ['x'], now: base + 999, policy: { idleSpaceMs: 1000 } });
  assert.equal(at.ageMs, 1000);
  assert.equal(at.idle, true);
  assert.equal(under.ageMs, 999);
  assert.equal(under.idle, false);

  const future = classifySpace(space, { liveTargets: ['x'], now: base - 5000, policy: { idleSpaceMs: 0 } });
  assert.equal(future.ageMs, 0);
  assert.equal(future.idle, true);

  const zeroIdle = classifySpace(space, { liveTargets: ['x'], now: base, policy: { idleSpaceMs: -0 } });
  assert.equal(zeroIdle.idle, true);

  const bad = classifySpace(
    { id: 1, createdAt: 'not-a-date', pages: {} },
    { liveTargets: ['x'], now: base, policy: { idleSpaceMs: 0 } },
  );
  assert.equal(bad.ageMs, null);
  assert.equal(bad.idle, false);
  assert.equal(bad.kind, 'empty');
});

test('空空間只在年齡可計算且已閒置時關閉；無法解析的時間不會被閒置規則誤刪', () => {
  const oldEmpty = planReap({
    spaces: [{ id: 1, createdAt: '2000-01-01T00:00:00.000Z', pages: {} }],
    liveTargetIds: ['x'],
    now: Date.parse('2026-01-01T00:00:00.000Z'),
    policy: { idleSpaceMs: 1, maxSpaces: 10, reapDeadSpaces: true },
  });
  assert.deepEqual(oldEmpty.closeSpaces, [1]);

  const ageless = planReap({
    spaces: [{ id: 2, pages: {} }],
    liveTargetIds: ['x'],
    now: 10,
    policy: { idleSpaceMs: 0, maxSpaces: 10, reapDeadSpaces: true },
  });
  assert.deepEqual(ageless.closeSpaces, []);
  assert.equal(ageless.stats.examined, 1);
});

test('maxSpaces:null 與 -0 都被當成 0，但 live 與 pinned 不會為了上限被犧牲', () => {
  const spaces = [
    { id: 1, createdAt: '2020-01-01T00:00:00.000Z', pages: { p1: { targetId: null } } },
    { id: 2, createdAt: '2020-01-02T00:00:00.000Z', pages: { p1: { targetId: null } } },
    { id: 3, createdAt: '2020-01-03T00:00:00.000Z', pages: { p1: { targetId: 'LIVE' } } },
    { id: 4, pinned: true, createdAt: '2019-01-01T00:00:00.000Z', pages: { p1: { targetId: 'GONE' } } },
  ];
  const plan = planReap({
    spaces,
    liveTargetIds: ['LIVE'],
    now: Date.parse('2026-01-01T00:00:00.000Z'),
    policy: { maxSpaces: null, idleSpaceMs: Number.POSITIVE_INFINITY, reapDeadSpaces: false, dropDeadPages: true },
  });
  assert.deepEqual(plan.closeSpaces, [1, 2]);
  assert.deepEqual(plan.dropPages, []);
  assert.deepEqual(plan.staleActiveTargets, []);
  assert.equal(plan.stats.overCap, 2);
  assert.equal(plan.stats.live, 1);
  assert.equal(plan.stats.protected, 1);
  assert.equal(plan.reason, undefined);

  const negZero = planReap({
    spaces: [{ id: 9, createdAt: '2026-06-01T00:00:00.000Z', pages: { p1: { targetId: null } } }],
    liveTargetIds: ['x'],
    now: Date.parse('2026-06-01T00:00:00.000Z'),
    policy: { maxSpaces: -0, idleSpaceMs: 86_400_000, reapDeadSpaces: false },
  });
  assert.deepEqual(negZero.closeSpaces, [9]);
  assert.equal(negZero.stats.overCap, 1);
});

test('數字字串的 maxSpaces 會轉成數字，數字字串的 idleSpaceMs 不會', () => {
  const recent = [
    { id: 1, createdAt: '2026-06-01T00:00:00.000Z', pages: { p1: { targetId: null } } },
    { id: 2, createdAt: '2026-06-01T00:00:00.000Z', pages: { p1: { targetId: null } } },
    { id: 3, createdAt: '2026-06-01T00:00:00.000Z', pages: { p1: { targetId: null } } },
  ];
  const capped = planReap({
    spaces: recent,
    liveTargetIds: ['x'],
    now: Date.parse('2026-06-01T00:00:00.000Z'),
    policy: { maxSpaces: '1', idleSpaceMs: 86_400_000, reapDeadSpaces: false },
  });
  assert.deepEqual(capped.closeSpaces, [1, 2]);
  assert.equal(capped.stats.overCap, 2);

  const notIdle = planReap({
    spaces: [{ id: 1, createdAt: '2000-01-01T00:00:00.000Z', pages: { p1: { targetId: null } } }],
    liveTargetIds: ['x'],
    now: Date.parse('2026-01-01T00:00:00.000Z'),
    policy: { idleSpaceMs: '1', maxSpaces: 50, reapDeadSpaces: false },
  });
  assert.deepEqual(notIdle.closeSpaces, []);

  const unlimited = planReap({
    spaces: recent,
    liveTargetIds: ['x'],
    now: Date.parse('2026-06-01T00:00:00.000Z'),
    policy: { maxSpaces: Number.NaN, idleSpaceMs: 86_400_000, reapDeadSpaces: false },
  });
  assert.deepEqual(unlimited.closeSpaces, []);
});

test('pinned 必須是布林 true；字串 true 的死空間仍會關閉', () => {
  const plan = planReap({
    spaces: [{ id: 8, pinned: 'true', createdAt: 'not-a-date', pages: { p1: { targetId: 'GONE' } } }],
    liveTargetIds: ['KEEP'],
    now: 0,
    policy: { maxSpaces: 50, reapDeadSpaces: true },
  });
  assert.deepEqual(plan.closeSpaces, [8]);
  assert.equal(plan.stats.protected, 0);
});

test('保護名單用字串比對，不把 01 收成 1；受保護的死分頁不會被丟', () => {
  const plan = planReap({
    spaces: [
      { id: '01', createdAt: '2020-01-01T00:00:00.000Z', pages: { p1: { targetId: 'GONE' } } },
      { id: 1, createdAt: '2020-01-01T00:00:00.000Z', pages: { p1: { targetId: 'GONE' }, p2: { targetId: 'ALSO' } } },
    ],
    liveTargetIds: ['KEEP'],
    now: Date.parse('2026-01-01T00:00:00.000Z'),
    protect: [1],
    policy: { maxSpaces: 50, reapDeadSpaces: true, dropDeadPages: true },
  });
  assert.deepEqual(plan.closeSpaces, ['01']);
  assert.deepEqual(plan.dropPages, []);
  assert.equal(plan.stats.protected, 1);
});

test('離線旗標不是布林 true 時，看起來有 target 的空集合仍完全不動作', () => {
  const dead = [{ id: 4, createdAt: 'not-a-time', pages: { p1: { targetId: 'ghost' } } }];
  const blocked = planReap({
    spaces: [null, dead[0]],
    liveTargetIds: new Set(),
    now: 1,
    policy: { reapIdleWhenNoLiveTargets: 'true', reapDeadSpaces: true },
  });
  assert.equal(blocked.reason, 'no-live-targets');
  assert.deepEqual(blocked.closeSpaces, []);
  assert.equal(blocked.stats.examined, 1);
  assert.equal(blocked.stats.skipped, 1);

  const optedIn = planReap({
    spaces: dead,
    liveTargetIds: [],
    now: 1,
    policy: { reapIdleWhenNoLiveTargets: true, reapDeadSpaces: true, maxSpaces: 10 },
  });
  assert.equal(optedIn.reason, undefined);
  assert.deepEqual(optedIn.closeSpaces, [4]);

  const deathOff = planReap({
    spaces: dead,
    liveTargetIds: [],
    now: 1,
    policy: { reapIdleWhenNoLiveTargets: true, reapDeadSpaces: false, idleSpaceMs: 1, maxSpaces: 10 },
  });
  assert.deepEqual(deathOff.closeSpaces, []);
});

test('關閉整個空間時不再列出 dropPages；存活空間的過期 activeTargetId 仍只做診斷', () => {
  const live = planReap({
    spaces: [{
      id: 1,
      activeTargetId: 'STALE',
      createdAt: '2026-01-01T00:00:00.000Z',
      pages: { p1: { targetId: 'LIVE' }, p2: { targetId: 'STALE' } },
    }],
    liveTargetIds: ['LIVE'],
    now: Date.parse('2026-01-01T00:00:00.000Z'),
    policy: { dropDeadPages: true, maxSpaces: 10, idleSpaceMs: 86_400_000 },
  });
  assert.deepEqual(live.closeSpaces, []);
  assert.deepEqual(live.dropPages, [{ spaceId: 1, label: 'p2', targetId: 'STALE' }]);
  assert.deepEqual(live.staleActiveTargets, [{ spaceId: 1, targetId: 'STALE' }]);

  const closed = planReap({
    spaces: [{
      id: 5,
      activeTargetId: 'GONE',
      createdAt: 'not-a-date',
      pages: { p1: { targetId: 'GONE' } },
    }],
    liveTargetIds: ['KEEP'],
    now: 0,
    policy: { reapDeadSpaces: true, dropDeadPages: true, maxSpaces: 10 },
  });
  assert.deepEqual(closed.closeSpaces, [5]);
  assert.deepEqual(closed.dropPages, []);
  assert.deepEqual(closed.staleActiveTargets, []);

  const keepDeadPages = planReap({
    spaces: [{
      id: 1,
      activeTargetId: 'STALE',
      createdAt: '2026-01-01T00:00:00.000Z',
      pages: { p1: { targetId: 'LIVE' }, p2: { targetId: 'STALE' } },
    }],
    liveTargetIds: ['LIVE'],
    now: Date.parse('2026-01-01T00:00:00.000Z'),
    policy: { dropDeadPages: false, maxSpaces: 10, idleSpaceMs: 86_400_000 },
  });
  assert.deepEqual(keepDeadPages.dropPages, []);
  assert.deepEqual(keepDeadPages.staleActiveTargets, [{ spaceId: 1, targetId: 'STALE' }]);
});

test('數字 target 不會因為 live 清單裡有同值數字而算存活；重複 id 會各關一次', () => {
  const numeric = planReap({
    spaces: [{ id: 1, createdAt: 'not-a-date', pages: { p1: { targetId: 123 } } }],
    liveTargetIds: [123, '123'],
    now: 0,
    policy: { reapDeadSpaces: true, idleSpaceMs: 1, maxSpaces: 10 },
  });
  assert.deepEqual(numeric.closeSpaces, []);
  assert.equal(numeric.stats.live, 0);

  const input = [
    { id: 2, name: 'b', createdAt: '2020-01-02T00:00:00.000Z', pages: { p1: { targetId: 'GONE' } } },
    { id: 2, name: 'b2', createdAt: '2020-01-01T00:00:00.000Z', pages: { p1: { targetId: 'GONE' } } },
  ];
  const before = JSON.stringify(input);
  const dup = planReap({
    spaces: input,
    liveTargetIds: ['KEEP'],
    now: Date.parse('2026-01-01T00:00:00.000Z'),
    policy: { maxSpaces: 50, reapDeadSpaces: true },
  });
  assert.deepEqual(dup.closeSpaces, [2, 2]);
  assert.equal(JSON.stringify(input), before);
});

test('非陣列 spaces 回 invalid-input；陣列裡的垃圾項只計入 skipped', () => {
  const invalid = planReap({ spaces: { length: 1 }, liveTargetIds: ['x'] });
  assert.equal(invalid.reason, 'invalid-input');
  assert.deepEqual(invalid.closeSpaces, []);
  assert.deepEqual(invalid.stats, {
    examined: 0, skipped: 0, live: 0, protected: 0, closed: 0, pagesDropped: 0, staleActiveTargets: 0, overCap: 0,
  });

  const mixed = planReap({
    spaces: [null, 1, 'x', { id: 3, createdAt: '2026-01-01T00:00:00.000Z', pages: { p1: { targetId: 'LIVE' } } }],
    liveTargetIds: ['LIVE'],
    now: Date.parse('2026-01-01T00:00:00.000Z'),
    policy: { maxSpaces: 10 },
  });
  assert.equal(mixed.reason, undefined);
  assert.equal(mixed.stats.skipped, 3);
  assert.equal(mixed.stats.examined, 1);
  assert.equal(mixed.stats.live, 1);
  assert.deepEqual(mixed.closeSpaces, []);
});

test('applyReapPlan 對畸形計畫是 no-op，並依字串 id 跳過已關閉空間的分頁', () => {
  assert.deepEqual(applyReapPlan(null, null), { closedSpaces: [], droppedPages: [] });
  assert.deepEqual(
    applyReapPlan({}, { closeSpaces: [1], dropPages: [{ spaceId: 1, label: 'p' }] }),
    { closedSpaces: [], droppedPages: [] },
  );

  let removes = 0;
  assert.deepEqual(
    applyReapPlan({ removePage() { removes += 1; } }, { closeSpaces: 'nope', dropPages: { label: 'p' } }),
    { closedSpaces: [], droppedPages: [] },
  );
  assert.equal(removes, 0);

  const calls = [];
  const out = applyReapPlan({
    deleteSpace(id) { calls.push(['c', id]); },
    removePage(id, label) { calls.push(['d', id, label]); },
  }, {
    closeSpaces: [1],
    dropPages: [
      { spaceId: 1, label: 'p1', targetId: 'a' },
      { spaceId: '1', label: 'p2', targetId: 'b' },
      { spaceId: 2, label: 'p3', targetId: 'c' },
      { spaceId: 2 },
      { spaceId: 2, label: null },
      { spaceId: 3, label: '' },
      { spaceId: 3, label: 0 },
    ],
  });
  assert.deepEqual(calls, [['c', 1], ['d', 2, 'p3'], ['d', 3, ''], ['d', 3, 0]]);
  assert.deepEqual(out.closedSpaces, [1]);
  assert.equal(out.droppedPages.length, 3);

  let n = 0;
  assert.throws(() => applyReapPlan({
    deleteSpace() {
      n += 1;
      if (n === 2) throw new Error('boom');
    },
    removePage() { throw new Error('remove should not run'); },
  }, { closeSpaces: ['a', 'b', 'c'], dropPages: [{ spaceId: 'z', label: 'p' }] }), { message: 'boom' });
  assert.equal(n, 2);
});

test('套到真實 Store 時，丟棄的作用中分頁會清 activeTargetId，重套不丟存活頁', () => {
  withTmp((dir) => {
    const file = join(dir, 'ledger.json');
    const store = new Store(file);
    const space = store.create({ name: 's' });
    store.bindPage(space.id, 'p1', 'T-live');
    store.addPage(space.id, 'p2', 'T-dead');
    space.activeTargetId = 'T-dead';
    store.persist();
    const plan = planReap({
      spaces: store.list(),
      liveTargetIds: ['T-live'],
      now: Date.now(),
      policy: { dropDeadPages: true, maxSpaces: 10, idleSpaceMs: 86_400_000, reapDeadSpaces: true },
    });
    assert.deepEqual(plan.closeSpaces, []);
    assert.equal(plan.dropPages.length, 1);
    assert.equal(plan.dropPages[0].label, 'p2');
    applyReapPlan(store, plan);
    const again = applyReapPlan(store, plan);
    assert.equal(again.droppedPages.length, 1);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.spaces[String(space.id)].pages.p1.targetId, 'T-live');
    assert.equal(Object.hasOwn(saved.spaces[String(space.id)].pages, 'p2'), false);
    assert.equal(saved.spaces[String(space.id)].activeTargetId, null);
    assert.equal(saved.spaces[String(space.id)].name, 's');
  });
});

test('套到真實 Store 時，死空間連同 labelSeq 一起刪，存活空間原樣留下', () => {
  withTmp((dir) => {
    const file = join(dir, 'ledger.json');
    const store = new Store(file);
    const live = store.create({ name: 'live' });
    const dead = store.create({ name: 'dead' });
    store.bindPage(live.id, 'p1', 'T-live');
    store.bindPage(dead.id, 'p1', 'T-gone');
    const plan = planReap({
      spaces: store.list(),
      liveTargetIds: ['T-live'],
      now: Date.now(),
      policy: { reapDeadSpaces: true, idleSpaceMs: 86_400_000 * 365, maxSpaces: 50, dropDeadPages: true },
    });
    assert.deepEqual(plan.closeSpaces, [dead.id]);
    assert.deepEqual(plan.dropPages, []);
    applyReapPlan(store, plan);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(Object.hasOwn(saved.spaces, String(dead.id)), false);
    assert.equal(Object.hasOwn(saved.labelSeq, String(dead.id)), false);
    assert.equal(saved.spaces[String(live.id)].pages.p1.targetId, 'T-live');
    assert.equal(saved.spaces[String(live.id)].name, 'live');
    assert.equal(saved.labelSeq[String(live.id)], 1);
  });
});
