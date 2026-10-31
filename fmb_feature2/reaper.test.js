// fmb_feature2/reaper.test.js — 純函式單元測試（不連網、不讀寫檔案）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_POLICY,
  applyReapPlan,
  classifySpace,
  pageEntries,
  planReap,
  toTargetSet,
} from './reaper.js';

const NOW = Date.parse('2026-01-01T12:00:00.000Z');
const iso = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();
const page = (targetId) => ({ targetId, openedBy: 'agent', title: '', url: '' });

function space(id, { ageMinutes = 0, pages = {}, pinned, name } = {}) {
  const s = {
    id,
    name: name ?? `space-${id}`,
    profileId: 'agent',
    ownership: 'agent',
    state: 'active',
    createdAt: iso(ageMinutes),
    pages,
    activeTargetId: null,
  };
  if (pinned !== undefined) s.pinned = pinned;
  return s;
}

test('toTargetSet 只保留非空字串，其他輸入視為空集合', () => {
  assert.equal(DEFAULT_POLICY.maxSpaces, 50);
  assert.equal(toTargetSet(new Set(['a', 'b'])).size, 2);
  assert.equal(toTargetSet(['a', '', null, 3]).size, 1);
  assert.equal(toTargetSet('abc').size, 0);
  assert.equal(toTargetSet(undefined).size, 0);
});

test('pageEntries 容忍缺漏 pages / null 分頁 / 空 targetId', () => {
  assert.deepEqual(pageEntries({}), []);
  assert.deepEqual(pageEntries({ pages: null }), []);
  assert.deepEqual(pageEntries(null), []);
  const entries = pageEntries({ pages: { p1: null, p2: { targetId: '' }, p3: { targetId: 'T-3' } } });
  assert.deepEqual(entries.map((e) => [e.label, e.targetId]), [['p2', null], ['p3', 'T-3']]);
});

test('classifySpace 分辨 live / dead / unbound / mixed / empty', () => {
  const live = new Set(['T-live']);
  const base = { createdAt: iso(0) };
  const kind = (pages) => classifySpace({ ...base, pages }, { liveTargets: live, now: NOW }).kind;
  assert.equal(kind({ p1: page('T-live') }), 'live');
  assert.equal(kind({ p1: page('T-gone') }), 'dead');
  assert.equal(kind({ p1: page(null) }), 'unbound');
  assert.equal(kind({ p1: page('T-gone'), p2: page(null) }), 'mixed');
  assert.equal(kind({}), 'empty');
});

test('classifySpace 依 idleSpaceMs 判定 idle，createdAt 缺失時不算 idle', () => {
  const live = new Set(['T-live']);
  const pages = { p1: page(null) };
  const at = (mins) => classifySpace({ createdAt: iso(mins), pages }, { liveTargets: live, now: NOW, policy: { idleSpaceMs: 30 * 60_000 } });
  assert.equal(at(10).idle, false);
  assert.equal(at(45).idle, true);
  const noTime = classifySpace({ pages }, { liveTargets: live, now: NOW });
  assert.equal(noTime.idle, false);
  assert.equal(noTime.ageMs, null);
});

test('存活空間不被關閉，但其已失效的分頁記錄會被清掉', () => {
  const spaces = [space(1, { pages: { p1: page('T-live'), p2: page('T-gone') } })];
  const plan = planReap({ spaces, liveTargetIds: ['T-live'], now: NOW });
  assert.deepEqual(plan.closeSpaces, []);
  assert.deepEqual(plan.dropPages, [{ spaceId: 1, label: 'p2', targetId: 'T-gone' }]);
  assert.equal(plan.stats.live, 1);
});

test('所有分頁都失效的空間立即回收（預設 reapDeadSpaces）', () => {
  const spaces = [space(7, { pages: { p1: page('T-gone') } })];
  const plan = planReap({ spaces, liveTargetIds: ['T-live'], now: NOW });
  assert.deepEqual(plan.closeSpaces, [7]);
  assert.deepEqual(plan.dropPages, []);
});

test('reapDeadSpaces:false 時不關閉，只丟棄失效分頁', () => {
  const spaces = [space(7, { pages: { p1: page('T-gone') } })];
  const plan = planReap({ spaces, liveTargetIds: ['T-live'], now: NOW, policy: { reapDeadSpaces: false } });
  assert.deepEqual(plan.closeSpaces, []);
  assert.deepEqual(plan.dropPages, [{ spaceId: 7, label: 'p1', targetId: 'T-gone' }]);
});

test('全新的空佔位空間（僅未綁定 p1）不會被回收', () => {
  const spaces = [space(8, { pages: { p1: page(null) } })];
  const plan = planReap({ spaces, liveTargetIds: ['T-live'], now: NOW });
  assert.deepEqual(plan.closeSpaces, []);
  assert.deepEqual(plan.dropPages, []);
});

test('混合（失效＋未綁定）且未閒置：不關閉，但清掉失效分頁', () => {
  const spaces = [space(9, { pages: { p1: page('T-gone'), p2: page(null) } })];
  const plan = planReap({ spaces, liveTargetIds: ['T-live'], now: NOW });
  assert.deepEqual(plan.closeSpaces, []);
  assert.deepEqual(plan.dropPages, [{ spaceId: 9, label: 'p1', targetId: 'T-gone' }]);
});

test('閒置超過 idleSpaceMs 且無存活分頁的空間會被回收', () => {
  const spaces = [
    space(10, { ageMinutes: 120, pages: { p1: page(null) } }),
    space(11, { ageMinutes: 5, pages: { p1: page(null) } }),
  ];
  const plan = planReap({
    spaces,
    liveTargetIds: ['T-live'],
    now: NOW,
    policy: { idleSpaceMs: 30 * 60_000 },
  });
  assert.deepEqual(plan.closeSpaces, [10]);
});

test('pinned 與 protect 指定的空間：不關閉、也不丟棄分頁', () => {
  const spaces = [
    space(20, { pinned: true, pages: { p1: page('T-gone') } }),
    space(21, { pages: { p1: page('T-gone') } }),
    space(22, { pages: { p1: page('T-gone') } }),
  ];
  const plan = planReap({ spaces, liveTargetIds: ['T-live'], now: NOW, protect: [21] });
  assert.deepEqual(plan.closeSpaces, [22]);
  assert.deepEqual(plan.dropPages, []);
  assert.equal(plan.stats.protected, 2);
});

test('live 集合為空時完全不動作（安全閥）', () => {
  const spaces = [space(30, { pages: { p1: page('T-gone') } })];
  const empty = planReap({ spaces, liveTargetIds: [], now: NOW });
  assert.equal(empty.reason, 'no-live-targets');
  assert.deepEqual(empty.closeSpaces, []);
  assert.deepEqual(empty.dropPages, []);
  assert.equal(empty.stats.examined, 1);

  const forced = planReap({
    spaces: [space(31, { ageMinutes: 90, pages: { p1: page(null) } })],
    liveTargetIds: [],
    now: NOW,
    policy: { reapIdleWhenNoLiveTargets: true },
  });
  assert.equal(forced.reason, undefined);
  assert.deepEqual(forced.closeSpaces, [31]);
});

test('maxSpaces 上限：由最舊的非存活空間開始回收', () => {
  const spaces = [
    space(40, { pages: { p1: page('T-live') } }),
    space(41, { pages: { p1: page(null) } }),
    space(42, { pages: { p1: page(null) } }),
    space(43, { pages: { p1: page(null) } }),
  ];
  const plan = planReap({ spaces, liveTargetIds: ['T-live'], now: NOW, policy: { maxSpaces: 2 } });
  assert.deepEqual(plan.closeSpaces, [41, 42]);
  assert.equal(plan.stats.overCap, 2);
});

test('存活空間永不因 maxSpaces 而被犧牲', () => {
  const spaces = [
    space(50, { pages: { p1: page('T-a') } }),
    space(51, { pages: { p1: page('T-b') } }),
    space(52, { pages: { p1: page('T-c') } }),
  ];
  const plan = planReap({ spaces, liveTargetIds: ['T-a', 'T-b', 'T-c'], now: NOW, policy: { maxSpaces: 1 } });
  assert.deepEqual(plan.closeSpaces, []);
  assert.equal(plan.stats.overCap, 0);
});

test('輸出順序具決定性（與輸入順序無關）', () => {
  const make = () => [
    space(61, { pages: { p1: page('T-gone-1') } }),
    space(60, { pages: { p1: page('T-gone-0') } }),
    space(62, { ageMinutes: 120, pages: { p1: page(null) } }),
  ];
  const a = planReap({ spaces: make(), liveTargetIds: ['T-live'], now: NOW });
  const b = planReap({ spaces: make().reverse(), liveTargetIds: ['T-live'], now: NOW });
  assert.deepEqual(a.closeSpaces, [60, 61, 62]);
  assert.deepEqual(b.closeSpaces, a.closeSpaces);
});

test('非法輸入與缺少 id 的記錄會被安全略過', () => {
  const bad = planReap({ spaces: 'not-an-array', liveTargetIds: ['T-live'], now: NOW });
  assert.equal(bad.reason, 'invalid-input');
  assert.deepEqual(bad.closeSpaces, []);

  const plan = planReap({
    spaces: [{ name: 'no-id', pages: { p1: page('T-gone') } }, null, space(70, { pages: { p1: page('T-gone') } })],
    liveTargetIds: ['T-live'],
    now: NOW,
  });
  assert.deepEqual(plan.closeSpaces, [70]);
  assert.equal(plan.stats.skipped, 2);
});

test('staleActiveTargets 只做提示，不影響回收計畫', () => {
  const spaces = [space(80, { pages: { p1: page('T-live') } })];
  spaces[0].activeTargetId = 'T-dead';
  const plan = planReap({ spaces, liveTargetIds: ['T-live'], now: NOW });
  assert.deepEqual(plan.closeSpaces, []);
  assert.deepEqual(plan.staleActiveTargets, [{ spaceId: 80, targetId: 'T-dead' }]);
});

test('applyReapPlan 只呼叫既有 API，且不重複刪除已關閉空間的分頁', () => {
  const calls = [];
  const fakeStore = {
    deleteSpace: (id) => calls.push(['deleteSpace', id]),
    removePage: (id, label) => calls.push(['removePage', id, label]),
  };
  const result = applyReapPlan(fakeStore, {
    closeSpaces: [1],
    dropPages: [
      { spaceId: 1, label: 'p2', targetId: 'T-gone' },
      { spaceId: 2, label: 'p1', targetId: 'T-gone-2' },
    ],
  });
  assert.deepEqual(result.closedSpaces, [1]);
  assert.deepEqual(result.droppedPages, [{ spaceId: 2, label: 'p1', targetId: 'T-gone-2' }]);
  assert.deepEqual(calls, [['deleteSpace', 1], ['removePage', 2, 'p1']]);
});

test('applyReapPlan 對缺少方法的物件是安全 no-op', () => {
  const result = applyReapPlan({}, { closeSpaces: [1], dropPages: [{ spaceId: 2, label: 'p1' }] });
  assert.deepEqual(result, { closedSpaces: [], droppedPages: [] });
  assert.deepEqual(applyReapPlan(null, { closeSpaces: [1] }), { closedSpaces: [], droppedPages: [] });
});
