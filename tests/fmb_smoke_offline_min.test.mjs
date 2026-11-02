// 純函式／ledger 的最小離線輸入。不連網、不寫 repo，暫存只在 tmpdir。
// 不重跑既有 keys／cdp／reaper 行為矩陣，只確認進入點對空輸入有定義清楚的回應。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../daemon/store.js';
import { applyReapPlan, planReap } from '../fmb_feature2/reaper.js';
import { buildPlan } from '../fmb_feature2/cli.js';

test('Store 空 ledger 最小讀取', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-smoke-store-'));
  try {
    const store = new Store(join(dir, 'ledger.json'));
    assert.equal(store.data.nextSpaceId, 1);
    assert.deepEqual(store.data.labelSeq, {});
    assert.deepEqual(store.list(), []);
    assert.equal(store.get(1), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('planReap 空 live 與非法輸入不動作', () => {
  const empty = planReap({ spaces: [], liveTargetIds: [], now: 0 });
  assert.equal(empty.reason, 'no-live-targets');
  assert.deepEqual(empty.closeSpaces, []);
  assert.deepEqual(empty.dropPages, []);
  const bad = planReap({ spaces: null, liveTargetIds: ['smoke-target'] });
  assert.equal(bad.reason, 'invalid-input');
  assert.deepEqual(bad.closeSpaces, []);
  assert.deepEqual(applyReapPlan({}, empty), { closedSpaces: [], droppedPages: [] });
});

test('buildPlan 最小 JSON 保留未綁定新空間', () => {
  const plan = buildPlan(JSON.stringify({
    spaces: [{
      id: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      pages: { p1: { targetId: null } },
    }],
    liveTargetIds: ['smoke-target'],
    now: Date.parse('2026-01-01T00:00:00.000Z'),
  }));
  assert.ok(plan);
  assert.deepEqual(plan.closeSpaces, []);
  assert.deepEqual(plan.dropPages, []);
  assert.equal(plan.stats.examined, 1);
  assert.equal(plan.stats.closed, 0);
  assert.throws(() => buildPlan('not-json'), /invalid JSON input/);
});
