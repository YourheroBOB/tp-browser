// tests/test_fmb_cli_dryrun_plan.test.mjs
// fmb_feature2/cli.js 的行程內（in-process）測試：直接呼叫匯出的 buildPlan()，
// 補足既有以 spawnSync 餵 stdin 的子程序測試沒涵蓋的輸入驗證與參數透傳。
// 全程不連網、不讀寫任何檔案、不需要凭證。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan } from '../fmb_feature2/cli.js';

const NOW = Date.parse('2026-01-01T12:00:00.000Z');

test('buildPlan：非法 JSON 與非物件 payload 都丟出可讀錯誤', () => {
  assert.throws(() => buildPlan('not json'), /invalid JSON input/);
  assert.throws(() => buildPlan(''), /invalid JSON input/);
  assert.throws(() => buildPlan(undefined), /invalid JSON input/);
  assert.throws(() => buildPlan('[]'), /payload must be a JSON object/);
  assert.throws(() => buildPlan('null'), /payload must be a JSON object/);
  assert.throws(() => buildPlan(42), /payload must be a JSON object/);
});

test('buildPlan：live 集合為空時走安全閥，完全不做回收', () => {
  const plan = buildPlan('{}');
  assert.equal(plan.reason, 'no-live-targets');
  assert.deepEqual(plan.closeSpaces, []);
  assert.deepEqual(plan.dropPages, []);
  assert.deepEqual(plan.staleActiveTargets, []);
  assert.equal(plan.stats.examined, 0);
});

test('buildPlan：spaces 非陣列時回報 invalid-input 而不是崩潰', () => {
  const plan = buildPlan(JSON.stringify({ spaces: { 1: {} }, liveTargetIds: ['T-live'] }));
  assert.equal(plan.reason, 'invalid-input');
  assert.deepEqual(plan.closeSpaces, []);
  assert.deepEqual(plan.dropPages, []);
});

test('buildPlan：now 會透傳，決定空間是否達閒置門檻', () => {
  const payload = (now) =>
    JSON.stringify({
      spaces: [
        { id: 1, createdAt: '2026-01-01T11:00:00.000Z', pages: { p1: { targetId: 'T-gone' } } },
      ],
      liveTargetIds: ['T-live'],
      now,
      policy: { idleSpaceMs: 30 * 60 * 1000, reapDeadSpaces: false },
    });

  const idle = buildPlan(payload(NOW)); // 已閒置 1 小時 > 30 分鐘
  assert.deepEqual(idle.closeSpaces, [1]);

  const fresh = buildPlan(payload(Date.parse('2026-01-01T11:10:00.000Z'))); // 只經過 10 分鐘
  assert.deepEqual(fresh.closeSpaces, []);

  // now 非數字時退回 Date.now()，只驗證不拋錯（不依賴真實時鐘）
  assert.doesNotThrow(() => buildPlan(payload('2026-01-01T12:00:00.000Z')));
});

test('buildPlan：policy 與 protect 原樣透傳給 planReap', () => {
  const input = JSON.stringify({
    spaces: [
      { id: 1, createdAt: '2020-01-01T00:00:00.000Z', pages: { p1: { targetId: 'T-gone-1' } } },
      { id: 2, createdAt: '2020-01-01T00:00:00.000Z', pages: { p1: { targetId: 'T-gone-2' } } },
      { id: 3, createdAt: '2020-01-01T00:00:00.000Z', pages: { p1: { targetId: 'T-live' } } },
    ],
    liveTargetIds: ['T-live'],
    now: NOW,
    protect: [1],
    policy: { idleSpaceMs: 60 * 1000, maxSpaces: 2 },
  });

  const plan = buildPlan(input);
  assert.deepEqual(plan.closeSpaces, [2]); // 1 受保護、2 已死、3 存活
  assert.equal(plan.stats.examined, 3);
  assert.equal(plan.stats.protected, 1);
  assert.equal(plan.stats.live, 1);
  assert.deepEqual(plan.staleActiveTargets, []);
});

test('buildPlan：maxSpaces 只犧牲非存活、非受保護的空間', () => {
  const spaces = [
    { id: 1, createdAt: '2026-01-01T11:59:00.000Z', pages: { p1: { targetId: null } } },
    { id: 2, createdAt: '2026-01-01T11:59:30.000Z', pages: { p1: { targetId: null } } },
    { id: 3, createdAt: '2026-01-01T11:59:45.000Z', pages: { p1: { targetId: 'T-live' } } },
  ];

  const plan = buildPlan(JSON.stringify({ spaces, liveTargetIds: ['T-live'], now: NOW, policy: { maxSpaces: 2 } }));
  assert.deepEqual(plan.closeSpaces, [1]); // 由最舊的未綁定空間先回收
  assert.equal(plan.stats.overCap, 1);
  assert.equal(plan.stats.live, 1);

  const keepLive = buildPlan(
    JSON.stringify({
      spaces: [{ id: 7, createdAt: '2026-01-01T11:59:00.000Z', pages: { p1: { targetId: 'T-live' } } }],
      liveTargetIds: ['T-live'],
      now: NOW,
      policy: { maxSpaces: 0 },
    }),
  );
  assert.deepEqual(keepLive.closeSpaces, []); // 存活空間永不因上限被犧牲
  assert.equal(keepLive.stats.overCap, 0);
});

test('buildPlan：存活空間的失效 activeTargetId 只做診斷回報', () => {
  const plan = buildPlan(
    JSON.stringify({
      spaces: [
        {
          id: 5,
          createdAt: '2026-01-01T11:59:00.000Z',
          activeTargetId: 'T-gone',
          pages: { p1: { targetId: 'T-live' } },
        },
      ],
      liveTargetIds: ['T-live'],
      now: NOW,
    }),
  );

  assert.deepEqual(plan.closeSpaces, []);
  assert.deepEqual(plan.dropPages, []);
  assert.deepEqual(plan.staleActiveTargets, [{ spaceId: 5, targetId: 'T-gone' }]);
  assert.equal(plan.stats.staleActiveTargets, 1);
});
