// fmb_feature2/store-integration.test.js — 與真實 `daemon/store.js` 的整合測試。
// 只使用作業系統暫存目錄（mkdtempSync(tmpdir())），不讀寫 repo 以外的既定路徑。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../daemon/store.js';
import { applyReapPlan, planReap } from './reaper.js';

const dir = mkdtempSync(join(tmpdir(), 'fmb2-reaper-'));
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('與真實 Store 整合：回收 dead/idle 空間並保留 live 空間', () => {
  const ledgerPath = join(dir, 'ledger-integration.json');
  const store = new Store(ledgerPath);

  const live = store.create({ name: 'live-space' });
  store.bindPage(live.id, 'p1', 'target-live');
  store.setPage(live.id, 'p1', { url: 'https://example.test/live', title: 'LIVE' });

  const dead = store.create({ name: 'dead-space' });
  store.bindPage(dead.id, 'p1', 'target-gone');

  const idle = store.create({ name: 'idle-space' });
  store.get(idle.id).createdAt = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();

  const plan = planReap({ spaces: store.list(), liveTargetIds: ['target-live'] });
  assert.deepEqual(plan.closeSpaces, [dead.id, idle.id]);
  assert.deepEqual(plan.dropPages, []);

  const result = applyReapPlan(store, plan);
  assert.deepEqual(result.closedSpaces, [dead.id, idle.id]);
  assert.equal(store.get(dead.id), null);
  assert.equal(store.get(idle.id), null);
  assert.equal(store.get(live.id).pages.p1.url, 'https://example.test/live');

  const onDisk = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  assert.equal(onDisk.spaces[dead.id], undefined);
  assert.equal(onDisk.spaces[idle.id], undefined);
  assert.equal(onDisk.spaces[live.id].pages.p1.targetId, 'target-live');

  // 冪等：同一份 live 集合再跑一次不會再產生任何動作。
  const again = planReap({ spaces: store.list(), liveTargetIds: ['target-live'] });
  assert.deepEqual(again.closeSpaces, []);
  assert.deepEqual(again.dropPages, []);
});

test('與真實 Store 整合：未接上 Chrome（空 live 集合）時 ledger 原封不動', () => {
  const ledgerPath = join(dir, 'ledger-offline.json');
  const store = new Store(ledgerPath);
  const s = store.create({ name: 'keep-me' });
  store.bindPage(s.id, 'p1', 'target-unknown');
  const before = JSON.stringify(store.list());

  const plan = planReap({ spaces: store.list(), liveTargetIds: [] });
  assert.equal(plan.reason, 'no-live-targets');
  applyReapPlan(store, plan);

  assert.equal(store.get(s.id)?.pages.p1.targetId, 'target-unknown');
  assert.equal(JSON.stringify(store.list()), before);
});
