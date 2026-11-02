// policy.maxSpaces 設為 null 時必須表示「不設上限」。
// Number(null) === 0 會把上限當成 0，只要 live targets 已知，
// 所有非存活、非受保護的空間（含剛建立、尚未閒置的佔位空間）都會被回收。
import test from 'node:test';
import assert from 'node:assert/strict';
import { planReap } from '../fmb_feature2/reaper.js';
import { buildPlan } from '../fmb_feature2/cli.js';

const NOW = Date.parse('2026-01-01T12:00:00.000Z');
const CREATED = '2026-01-01T11:59:00.000Z';

function freshUnbound(id) {
  return {
    id,
    name: `space-${id}`,
    createdAt: CREATED,
    pages: { p1: { targetId: null } },
  };
}

test('maxSpaces null 表示不設上限，不得把未閒置佔位空間全部回收', () => {
  const spaces = [];
  for (let id = 1; id <= 51; id += 1) spaces.push(freshUnbound(id));
  spaces.push({
    id: 52,
    name: 'live',
    createdAt: CREATED,
    pages: { p1: { targetId: 'T-live' } },
  });

  const plan = planReap({
    spaces,
    liveTargetIds: ['T-live'],
    now: NOW,
    policy: { maxSpaces: null },
  });
  assert.deepEqual(plan.closeSpaces, []);
  assert.equal(plan.stats.overCap, 0);
  assert.equal(plan.stats.closed, 0);
  assert.equal(plan.stats.live, 1);
  assert.equal(plan.stats.examined, 52);

  const viaCli = buildPlan(JSON.stringify({
    spaces,
    liveTargetIds: ['T-live'],
    now: NOW,
    policy: { maxSpaces: null },
  }));
  assert.deepEqual(viaCli.closeSpaces, []);
  assert.equal(viaCli.stats.overCap, 0);

  // 超過預設 50 仍須全部保留，null 不是「改回預設 50」。
  assert.equal(spaces.length, 52);

  const zeroCap = planReap({
    spaces: [freshUnbound(1)],
    liveTargetIds: ['T-live'],
    now: NOW,
    policy: { maxSpaces: 0 },
  });
  assert.deepEqual(zeroCap.closeSpaces, [1]);
  assert.equal(zeroCap.stats.overCap, 1);
});
