// buildPlan 的異常 JSON 與型別邊界。不啟動行程、不寫檔、不連線。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan } from '../fmb_feature2/cli.js';

describe('buildPlan 拒絕壞輸入', () => {
  test('空字串、空白與非法 JSON 丟出 invalid JSON', () => {
    for (const raw of ['', '   ', '\n', '{', undefined]) {
      assert.throws(() => buildPlan(raw), /invalid JSON input:/);
    }
  });

  test('JSON 陣列、null、數字、字串、布林都不是計畫物件', () => {
    for (const raw of ['null', '[]', '1', '"x"', 'true']) {
      assert.throws(() => buildPlan(raw), /payload must be a JSON object/);
    }
    assert.throws(() => buildPlan(123), /payload must be a JSON object/);
  });
});

describe('buildPlan 欄位預設與型別', () => {
  test('省略 liveTargetIds 不會在空集合下回收', () => {
    const plan = buildPlan(JSON.stringify({
      spaces: [{
        id: 1,
        createdAt: '2000-01-01T00:00:00.000Z',
        pages: { p1: { targetId: 'GONE' } },
      }],
    }));
    assert.equal(plan.reason, 'no-live-targets');
    assert.deepEqual(plan.closeSpaces, []);
  });

  test('spaces 與 liveTargetIds 為 null 時當成空陣列', () => {
    const plan = buildPlan('{"spaces":null,"liveTargetIds":null}');
    assert.equal(plan.reason, 'no-live-targets');
    assert.equal(plan.stats.examined, 0);
    assert.deepEqual(plan.closeSpaces, []);
  });

  test('spaces 是字串時回 invalid-input，不丟例外', () => {
    const plan = buildPlan(JSON.stringify({ spaces: 'nope', liveTargetIds: ['LIVE'] }));
    assert.equal(plan.reason, 'invalid-input');
    assert.deepEqual(plan.closeSpaces, []);
    assert.equal(plan.stats.examined, 0);
    assert.equal(plan.stats.skipped, 0);
  });

  test('裸字串 liveTargetIds 不會被當成單一 target', () => {
    const plan = buildPlan(JSON.stringify({
      spaces: [{ id: 1, createdAt: '2026-06-01T00:00:00.000Z', pages: { p1: { targetId: 'LIVE' } } }],
      liveTargetIds: 'LIVE',
      now: Date.parse('2026-06-01T00:00:00.000Z'),
    }));
    assert.equal(plan.reason, 'no-live-targets');
    assert.deepEqual(plan.closeSpaces, []);
  });

  test('now 為 0 仍是有效時間', () => {
    const plan = buildPlan(JSON.stringify({
      now: 0,
      liveTargetIds: ['LIVE'],
      spaces: [{ id: 1, createdAt: 0, pages: { p1: { targetId: null } } }],
    }));
    assert.deepEqual(plan.closeSpaces, []);
  });

  test('now 不是 number 時不採用該值', () => {
    const ancient = '2000-01-01T00:00:00.000Z';
    const now = Date.parse(ancient);
    assert.ok(Date.now() > now + 30 * 60 * 1000);
    const body = {
      liveTargetIds: ['LIVE'],
      spaces: [{ id: 1, createdAt: ancient, pages: { p1: { targetId: null } } }],
    };
    const numeric = buildPlan(JSON.stringify({ ...body, now }));
    assert.deepEqual(numeric.closeSpaces, []);
    for (const badNow of [String(now), null]) {
      const plan = buildPlan(JSON.stringify({ ...body, now: badNow }));
      assert.deepEqual(plan.closeSpaces, [1], String(badNow));
    }
  });

  test('policy 不是一般物件時沿用預設，protect 物件不會保護 id', () => {
    const now = Date.parse('2026-06-01T00:00:00.000Z');
    const freshDead = {
      id: 1,
      createdAt: '2026-06-01T00:00:00.000Z',
      pages: { p1: { targetId: 'GONE' } },
    };
    const policyArray = buildPlan(JSON.stringify({
      now,
      liveTargetIds: ['LIVE'],
      policy: [],
      spaces: [freshDead],
    }));
    assert.deepEqual(policyArray.closeSpaces, [1]);

    const protectObject = buildPlan(JSON.stringify({
      now,
      liveTargetIds: ['LIVE'],
      protect: { 1: true },
      spaces: [freshDead],
    }));
    assert.deepEqual(protectObject.closeSpaces, [1]);
  });

  test('未知欄位與跳過的項目不影響合法空間', () => {
    const now = Date.parse('2026-06-01T00:00:00.000Z');
    const plan = buildPlan(JSON.stringify({
      now,
      liveTargetIds: ['LIVE'],
      protect: [],
      policy: { idleSpaceMs: 0 },
      ignored: { token: 'FAKE_VALUE_FOR_TEST' },
      spaces: [
        null,
        { id: 1, createdAt: '2026-06-01T00:00:00.000Z', pages: { p1: { targetId: null } } },
        { id: 2, createdAt: '2026-06-01T00:00:00.000Z', pages: { p1: { targetId: 'LIVE' } } },
      ],
    }));
    assert.equal(plan.reason, undefined);
    assert.deepEqual(plan.closeSpaces, [1]);
    assert.equal(plan.stats.skipped, 1);
    assert.equal(plan.stats.live, 1);
  });
});
