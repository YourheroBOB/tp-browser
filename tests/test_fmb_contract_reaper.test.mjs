// tests/test_fmb_contract_reaper.test.mjs
// fmb_feature2/reaper.js 公開介面「契約測試」：鎖匯出面、DEFAULT_POLICY 凍結與預設值、
// planReap/classifySpace/applyReapPlan 的回傳鍵集合、reason 字串與安全 no-op。
// 不重複 fmb_feature2/reaper.test.js 的行為測試。零網路、零檔案系統存取、零依賴。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as reaper from '../fmb_feature2/reaper.js';
import { DEFAULT_POLICY, classifySpace, planReap, applyReapPlan, toTargetSet, pageEntries } from '../fmb_feature2/reaper.js';

test('contract/reaper：模組匯出面 exactly 六個符號', () => {
  assert.deepEqual(Object.keys(reaper).sort(), [
    'DEFAULT_POLICY', 'applyReapPlan', 'classifySpace', 'pageEntries', 'planReap', 'toTargetSet',
  ]);
});

test('contract/reaper：DEFAULT_POLICY 為凍結物件，鍵集合與預設值固定', () => {
  assert.equal(Object.isFrozen(DEFAULT_POLICY), true);
  assert.deepEqual(Object.keys(DEFAULT_POLICY).sort(), [
    'dropDeadPages', 'idleSpaceMs', 'maxSpaces', 'reapDeadSpaces', 'reapIdleWhenNoLiveTargets',
  ]);
  assert.deepEqual({ ...DEFAULT_POLICY }, {
    idleSpaceMs: 30 * 60 * 1000,
    maxSpaces: 50,
    reapDeadSpaces: true,
    dropDeadPages: true,
    reapIdleWhenNoLiveTargets: false,
  });
});

test('contract/reaper：planReap 成功路徑回傳鍵集合（closeSpaces/dropPages/staleActiveTargets/stats）', () => {
  const plan = planReap({
    spaces: [{ id: 1, createdAt: '2026-01-01T00:00:00.000Z', pages: { p1: { targetId: 'T-live' } } }],
    liveTargetIds: ['T-live'],
    now: Date.parse('2026-01-01T01:00:00.000Z'),
  });
  assert.deepEqual(Object.keys(plan).sort(), ['closeSpaces', 'dropPages', 'staleActiveTargets', 'stats']);
  assert.ok(Array.isArray(plan.closeSpaces));
  assert.ok(Array.isArray(plan.dropPages));
  assert.ok(Array.isArray(plan.staleActiveTargets));
  assert.deepEqual(Object.keys(plan.stats).sort(), [
    'closed', 'examined', 'live', 'overCap', 'pagesDropped', 'protected', 'skipped', 'staleActiveTargets',
  ]);
});

test('contract/reaper：安全閥 reason 契約 — live 集合為空 → "no-live-targets" 且三個清單皆空', () => {
  const plan = planReap({
    spaces: [{ id: 7, createdAt: '2000-01-01T00:00:00.000Z', pages: { p1: { targetId: 'T-gone' } } }],
    liveTargetIds: [],
  });
  assert.equal(plan.reason, 'no-live-targets');
  assert.deepEqual(plan.closeSpaces, []);
  assert.deepEqual(plan.dropPages, []);
  assert.deepEqual(plan.staleActiveTargets, []);
});

test('contract/reaper：非法輸入 reason 契約 — spaces 非 Array → "invalid-input"', () => {
  const plan = planReap({ spaces: 'nope', liveTargetIds: ['T'] });
  assert.equal(plan.reason, 'invalid-input');
  assert.deepEqual(plan.closeSpaces, []);
  assert.deepEqual(plan.dropPages, []);
});

test('contract/reaper：classifySpace 回傳鍵集合 { ageMs, deadPages, entries, idle, kind, livePages, unboundPages }', () => {
  const info = classifySpace(
    {
      id: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      pages: { p1: { targetId: 'T-live' }, p2: { targetId: 'T-x' }, p3: { targetId: null } },
    },
    { liveTargets: ['T-live'], now: Date.parse('2026-01-01T00:31:00.000Z') },
  );
  assert.deepEqual(Object.keys(info).sort(), ['ageMs', 'deadPages', 'entries', 'idle', 'kind', 'livePages', 'unboundPages']);
  assert.equal(info.kind, 'live');
  assert.equal(info.ageMs, 31 * 60 * 1000);
  assert.equal(info.idle, true);
});

test('contract/reaper：toTargetSet 正規化契約（Set/Array → 只留非空字串；其他 → 空 Set）', () => {
  assert.ok(toTargetSet(['a']) instanceof Set);
  assert.deepEqual([...toTargetSet(['a', 'a', '', 1, null])], ['a']);
  assert.deepEqual([...toTargetSet(new Set(['b', '']))], ['b']);
  assert.deepEqual([...toTargetSet('nope')], []);
  assert.deepEqual([...toTargetSet(null)], []);
});

test('contract/reaper：pageEntries 攤平契約（略過非物件 page；空 targetId 正規化為 null）', () => {
  const entries = pageEntries({ pages: { p1: { targetId: 'T' }, p2: null, p3: 'junk', p4: { targetId: '' } } });
  assert.deepEqual(entries, [
    { label: 'p1', page: { targetId: 'T' }, targetId: 'T' },
    { label: 'p4', page: { targetId: '' }, targetId: null },
  ]);
});

test('contract/reaper：applyReapPlan 回傳鍵集合 { closedSpaces, droppedPages }；缺方法的 store 為安全 no-op', () => {
  assert.deepEqual(Object.keys(applyReapPlan({}, {})).sort(), ['closedSpaces', 'droppedPages']);
  assert.deepEqual(
    applyReapPlan({}, { closeSpaces: [1], dropPages: [{ spaceId: 1, label: 'p1' }] }),
    { closedSpaces: [], droppedPages: [] },
  );
});
