// Boundary / error-path characterization for fmb_feature2/cli.js buildPlan().
// Stdin/exit-code coverage stays in fmb_feature2/cli.test.js. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan } from '../fmb_feature2/cli.js';

function ancientUnbound(now, policy = {}) {
  return JSON.stringify({
    now,
    liveTargetIds: ['sentinel'],
    policy: { idleSpaceMs: 5000, reapDeadSpaces: false, maxSpaces: 50, ...policy },
    spaces: [{
      id: 7,
      createdAt: '1970-01-01T00:00:01.000Z',
      pages: { p1: { targetId: null } },
    }],
  });
}

test('非法 JSON 被包成一般 Error，不把 SyntaxError 往外丟', () => {
  for (const input of ['', '   ', '{', '\uFEFF{}']) {
    assert.throws(() => buildPlan(input), (err) => {
      assert.equal(err instanceof SyntaxError, false);
      assert.match(err.message, /^invalid JSON input: /);
      return true;
    });
  }
});

test('null、陣列、純量都不是合法 payload', () => {
  for (const input of ['null', '[]', 'true', '0', '"FAKE_VALUE_FOR_TEST"']) {
    assert.throws(() => buildPlan(input), { message: 'payload must be a JSON object' });
  }
  assert.throws(() => buildPlan(null), (err) => /^invalid JSON input: /.test(err.message));
  assert.throws(() => buildPlan(undefined), (err) => /^invalid JSON input: /.test(err.message));
  assert.throws(() => buildPlan(0), { message: 'payload must be a JSON object' });
});

test('空物件與 null 欄位走空計畫，不丟例外', () => {
  const empty = buildPlan('{}');
  assert.equal(empty.reason, 'no-live-targets');
  assert.deepEqual(empty.closeSpaces, []);

  const padded = buildPlan('  {"liveTargetIds":[]}  ');
  assert.equal(padded.reason, 'no-live-targets');

  const nulled = buildPlan(JSON.stringify({
    policy: null,
    protect: null,
    spaces: null,
    liveTargetIds: null,
    now: null,
  }));
  assert.equal(nulled.reason, 'no-live-targets');
  assert.equal(nulled.stats.examined, 0);
});

test('now 為 0 與負數會原樣採用，數字字串則改走現在時間', () => {
  assert.deepEqual(buildPlan(ancientUnbound(0)).closeSpaces, []);
  assert.deepEqual(buildPlan(ancientUnbound(-1)).closeSpaces, []);
  assert.deepEqual(buildPlan(ancientUnbound(5999)).closeSpaces, []);
  assert.deepEqual(buildPlan(ancientUnbound(6000)).closeSpaces, [7]);
  assert.deepEqual(buildPlan(ancientUnbound('0')).closeSpaces, [7]);
  assert.deepEqual(buildPlan(ancientUnbound(true)).closeSpaces, [7]);
});

test('liveTargetIds 傳單一字串時不會被包成陣列，死空間因此完全不回收', () => {
  const plan = buildPlan(JSON.stringify({
    liveTargetIds: 'T-live',
    now: 0,
    spaces: [{ id: 1, createdAt: '2020-01-01T00:00:00.000Z', pages: { p1: { targetId: 'T-gone' } } }],
  }));
  assert.equal(plan.reason, 'no-live-targets');
  assert.deepEqual(plan.closeSpaces, []);
});

test('protect 傳單一字串會保護該 id；policy 傳陣列則沿用預設並仍回收死空間', () => {
  const protectedPlan = buildPlan(JSON.stringify({
    protect: '1',
    now: 0,
    liveTargetIds: ['ok'],
    spaces: [{ id: 1, createdAt: '2020-01-01T00:00:00.000Z', pages: { p1: { targetId: 'gone' } } }],
  }));
  assert.deepEqual(protectedPlan.closeSpaces, []);
  assert.equal(protectedPlan.stats.protected, 1);

  const defaults = buildPlan(JSON.stringify({
    policy: [],
    now: 0,
    liveTargetIds: ['ok'],
    spaces: [{ id: 3, createdAt: '2020-01-01T00:00:00.000Z', pages: { p1: { targetId: 'gone' } } }],
  }));
  assert.deepEqual(defaults.closeSpaces, [3]);
});

test('payload 上的 __proto__ 不會污染 Object.prototype，結果可再 JSON 序列化', () => {
  const plan = buildPlan('{"__proto__":{"polluted":true},"spaces":[],"liveTargetIds":["a"],"now":0}');
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(plan.reason, undefined);
  assert.equal(plan.stats.examined, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan);
});

test('多餘欄位與非物件的垃圾空間項不會讓 buildPlan 丟例外', () => {
  const plan = buildPlan(JSON.stringify({
    note: 'FAKE_VALUE_FOR_TEST',
    now: 0,
    liveTargetIds: ['ok'],
    spaces: [1, null, { id: 4, createdAt: '2026-01-01T00:00:00.000Z', pages: { p1: { targetId: 'ok' } } }],
  }));
  assert.equal(plan.stats.skipped, 2);
  assert.equal(plan.stats.live, 1);
  assert.deepEqual(plan.closeSpaces, []);
  assert.equal(plan.note, undefined);
});
