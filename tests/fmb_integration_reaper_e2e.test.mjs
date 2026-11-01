// tests/fmb_integration_reaper_e2e.test.mjs — Reaper 端到端情境測試
// （CLI 子程序 × 真實 daemon/store.js × 磁碟 ledger × fmb_feature2/reaper.js）
//
// 情境覆蓋：
//   1. 真實 Store（檔案寫在 mkdtempSync(tmpdir()) 內）→ 匯出 store.list()
//      → 乾跑 CLI（fmb_feature2/cli.js，spawnSync 餵 stdin）→ 解析計畫
//      → applyReapPlan 套用 → 重新載入 Store 驗證磁碟上的 ledger 內容與冪等性。
//   2. 閒置回收（偽造舊 createdAt + 注入 now）。
//   3. live target 集合為空時的安全閥（ledger 原封不動）。
//   4. CLI 錯誤路徑（非法 JSON／空輸入／非物件 payload → 退出碼 2）。
//
// 測試特性：零外部依賴、零網路、零正式服務連線、零真實憑證
// （所有 targetId 一律使用明顯假值 FAKE_VALUE_FOR_TEST 前綴）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Store } from '../daemon/store.js';
import { planReap, applyReapPlan } from '../fmb_feature2/reaper.js';

const CLI = fileURLToPath(new URL('../fmb_feature2/cli.js', import.meta.url));

const runCli = (payload) =>
  spawnSync(process.execPath, [CLI], { input: payload, encoding: 'utf8', timeout: 30_000 });

const withTmpStore = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-integration-reaper-'));
  return fn(join(dir, 'ledger.json')).finally(() => rmSync(dir, { recursive: true, force: true }));
};

test('e2e：Store → CLI 乾跑 → applyReapPlan → 磁碟 ledger 驗證（含冪等性）', () =>
  withTmpStore(async (file) => {
    const store = new Store(file);
    const sA = store.create({ name: 'alpha' });
    store.bindPage(sA.id, 'p1', 'T-live-FAKE_VALUE_FOR_TEST');
    const sB = store.create({ name: 'beta' });
    store.bindPage(sB.id, 'p1', 'T-gone-FAKE_VALUE_FOR_TEST');
    const sC = store.create({ name: 'gamma' }); // p1 未綁定（targetId: null）
    const sD = store.create({ name: 'delta' });
    store.bindPage(sD.id, 'p1', 'T-gone2-FAKE_VALUE_FOR_TEST');
    // Store 沒有 pinned 的寫入 API，依公開資料結構補上後落盤（模擬人工標記保留空間）
    store.data.spaces[sD.id].pinned = true;
    store.persist();

    // 1) 乾跑 CLI：把「真實 ledger 的內容」餵進子程序
    const res = runCli(
      JSON.stringify({ spaces: store.list(), liveTargetIds: ['T-live-FAKE_VALUE_FOR_TEST'] })
    );
    assert.equal(res.status, 0, res.stderr);
    const plan = JSON.parse(res.stdout);
    assert.deepEqual(plan.closeSpaces, [sB.id]); // 只有 dead 空間被回收
    assert.deepEqual(plan.dropPages, []);        // live 空間無失效分頁；pinned/unbound 不動
    assert.equal(plan.stats.examined, 4);
    assert.equal(plan.stats.live, 1);            // alpha
    assert.equal(plan.stats.protected, 1);       // delta（pinned）
    assert.equal(plan.stats.closed, 1);          // beta

    // 2) 套用計畫到真實 Store
    const applied = applyReapPlan(store, plan);
    assert.deepEqual(applied.closedSpaces, [sB.id]);

    // 3) 磁碟驗證：重新載入 Store，B 消失、其餘空間與 pinned 標記完整保留
    const reloaded = new Store(file);
    const ids = reloaded.list().map((s) => s.id).sort((a, b) => a - b);
    assert.deepEqual(ids, [sA.id, sC.id, sD.id]);
    assert.equal(reloaded.get(sA.id).pages.p1.targetId, 'T-live-FAKE_VALUE_FOR_TEST');
    assert.equal(reloaded.get(sD.id).pinned, true);

    // 4) 冪等性：回收後的 ledger 再規劃一次 → 沒有任何新動作
    const plan2 = planReap({
      spaces: reloaded.list(),
      liveTargetIds: ['T-live-FAKE_VALUE_FOR_TEST'],
    });
    assert.deepEqual(plan2.closeSpaces, []);
    assert.deepEqual(plan2.dropPages, []);
  })
);

test('e2e：閒置空間（≥ idleSpaceMs）經 CLI 回收，live 空間保留', () =>
  withTmpStore(async (file) => {
    const store = new Store(file);
    const sA = store.create({ name: 'live-one' });
    store.bindPage(sA.id, 'p1', 'T-live-FAKE_VALUE_FOR_TEST');
    const sC = store.create({ name: 'stale-one' });
    // 偽造 3 小時前建立（Store 無法注入 createdAt，直接改公開欄位後落盤）
    store.data.spaces[sC.id].createdAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    store.persist();

    const res = runCli(
      JSON.stringify({
        spaces: store.list(),
        liveTargetIds: ['T-live-FAKE_VALUE_FOR_TEST'],
        now: Date.now(),
      })
    );
    assert.equal(res.status, 0, res.stderr);
    const plan = JSON.parse(res.stdout);
    assert.deepEqual(plan.closeSpaces, [sC.id]);

    applyReapPlan(store, plan);
    const reloaded = new Store(file);
    assert.equal(reloaded.get(sC.id), null);
    assert.equal(reloaded.get(sA.id).pages.p1.targetId, 'T-live-FAKE_VALUE_FOR_TEST');
  })
);

test('e2e：live 集合為空 → 安全閥啟動，ledger 原封不動', () =>
  withTmpStore(async (file) => {
    const store = new Store(file);
    const sA = store.create({ name: 'dead-ish' });
    store.bindPage(sA.id, 'p1', 'T-gone-FAKE_VALUE_FOR_TEST');
    const before = new Store(file).list();

    const res = runCli(JSON.stringify({ spaces: store.list(), liveTargetIds: [] }));
    assert.equal(res.status, 0, res.stderr);
    const plan = JSON.parse(res.stdout);
    assert.equal(plan.reason, 'no-live-targets');
    assert.deepEqual(plan.closeSpaces, []);
    assert.deepEqual(plan.dropPages, []);

    applyReapPlan(store, plan);
    assert.deepEqual(new Store(file).list(), before);
  })
);

test('e2e：CLI 錯誤路徑（非法 JSON／空輸入／非物件 payload → 退出碼 2）', () => {
  const bad = runCli('this is not json');
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /invalid JSON input/);

  const empty = runCli('   ');
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /usage:/);

  const arr = runCli('[1,2,3]');
  assert.equal(arr.status, 2);
  assert.match(arr.stderr, /payload must be a JSON object/);
});
