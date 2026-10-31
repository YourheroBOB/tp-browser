// tests/fmb_integration_store_lifecycle.test.mjs — daemon/store.js 檔案 I/O 生命週期整合測試
//
// 覆蓋：
//   - persist() 自動建立巢狀目錄並寫出可解析的 JSON
//   - 完整操作流程（create/bindPage/nextLabel/addPage/setPage）落盤
//   - 「重啟」（新 Store 執行個體讀同一檔案）後資料與 labelSeq 延續
//   - 錯誤路徑：未知空間的 bindPage/addPage 拋出、removePage 對未知空間為 no-op
//   - 損毀 JSON 的復原路徑（不拋出、以全新狀態啟動、可繼續寫入）
//   - removePage / deleteSpace 持久化到磁碟
//
// 測試特性：所有檔案讀寫僅發生在 mkdtempSync(tmpdir()) 內；零網路、零真實憑證。
// 注意：損毀 JSON 測試會觸發 store 的 console.error（既有行為），屬預期噪音。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../daemon/store.js';

const withTmp = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-integration-store-'));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
};

test('store：persist 自動建立巢狀目錄並寫出可解析 JSON', () =>
  withTmp(async (dir) => {
    const file = join(dir, 'a', 'b', 'ledger.json');
    const store = new Store(file);
    const s = store.create({ name: 'first' });
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(raw.nextSpaceId, 2);
    assert.ok(raw.spaces[s.id]);
    assert.equal(raw.spaces[s.id].pages.p1.targetId, null);
    assert.equal(raw.spaces[s.id].state, 'active');
    assert.equal(raw.spaces[s.id].ownership, 'agent');
  })
);

test('store：完整操作流程落盤；重啟後資料與 labelSeq 延續', () =>
  withTmp(async (dir) => {
    const file = join(dir, 'ledger.json');
    const store = new Store(file);
    const s = store.create({ name: 'flow' });
    store.bindPage(s.id, 'p1', 'T1-FAKE_VALUE_FOR_TEST');
    const p2 = store.nextLabel(s.id);
    assert.equal(p2, 'p2');
    store.addPage(s.id, p2, 'T2-FAKE_VALUE_FOR_TEST', 'human');
    store.setPage(s.id, p2, { title: '整合測試頁', url: 'http://127.0.0.1:1/dummy' });

    // 直接檢查磁碟上的 JSON 內容（不經過 Store 的讀取路徑）
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(onDisk.spaces[s.id].pages.p2.title, '整合測試頁');
    assert.equal(onDisk.spaces[s.id].pages.p2.openedBy, 'human');
    assert.equal(onDisk.spaces[s.id].pages.p2.targetId, 'T2-FAKE_VALUE_FOR_TEST');
    assert.equal(onDisk.labelSeq[s.id], 2);

    // 模擬 daemon 重啟：新執行個體讀同一個檔案
    const restarted = new Store(file);
    const s2 = restarted.get(s.id);
    assert.equal(s2.pages.p1.targetId, 'T1-FAKE_VALUE_FOR_TEST');
    assert.equal(s2.pages.p2.url, 'http://127.0.0.1:1/dummy');
    assert.equal(restarted.nextLabel(s.id), 'p3');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).labelSeq[s.id], 3);
  })
);

test('store：錯誤路徑 — 未知空間的 bindPage/addPage 拋出；removePage 為 no-op', () =>
  withTmp(async (dir) => {
    const store = new Store(join(dir, 'ledger.json'));
    store.create({ name: 'only' });
    assert.throws(() => store.bindPage(999, 'p1', 'T-FAKE_VALUE_FOR_TEST'), /unknown space 999/);
    assert.throws(() => store.addPage(999, 'p1', 'T-FAKE_VALUE_FOR_TEST'), /unknown space 999/);
    assert.doesNotThrow(() => store.removePage(999, 'p1'));
    assert.doesNotThrow(() => store.deleteSpace(999));
  })
);

test('store：損毀 JSON → 安全地以全新狀態啟動並可繼續寫入', () =>
  withTmp(async (dir) => {
    const file = join(dir, 'ledger.json');
    writeFileSync(file, '{ this is not valid json', 'utf8');
    const store = new Store(file); // 不得拋出（既有 load() 會吞錯並重來）
    assert.deepEqual(store.data.spaces, {});
    assert.equal(store.data.nextSpaceId, 1);
    const s = store.create({ name: 'after-corruption' });
    const raw = JSON.parse(readFileSync(file, 'utf8')); // 檔案已被覆寫回合法 JSON
    assert.ok(raw.spaces[s.id]);
    assert.equal(raw.nextSpaceId, 2);
  })
);

test('store：removePage / deleteSpace 會持久化到磁碟', () =>
  withTmp(async (dir) => {
    const file = join(dir, 'ledger.json');
    const store = new Store(file);
    const s1 = store.create({ name: 'keep' });
    const s2 = store.create({ name: 'drop' });
    store.bindPage(s1.id, 'p1', 'T1-FAKE_VALUE_FOR_TEST');
    const p2 = store.nextLabel(s1.id);
    store.addPage(s1.id, p2, 'T2-FAKE_VALUE_FOR_TEST');
    store.removePage(s1.id, p2);
    store.deleteSpace(s2.id);

    const reloaded = new Store(file);
    assert.equal(reloaded.get(s2.id), null);
    assert.deepEqual(Object.keys(reloaded.get(s1.id).pages), ['p1']);
    assert.equal(reloaded.get(s1.id).pages.p1.targetId, 'T1-FAKE_VALUE_FOR_TEST');
  })
);
