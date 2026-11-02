// 回歸：fmb_feature2/reaper.js 對 live target／createdAt／protect／maxSpaces 的形狀防禦。
// 不重跑 reaper.test.js 已涵蓋的預設閒置、空 live 安全閥主路徑與決定性排序。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySpace, planReap, toTargetSet } from '../fmb_feature2/reaper.js';

const NOW = Date.parse('2020-06-01T00:00:00.000Z');

function unbound(id, createdAt = '2020-06-01T00:00:00.000Z') {
  return {
    id,
    createdAt,
    pages: { p1: { targetId: null } },
  };
}

test('toTargetSet 丟掉空字串與非字串', () => {
  assert.deepEqual([...toTargetSet(['', 'ok', 1, null, undefined])], ['ok']);
  assert.deepEqual([...toTargetSet(new Set(['', 'ok', 3]))], ['ok']);
  assert.equal(toTargetSet('ok').size, 0);
});

test('live 集合只有空字串時仍走 no-live-targets，不會把空間當死亡回收', () => {
  const plan = planReap({
    spaces: [{
      id: 1,
      createdAt: '2000-01-01T00:00:00.000Z',
      pages: { p1: { targetId: 'still-here' } },
    }],
    liveTargetIds: [''],
    now: NOW,
    policy: { reapDeadSpaces: true },
  });
  assert.equal(plan.reason, 'no-live-targets');
  assert.deepEqual(plan.closeSpaces, []);
});

test('數字型 live id 不會被轉成字串，因此對不上字串 targetId', () => {
  const plan = planReap({
    spaces: [
      { id: 1, createdAt: '2020-06-01T00:00:00.000Z', pages: { p1: { targetId: '42' } } },
      { id: 2, createdAt: '2020-06-01T00:00:00.000Z', pages: { p1: { targetId: 'T-live' } } },
    ],
    liveTargetIds: [42, 'T-live'],
    now: NOW,
    policy: { reapDeadSpaces: true, idleSpaceMs: 10 ** 15 },
  });
  assert.deepEqual(plan.closeSpaces, [1]);
  assert.equal(plan.stats.live, 1);
});

test('targetId 空字串視為未綁定，不會被當成死亡分頁立刻回收', () => {
  const space = {
    id: 1,
    createdAt: '2020-06-01T00:00:00.000Z',
    pages: { p1: { targetId: '' }, p2: null, p3: 'bad' },
  };
  const info = classifySpace(space, { liveTargets: ['T-live'], now: NOW });
  assert.equal(info.kind, 'unbound');
  assert.equal(info.deadPages.length, 0);
  assert.equal(info.unboundPages.length, 1);

  const plan = planReap({
    spaces: [space],
    liveTargetIds: ['T-live'],
    now: NOW,
    policy: { reapDeadSpaces: true, idleSpaceMs: 10 ** 15 },
  });
  assert.deepEqual(plan.closeSpaces, []);
});

test('protect 傳入單一數字時仍保護該空間，其他死亡空間照常關閉', () => {
  const plan = planReap({
    spaces: [
      { id: 2, createdAt: '2020-06-01T00:00:00.000Z', pages: { p1: { targetId: 'gone-2' } } },
      { id: 3, createdAt: '2020-06-01T00:00:00.000Z', pages: { p1: { targetId: 'gone-3' } } },
    ],
    liveTargetIds: ['T-live'],
    now: NOW,
    protect: 2,
    policy: { reapDeadSpaces: true, idleSpaceMs: 10 ** 15 },
  });
  assert.deepEqual(plan.closeSpaces, [3]);
  assert.equal(plan.stats.protected, 1);
});

test('createdAt 為有限數字時可判定閒置；NaN 與 Infinity 不判定閒置', () => {
  const idle = planReap({
    spaces: [unbound(7, 0)],
    liveTargetIds: ['T-live'],
    now: 30 * 60 * 1000,
    policy: { idleSpaceMs: 30 * 60 * 1000, reapDeadSpaces: false },
  });
  assert.deepEqual(idle.closeSpaces, [7]);

  for (const createdAt of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const plan = planReap({
      spaces: [unbound(7, createdAt)],
      liveTargetIds: ['T-live'],
      now: 10 ** 15,
      policy: { idleSpaceMs: 1, reapDeadSpaces: false },
    });
    assert.deepEqual(plan.closeSpaces, []);
    const info = classifySpace(unbound(7, createdAt), {
      liveTargets: ['T-live'],
      now: 10 ** 15,
      policy: { idleSpaceMs: 1 },
    });
    assert.equal(info.ageMs, null);
    assert.equal(info.idle, false);
  }
});

test('maxSpaces 為 NaN 時不設上限；有限上限仍從最舊的非存活空間回收', () => {
  const spaces = [];
  for (let id = 1; id <= 60; id += 1) {
    spaces.push(unbound(id));
  }
  const open = planReap({
    spaces,
    liveTargetIds: ['T-live'],
    now: NOW,
    policy: { maxSpaces: Number.NaN, idleSpaceMs: 10 ** 15, reapDeadSpaces: false },
  });
  assert.deepEqual(open.closeSpaces, []);

  const capped = planReap({
    spaces,
    liveTargetIds: ['T-live'],
    now: NOW,
    policy: { maxSpaces: 50, idleSpaceMs: 10 ** 15, reapDeadSpaces: false },
  });
  assert.deepEqual(capped.closeSpaces, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(capped.stats.overCap, 10);
});
