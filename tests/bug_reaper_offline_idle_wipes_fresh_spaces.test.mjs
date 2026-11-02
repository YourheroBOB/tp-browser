// 空的 liveTargetIds 代表「還沒有存活快照」（Chrome 未接上、/json/list 為空）。
// reapIdleWhenNoLiveTargets 只應放行閒置回收；修正前會把剛綁定 target 的空間
// 當成全部已死而關閉、丟掉分頁，或拿去填 maxSpaces。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan } from '../fmb_feature2/cli.js';
import { planReap } from '../fmb_feature2/reaper.js';

const NOW = Date.parse('2026-01-01T12:00:00.000Z');

test('buildPlan：離線閒置旗標不得關閉剛綁定 target 的空間，閒置未綁定空間仍回收', () => {
  const fresh = buildPlan(JSON.stringify({
    spaces: [
      {
        id: 1,
        createdAt: '2026-01-01T12:00:00.000Z',
        pages: { p1: { targetId: 'T-page-FAKE_VALUE_FOR_TEST' } },
      },
    ],
    liveTargetIds: [],
    now: NOW,
    policy: { reapIdleWhenNoLiveTargets: true },
  }));
  assert.deepEqual(fresh.closeSpaces, []);
  assert.deepEqual(fresh.dropPages, []);
  assert.equal(fresh.stats.closed, 0);
  assert.equal(fresh.stats.pagesDropped, 0);

  const idle = buildPlan(JSON.stringify({
    spaces: [
      {
        id: 2,
        createdAt: '2026-01-01T10:00:00.000Z',
        pages: { p1: { targetId: null } },
      },
    ],
    liveTargetIds: [],
    now: NOW,
    policy: { reapIdleWhenNoLiveTargets: true },
  }));
  assert.deepEqual(idle.closeSpaces, [2]);
});

test('離線閒置模式不會丟掉無法確認已死的分頁，也不會誤報 staleActiveTargets', () => {
  const plan = planReap({
    spaces: [
      {
        id: 4,
        name: 'fresh-bound',
        createdAt: '2026-01-01T12:00:00.000Z',
        activeTargetId: 'T-keep-FAKE_VALUE_FOR_TEST',
        pages: {
          p1: { targetId: 'T-keep-FAKE_VALUE_FOR_TEST' },
          p2: { targetId: 'T-also-FAKE_VALUE_FOR_TEST' },
        },
      },
    ],
    liveTargetIds: [],
    now: NOW,
    policy: { reapIdleWhenNoLiveTargets: true, reapDeadSpaces: false },
  });

  assert.deepEqual(plan.dropPages, []);
  assert.deepEqual(plan.staleActiveTargets, []);
  assert.deepEqual(plan.closeSpaces, []);
  assert.equal(plan.stats.pagesDropped, 0);
  assert.equal(plan.stats.staleActiveTargets, 0);
});

test('離線閒置模式不會用 maxSpaces 犧牲只是看起來已死的新空間', () => {
  const plan = planReap({
    spaces: [
      {
        id: 1,
        createdAt: '2026-01-01T11:50:00.000Z',
        pages: { p1: { targetId: 'T-a-FAKE_VALUE_FOR_TEST' } },
      },
      {
        id: 2,
        createdAt: '2026-01-01T11:55:00.000Z',
        pages: { p1: { targetId: 'T-b-FAKE_VALUE_FOR_TEST' } },
      },
    ],
    liveTargetIds: [],
    now: NOW,
    policy: {
      reapIdleWhenNoLiveTargets: true,
      reapDeadSpaces: false,
      dropDeadPages: false,
      maxSpaces: 1,
      idleSpaceMs: 30 * 60 * 1000,
    },
  });

  assert.deepEqual(plan.closeSpaces, []);
  assert.deepEqual(plan.dropPages, []);
  assert.equal(plan.stats.overCap, 0);
});
