// tests/test_fmb_contract_cli.test.mjs
// fmb_feature2/cli.js 的「程式庫介面」契約：只鎖 buildPlan 的匯出、簽名、回傳結構與錯誤訊息格式。
// CLI 子程序層（stdout / exit code）已由 fmb_feature2/cli.test.js 覆蓋，此處不重複。
// 零依賴、零網路、不讀寫任何檔案。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as cliMod from '../fmb_feature2/cli.js';
import { buildPlan } from '../fmb_feature2/cli.js';

test('contract/cli：唯一匯出是 buildPlan（arity 1 函式）', () => {
  assert.deepEqual(Object.keys(cliMod).sort(), ['buildPlan']);
  assert.equal(typeof buildPlan, 'function');
  assert.equal(buildPlan.length, 1);
});

test('contract/cli：buildPlan 回傳 planReap 結構（四鍵集合）', () => {
  const plan = buildPlan(JSON.stringify({
    spaces: [{ id: 2, createdAt: '2026-01-01T00:00:00.000Z', pages: { p1: { targetId: 'T-gone' } } }],
    liveTargetIds: ['T-live'],
  }));
  assert.deepEqual(Object.keys(plan).sort(), ['closeSpaces', 'dropPages', 'staleActiveTargets', 'stats']);
});

test('contract/cli：buildPlan 錯誤契約（Error、訊息格式固定）', () => {
  assert.throws(() => buildPlan('not json'), (e) => e instanceof Error && /^invalid JSON input: /.test(e.message));
  assert.throws(() => buildPlan('[]'), (e) => e instanceof Error && e.message === 'payload must be a JSON object');
  assert.throws(() => buildPlan('null'), (e) => e instanceof Error && e.message === 'payload must be a JSON object');
});
