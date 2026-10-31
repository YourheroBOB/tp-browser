// tests/test_fmb_edge_cli_plan.test.mjs
// 邊界與錯誤情境：fmb_feature2/cli.js 的 buildPlan() 輸入驗證。
// 只測試純函式（不 spawn 子程序、不讀 stdin、不寫任何檔案、不連線）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan } from '../fmb_feature2/cli.js';

test('buildPlan：非物件 payload（null／陣列／字串／數字／布林）一律拒絕', () => {
  for (const payload of ['null', '[]', '[1,2]', '"text"', '42', 'true']) {
    assert.throws(() => buildPlan(payload), /payload must be a JSON object/, `payload=${payload}`);
  }
});

test('buildPlan：非 JSON 與缺值都給出可判斷的錯誤訊息', () => {
  assert.throws(() => buildPlan(''), /invalid JSON input/);
  assert.throws(() => buildPlan(undefined), /invalid JSON input/);
  assert.throws(() => buildPlan('{"spaces": [}'), /invalid JSON input/);
  assert.throws(() => buildPlan('not json at all'), /invalid JSON input/);
});

test('buildPlan：缺 spaces／liveTargetIds 時安全回傳 no-live-targets，不做任何刪除', () => {
  const plan = buildPlan('{}');
  assert.equal(plan.reason, 'no-live-targets');
  assert.deepEqual(plan.closeSpaces, []);
  assert.deepEqual(plan.dropPages, []);
  assert.deepEqual(plan.staleActiveTargets, []);
  assert.equal(plan.stats.examined, 0);
  assert.equal(plan.stats.closed, 0);

  // 明確給 null 也應落到同一個安全閥，而不是丟錯。
  const withNulls = buildPlan(JSON.stringify({ spaces: null, liveTargetIds: null }));
  assert.equal(withNulls.reason, 'no-live-targets');
  assert.deepEqual(withNulls.closeSpaces, []);
  assert.deepEqual(withNulls.dropPages, []);
});
