// 邊界與錯誤路徑：reaper 的分類、閒置、上限、保護與套用。
// 不連線、不讀寫 repo 以外的路徑；不重複 fmb_feature2 已涵蓋的主路徑敘述。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_POLICY,
  applyReapPlan,
  classifySpace,
  pageEntries,
  planReap,
  toTargetSet,
} from '../fmb_feature2/reaper.js';

const NOW = Date.parse('2026-06-01T00:00:00.000Z');
const FRESH = '2026-06-01T00:00:00.000Z';
const OLD = '2020-01-01T00:00:00.000Z';

describe('toTargetSet / pageEntries', () => {
  test('只保留非空字串，並去掉重複', () => {
    assert.equal(toTargetSet(undefined).size, 0);
    assert.equal(toTargetSet(null).size, 0);
    assert.equal(toTargetSet('LIVE').size, 0);
    assert.equal(toTargetSet(new Set(['', 'A', 'A', 1])).size, 1);
    assert.equal(toTargetSet(['A', 'A', '', 2, null]).size, 1);
    assert.equal(toTargetSet(['A', 'B']).has('B'), true);
  });

  test('非物件分頁與空白 targetId 會被攤平規則丟掉或視為未綁定', () => {
    assert.deepEqual(pageEntries(null), []);
    assert.deepEqual(pageEntries({ pages: [] }), []);
    const entries = pageEntries({
      pages: {
        p1: { targetId: 'T' },
        p2: null,
        p3: { targetId: '' },
        p4: { title: 'x' },
      },
    });
    assert.deepEqual(entries.map((e) => [e.label, e.targetId]), [
      ['p1', 'T'],
      ['p3', null],
      ['p4', null],
    ]);
  });
});

describe('classifySpace 邊界', () => {
  test('缺少 space 時是 empty，且無法解析的時間不算閒置', () => {
    const missing = classifySpace(undefined);
    assert.equal(missing.kind, 'empty');
    assert.equal(missing.ageMs, null);
    assert.equal(missing.idle, false);
    assert.deepEqual(pageEntries(undefined), []);
  });

  test('閒置邊界含等號，未來時間夾成 0，壞時間不閒置', () => {
    const now = 5_000_000;
    const policy = { idleSpaceMs: 1000 };
    const liveTargets = ['LIVE'];
    const at = classifySpace(
      { createdAt: now - 1000, pages: { p1: { targetId: null } } },
      { liveTargets, now, policy },
    );
    assert.equal(at.ageMs, 1000);
    assert.equal(at.idle, true);
    assert.equal(at.kind, 'unbound');

    const below = classifySpace(
      { createdAt: now - 999, pages: { p1: { targetId: null } } },
      { liveTargets, now, policy },
    );
    assert.equal(below.ageMs, 999);
    assert.equal(below.idle, false);

    const future = classifySpace(
      { createdAt: now + 10_000, pages: { p1: { targetId: null } } },
      { liveTargets, now, policy },
    );
    assert.equal(future.ageMs, 0);
    assert.equal(future.idle, false);

    for (const createdAt of ['not-a-date', '', Number.NaN]) {
      const bad = classifySpace(
        { createdAt, pages: { p1: { targetId: null } } },
        { liveTargets, now, policy },
      );
      assert.equal(bad.ageMs, null, String(createdAt));
      assert.equal(bad.idle, false);
    }

    const plan = planReap({
      now,
      liveTargetIds: liveTargets,
      policy,
      spaces: [
        { id: 1, createdAt: now - 1000, pages: { p1: { targetId: null } } },
        { id: 2, createdAt: now - 999, pages: { p1: { targetId: null } } },
      ],
    });
    assert.deepEqual(plan.closeSpaces, [1]);
  });

  test('空字串 target 是未綁定，空白字串與數字 target 依字串規則分類', () => {
    const now = 0;
    const policy = { idleSpaceMs: 999999 };
    const empty = classifySpace(
      { pages: { p1: { targetId: '' } } },
      { liveTargets: [''], now, policy },
    );
    assert.equal(empty.kind, 'unbound');

    const blank = classifySpace(
      { pages: { p1: { targetId: ' ' } } },
      { liveTargets: [' '], now, policy },
    );
    assert.equal(blank.kind, 'live');

    const blankMiss = classifySpace(
      { pages: { p1: { targetId: ' ' } } },
      { liveTargets: ['LIVE'], now, policy },
    );
    assert.equal(blankMiss.kind, 'dead');

    const numeric = classifySpace(
      { pages: { p1: { targetId: 5 } } },
      { liveTargets: ['5'], now, policy },
    );
    assert.equal(numeric.kind, 'unbound');
    assert.equal(numeric.deadPages.length, 0);
  });

  test('分頁值都不是物件時視為 empty', () => {
    const info = classifySpace(
      { createdAt: FRESH, pages: { p1: 1, p2: [], p3: null } },
      { liveTargets: ['LIVE'], now: NOW, policy: { idleSpaceMs: 1 } },
    );
    assert.equal(info.kind, 'empty');
    assert.equal(info.entries.length, 0);
    assert.equal(info.idle, false);
  });
});

describe('planReap 輸入與安全閥', () => {
  test('spaces 不是陣列時是 invalid-input', () => {
    assert.equal(planReap().reason, 'invalid-input');
    for (const spaces of [undefined, null, {}, 'x', 1]) {
      const plan = planReap({ spaces, liveTargetIds: ['LIVE'], now: NOW });
      assert.equal(plan.reason, 'invalid-input');
      assert.deepEqual(plan.closeSpaces, []);
      assert.deepEqual(plan.dropPages, []);
      assert.equal(plan.stats.examined, 0);
      assert.equal(plan.stats.skipped, 0);
    }
  });

  test('live 集合為空時只回報計數，不關閉舊的 dead 空間', () => {
    const plan = planReap({
      now: NOW,
      liveTargetIds: [],
      spaces: [
        null,
        { id: 1, createdAt: OLD, pages: { p1: { targetId: 'GONE' } } },
      ],
    });
    assert.equal(plan.reason, 'no-live-targets');
    assert.deepEqual(plan.closeSpaces, []);
    assert.deepEqual(plan.dropPages, []);
    assert.deepEqual(plan.staleActiveTargets, []);
    assert.equal(plan.stats.examined, 1);
    assert.equal(plan.stats.skipped, 1);
    assert.equal(plan.stats.closed, 0);
  });

  test('數字與裸字串 live id 不算存活 target', () => {
    const spaces = [{ id: 1, createdAt: FRESH, pages: { p1: { targetId: '9' } } }];
    const numeric = planReap({ now: NOW, liveTargetIds: [9, 'OTHER'], spaces });
    assert.equal(numeric.reason, undefined);
    assert.deepEqual(numeric.closeSpaces, [1]);

    const bare = planReap({ now: NOW, liveTargetIds: '9', spaces });
    assert.equal(bare.reason, 'no-live-targets');
    assert.deepEqual(bare.closeSpaces, []);

    const textual = planReap({ now: NOW, liveTargetIds: ['9'], spaces });
    assert.deepEqual(textual.closeSpaces, []);
    assert.equal(textual.stats.live, 1);
  });

  test('非有限 now 會退回目前時間，因此古老未綁定空間會被當成閒置', () => {
    for (const now of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const plan = planReap({
        now,
        liveTargetIds: ['LIVE'],
        spaces: [{ id: 1, createdAt: '2000-01-01T00:00:00.000Z', pages: { p1: { targetId: null } } }],
      });
      assert.ok(Date.now() > Date.parse('2000-01-01T00:00:00.000Z') + 30 * 60 * 1000);
      assert.deepEqual(plan.closeSpaces, [1]);
    }
  });

  test('明確允許空 live 集合時，才回收閒置未綁定與 dead', () => {
    const plan = planReap({
      now: NOW,
      liveTargetIds: [],
      policy: { reapIdleWhenNoLiveTargets: true },
      spaces: [
        { id: 1, createdAt: OLD, pages: { p1: { targetId: null } } },
        { id: 2, createdAt: FRESH, pages: { p1: { targetId: null } } },
        { id: 3, createdAt: FRESH, pages: { p1: { targetId: 'GONE' } } },
      ],
    });
    assert.equal(plan.reason, undefined);
    assert.deepEqual(plan.closeSpaces, [1, 3]);
  });

  test('旗標必須是嚴格 true；字串閒置時間不會讓空間變閒置', () => {
    const plan = planReap({
      now: NOW,
      liveTargetIds: ['LIVE'],
      policy: {
        reapDeadSpaces: 'yes',
        dropDeadPages: 1,
        idleSpaceMs: '1',
        reapIdleWhenNoLiveTargets: 1,
      },
      spaces: [
        {
          id: 1,
          createdAt: OLD,
          pages: { p1: { targetId: 'GONE' }, p2: { targetId: 'LIVE' } },
        },
        { id: 2, createdAt: OLD, pages: { p1: { targetId: 'GONE' } } },
      ],
    });
    assert.deepEqual(plan.closeSpaces, []);
    assert.deepEqual(plan.dropPages, []);
  });

  test('policy 裡的 undefined 不會覆蓋預設，也不會改到呼叫端物件', () => {
    const policy = { idleSpaceMs: undefined, maxSpaces: undefined, extra: true };
    const snapshot = { ...policy };
    const plan = planReap({
      now: NOW,
      liveTargetIds: ['LIVE'],
      policy,
      spaces: [{ id: 1, createdAt: OLD, pages: { p1: { targetId: null } } }],
    });
    assert.deepEqual(policy, snapshot);
    assert.deepEqual(plan.closeSpaces, [1]);
  });
});

describe('planReap 關閉、丟頁與上限', () => {
  test('混合 ledger 的計畫是確定的，而且不改輸入順序', () => {
    const spaces = [
      null,
      {
        id: 1,
        name: 'live',
        createdAt: OLD,
        activeTargetId: 'DEAD-ACTIVE',
        pages: {
          p1: { targetId: 'LIVE' },
          p2: { targetId: 'GONE' },
          p3: { targetId: '' },
          p4: null,
        },
      },
      {
        id: 2,
        name: 'pinned-dead',
        pinned: true,
        createdAt: OLD,
        activeTargetId: 'GONE',
        pages: { p1: { targetId: 'GONE' } },
      },
      {
        id: 3,
        name: 'protected',
        createdAt: OLD,
        activeTargetId: 'GONE',
        pages: { p1: { targetId: 'GONE' } },
      },
      {
        id: 4,
        name: 'dead',
        createdAt: FRESH,
        activeTargetId: 'GONE',
        pages: { p1: { targetId: 'GONE' } },
      },
      {
        id: 5,
        name: 'unbound-fresh',
        createdAt: FRESH,
        activeTargetId: 'LIVE',
        pages: { p1: { targetId: null } },
      },
      {
        id: 6,
        name: 'unbound-old',
        createdAt: OLD,
        pages: { p1: { targetId: null } },
      },
      {
        id: 7,
        name: 'mixed-fresh',
        createdAt: FRESH,
        activeTargetId: '',
        pages: { p1: { targetId: 'GONE' }, p2: { targetId: null } },
      },
      { name: 'no-id', pages: {} },
    ];
    const plan = planReap({
      now: NOW,
      liveTargetIds: ['LIVE', '', 42],
      protect: [3, null],
      spaces,
    });
    assert.equal(plan.reason, undefined);
    assert.deepEqual(plan.closeSpaces, [4, 6]);
    assert.deepEqual(plan.dropPages, [
      { spaceId: 1, label: 'p2', targetId: 'GONE' },
      { spaceId: 7, label: 'p1', targetId: 'GONE' },
    ]);
    assert.deepEqual(plan.staleActiveTargets, [{ spaceId: 1, targetId: 'DEAD-ACTIVE' }]);
    assert.deepEqual(plan.stats, {
      examined: 7,
      skipped: 2,
      live: 1,
      protected: 2,
      closed: 2,
      pagesDropped: 2,
      staleActiveTargets: 1,
      overCap: 0,
    });
    assert.equal(spaces[0], null);
    assert.equal(spaces[1].id, 1);
    assert.equal(spaces[8].name, 'no-id');
  });

  test('idleSpaceMs 0 會關掉年齡為 0 的未綁定空間，但不會關掉存活空間', () => {
    const plan = planReap({
      now: NOW,
      liveTargetIds: ['LIVE'],
      policy: { idleSpaceMs: 0 },
      spaces: [
        { id: 1, createdAt: FRESH, pages: { p1: { targetId: null } } },
        { id: 2, createdAt: FRESH, pages: { p1: { targetId: 'LIVE' } } },
      ],
    });
    assert.deepEqual(plan.closeSpaces, [1]);
  });

  test('idleSpaceMs 為 Infinity 時不因閒置關閉，dead 仍可因死亡規則關閉', () => {
    const plan = planReap({
      now: NOW,
      liveTargetIds: ['LIVE'],
      policy: { idleSpaceMs: Number.POSITIVE_INFINITY },
      spaces: [
        { id: 1, createdAt: OLD, pages: { p1: { targetId: null } } },
        { id: 2, createdAt: FRESH, pages: { p1: { targetId: 'GONE' } } },
      ],
    });
    assert.deepEqual(plan.closeSpaces, [2]);
  });

  test('空的 pages 且已閒置會關閉；全是壞分頁值的新空間會留下', () => {
    const plan = planReap({
      now: NOW,
      liveTargetIds: ['LIVE'],
      spaces: [
        { id: 1, createdAt: OLD, pages: {} },
        { id: 2, createdAt: FRESH, pages: { p1: 1, p2: [], p3: null } },
      ],
    });
    assert.deepEqual(plan.closeSpaces, [1]);
  });

  test('reapDeadSpaces false 仍會因閒置關閉舊 dead；新鮮 dead 只在 drop 旗標開啟時丟頁', () => {
    const idleAnyway = planReap({
      now: NOW,
      liveTargetIds: ['LIVE'],
      policy: { reapDeadSpaces: false },
      spaces: [{ id: 1, createdAt: OLD, pages: { p1: { targetId: 'GONE' } } }],
    });
    assert.deepEqual(idleAnyway.closeSpaces, [1]);
    assert.deepEqual(idleAnyway.dropPages, []);

    const spaces = [{
      id: 1,
      createdAt: FRESH,
      pages: { p1: { targetId: 'GONE' }, p2: { targetId: 'ALSO' } },
    }];
    const dropped = planReap({
      now: NOW,
      liveTargetIds: ['LIVE'],
      policy: { reapDeadSpaces: false, dropDeadPages: true },
      spaces,
    });
    assert.deepEqual(dropped.closeSpaces, []);
    assert.deepEqual(dropped.dropPages.map((d) => d.label), ['p1', 'p2']);

    const kept = planReap({
      now: NOW,
      liveTargetIds: ['LIVE'],
      policy: { reapDeadSpaces: false, dropDeadPages: false },
      spaces,
    });
    assert.deepEqual(kept.closeSpaces, []);
    assert.deepEqual(kept.dropPages, []);
  });

  test('id 0 是候選；NaN id 不會讓計畫丟例外', () => {
    const zero = planReap({
      now: NOW,
      liveTargetIds: ['LIVE'],
      spaces: [
        { id: 0, createdAt: FRESH, pages: { p1: { targetId: 'GONE' } } },
        { id: 1, createdAt: FRESH, pages: { p1: { targetId: 'LIVE' } } },
      ],
    });
    assert.deepEqual(zero.closeSpaces, [0]);
    assert.equal(zero.stats.examined, 2);

    const nan = planReap({
      now: 0,
      liveTargetIds: ['LIVE'],
      spaces: [{ id: Number.NaN, createdAt: 0, pages: { p1: { targetId: null } } }],
    });
    assert.equal(nan.stats.examined, 1);
    assert.equal(nan.stats.skipped, 0);
    assert.deepEqual(nan.closeSpaces, []);
  });

  test('字串 pinned 不算保護；protect 接受數字或單一字串', () => {
    const pinnedText = planReap({
      now: NOW,
      liveTargetIds: ['LIVE'],
      spaces: [{ id: 1, pinned: 'true', createdAt: FRESH, pages: { p1: { targetId: 'GONE' } } }],
    });
    assert.deepEqual(pinnedText.closeSpaces, [1]);

    const spaces = [
      { id: 4, createdAt: FRESH, pages: { p1: { targetId: 'GONE' } } },
      { id: 5, createdAt: FRESH, pages: { p1: { targetId: 'GONE' } } },
    ];
    const byNumber = planReap({ now: NOW, liveTargetIds: ['LIVE'], protect: 4, spaces });
    const byString = planReap({ now: NOW, liveTargetIds: ['LIVE'], protect: '4', spaces });
    assert.deepEqual(byNumber.closeSpaces, [5]);
    assert.deepEqual(byString.closeSpaces, [5]);
  });

  test('maxSpaces 的 0、空字串、null、NaN 與存活空間豁免', () => {
    const baseSpaces = [
      { id: 1, createdAt: FRESH, pages: { p1: { targetId: 'LIVE' } } },
      { id: 2, createdAt: FRESH, pages: { p1: { targetId: null } } },
    ];
    const asNull = planReap({
      now: NOW,
      liveTargetIds: ['LIVE'],
      policy: { maxSpaces: null },
      spaces: baseSpaces,
    });
    assert.deepEqual(asNull.closeSpaces, [2]);
    assert.equal(asNull.stats.overCap, 1);

    const asEmpty = planReap({
      now: NOW,
      liveTargetIds: ['LIVE'],
      policy: { maxSpaces: '' },
      spaces: baseSpaces,
    });
    assert.deepEqual(asEmpty.closeSpaces, [2]);

    const asNan = planReap({
      now: NOW,
      liveTargetIds: ['LIVE'],
      policy: { maxSpaces: Number.NaN },
      spaces: baseSpaces,
    });
    assert.deepEqual(asNan.closeSpaces, []);
    assert.equal(asNan.stats.overCap, 0);

    const allLive = planReap({
      now: NOW,
      liveTargetIds: ['L1', 'L2'],
      policy: { maxSpaces: 0 },
      spaces: [
        { id: 1, createdAt: OLD, pages: { p1: { targetId: 'L1' } } },
        { id: 2, createdAt: OLD, pages: { p1: { targetId: 'L2' } } },
      ],
    });
    assert.deepEqual(allLive.closeSpaces, []);
    assert.equal(allLive.stats.overCap, 0);
    assert.equal(allLive.stats.live, 2);

    const exact = planReap({
      now: NOW,
      liveTargetIds: ['LIVE'],
      policy: { maxSpaces: 2 },
      spaces: [
        { id: 1, createdAt: FRESH, pages: { p1: { targetId: null } } },
        { id: 2, createdAt: FRESH, pages: { p1: { targetId: null } } },
      ],
    });
    assert.deepEqual(exact.closeSpaces, []);
    assert.equal(exact.stats.overCap, 0);

    const lowest = planReap({
      now: NOW,
      liveTargetIds: ['LIVE'],
      policy: { maxSpaces: 1 },
      spaces: [
        { id: 2, createdAt: FRESH, pages: { p1: { targetId: null } } },
        { id: 1, createdAt: FRESH, pages: { p1: { targetId: null } } },
      ],
    });
    assert.deepEqual(lowest.closeSpaces, [1]);
    assert.equal(lowest.stats.overCap, 1);

    const mixedCap = planReap({
      now: NOW,
      liveTargetIds: ['LIVE'],
      policy: { maxSpaces: 0 },
      spaces: [
        { id: 1, createdAt: FRESH, pages: { p1: { targetId: 'LIVE' } } },
        { id: 2, pinned: true, createdAt: OLD, pages: { p1: { targetId: 'GONE' } } },
        { id: 3, createdAt: FRESH, pages: { p1: { targetId: null } } },
      ],
    });
    assert.deepEqual(mixedCap.closeSpaces, [3]);
    assert.equal(mixedCap.stats.overCap, 1);
    assert.equal(mixedCap.stats.live, 1);
    assert.equal(mixedCap.stats.protected, 1);
  });

  test('無法解析的 createdAt 排序時視為 0，數字 id 仍以數值比較', () => {
    const spaces = [
      { id: 10, createdAt: OLD, pages: { p1: { targetId: 'GONE' } } },
      { id: 2, createdAt: OLD, pages: { p1: { targetId: 'GONE' } } },
      { id: 'a', name: 'b', createdAt: 'not-a-date', pages: { p1: { targetId: 'GONE' } } },
      { id: 'a', name: 'a', createdAt: 'not-a-date', pages: { p1: { targetId: 'GONE' } } },
    ];
    const plan = planReap({ now: NOW, liveTargetIds: ['LIVE'], spaces });
    assert.deepEqual(plan.closeSpaces, ['a', 'a', 2, 10]);
    assert.deepEqual(spaces.map((s) => s.id), [10, 2, 'a', 'a']);
  });

  test('重複 id 全部沿用最後一筆的分類', () => {
    const deadFirst = planReap({
      now: NOW,
      liveTargetIds: ['LIVE'],
      spaces: [
        { id: 5, name: 'a-dead', createdAt: FRESH, pages: { p1: { targetId: 'GONE' } } },
        { id: 5, name: 'b-live', createdAt: FRESH, pages: { p1: { targetId: 'LIVE' } } },
      ],
    });
    assert.deepEqual(deadFirst.closeSpaces, []);
    assert.equal(deadFirst.stats.live, 2);

    const liveFirst = planReap({
      now: NOW,
      liveTargetIds: ['LIVE'],
      spaces: [
        { id: 5, name: 'a-live', createdAt: FRESH, pages: { p1: { targetId: 'LIVE' } } },
        { id: 5, name: 'b-dead', createdAt: FRESH, pages: { p1: { targetId: 'GONE' } } },
      ],
    });
    assert.deepEqual(liveFirst.closeSpaces, [5, 5]);
    assert.equal(liveFirst.stats.live, 0);
  });
});

describe('applyReapPlan 與預設政策', () => {
  test('已關閉空間的丟頁會跳過，0 與空字串 label 仍會套用', () => {
    const calls = [];
    const store = {
      deleteSpace(id) { calls.push(['del', id]); },
      removePage(id, label) { calls.push(['drop', id, label]); },
    };
    const dropThree = { spaceId: 3, label: 0, targetId: 'Z' };
    const dropEmpty = { spaceId: 3, label: '' };
    const result = applyReapPlan(store, {
      closeSpaces: [1, 'sp-2'],
      dropPages: [
        { spaceId: 1, label: 'p1' },
        { spaceId: 'sp-2', label: 'pX' },
        dropThree,
        dropEmpty,
        { spaceId: 3, label: null },
        { spaceId: 4 },
        null,
        ['not', 'object'],
      ],
    });
    assert.deepEqual(calls, [
      ['del', 1],
      ['del', 'sp-2'],
      ['drop', 3, 0],
      ['drop', 3, ''],
    ]);
    assert.deepEqual(result.closedSpaces, [1, 'sp-2']);
    assert.deepEqual(result.droppedPages, [dropThree, dropEmpty]);
  });

  test('方法缺失、方法不是函式、或計畫是空的時候是 no-op', () => {
    assert.deepEqual(
      applyReapPlan({}, { closeSpaces: [1], dropPages: [{ spaceId: 2, label: 'p' }] }),
      { closedSpaces: [], droppedPages: [] },
    );
    assert.deepEqual(
      applyReapPlan(
        { deleteSpace: 1, removePage: 'x' },
        { closeSpaces: [1], dropPages: [{ spaceId: 2, label: 'p' }] },
      ),
      { closedSpaces: [], droppedPages: [] },
    );
    assert.deepEqual(applyReapPlan(undefined, undefined), { closedSpaces: [], droppedPages: [] });
    assert.deepEqual(applyReapPlan({}, null), { closedSpaces: [], droppedPages: [] });

    const closed = [];
    applyReapPlan(
      { deleteSpace(id) { closed.push(id); } },
      { closeSpaces: [7], dropPages: [{ spaceId: 8, label: 'p1' }] },
    );
    assert.deepEqual(closed, [7]);
  });

  test('DEFAULT_POLICY 被凍結，失敗的指派不會改到預設值', () => {
    assert.equal(Object.isFrozen(DEFAULT_POLICY), true);
    assert.throws(() => {
      DEFAULT_POLICY.idleSpaceMs = 0;
    }, TypeError);
    assert.equal(DEFAULT_POLICY.idleSpaceMs, 30 * 60 * 1000);
    assert.equal(DEFAULT_POLICY.maxSpaces, 50);
    assert.equal(DEFAULT_POLICY.reapDeadSpaces, true);
    assert.equal(DEFAULT_POLICY.dropDeadPages, true);
    assert.equal(DEFAULT_POLICY.reapIdleWhenNoLiveTargets, false);
  });
});
