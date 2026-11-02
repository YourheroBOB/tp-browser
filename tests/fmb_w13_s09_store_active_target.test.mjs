// tests/fmb_w13_s09_store_active_target.test.mjs
// 回歸測試（wave w13 / s09）：daemon/store.js 的 activeTargetId 懸空缺陷。
//
//   B1 bindPage／addPage 覆寫同名 label 時會整筆換掉分頁，舊的 targetId 就此從 ledger
//      消失，但 space.activeTargetId 仍留著它。removePage 早在 w3_s01 就被修成「移除
//      作用中分頁要一起清掉 activeTargetId」，同一條不變量卻漏了「覆寫」這條路徑：
//      daemon 重啟（重新載入 ledger）後，後續 RPC 會被送往一個已經不在任何分頁上的
//      targetId。
//   B2 setPage 的 patch 若改掉 targetId，同樣會讓 activeTargetId 懸空。
//   B3 removePage 原本只要「被移除分頁的 targetId === activeTargetId」就清掉，即使另一個
//      label 仍綁著同一個 targetId（target 還在）；收斂成「沒有任何分頁引用時才清」。
//
//   修法（daemon/store.js）：新增模組層 helper reconcileActiveTarget(space)，在
//   bindPage／addPage／setPage／removePage 異動 pages 後對帳 —— activeTargetId 為 null
//   或仍被某個分頁引用時不動，已無任何分頁引用時清成 null。不新增 Store.prototype 方法
//   （維持 contract 測試鎖定的公開介面），persist 次數與 ledger 檔案格式皆不變。
//
// 測試邊界：所有檔案讀寫都在 mkdtempSync(tmpdir()) 內，結束即刪除；零網路、零正式服務
// 連線；示例值一律使用 FAKE_VALUE_FOR_TEST 這類明顯假字串。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../daemon/store.js';

function tempFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-w13-s09-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'ledger.json');
}

const onDisk = (file) => JSON.parse(readFileSync(file, 'utf8'));

// 建立一個空間、綁定 p1，並把 activeTargetId 指到它（模擬 daemon 已經在用的作用中分頁）。
function seededStore(t, activeTargetId) {
  const file = tempFile(t);
  const store = new Store(file);
  const space = store.create({ name: 'active-target' });
  store.bindPage(space.id, 'p1', activeTargetId);
  store.get(space.id).activeTargetId = activeTargetId;
  store.persist();
  assert.equal(onDisk(file).spaces[space.id].activeTargetId, activeTargetId, '前提：activeTargetId 已落盤');
  return { file, store, space };
}

test('B1：bindPage 覆寫作用中的分頁後，activeTargetId 必須清為 null（記憶體／磁碟／重載一致）', (t) => {
  const { file, store, space } = seededStore(t, 'T-OLD-FAKE_VALUE_FOR_TEST');

  store.bindPage(space.id, 'p1', 'T-NEW-FAKE_VALUE_FOR_TEST');

  assert.equal(store.get(space.id).pages.p1.targetId, 'T-NEW-FAKE_VALUE_FOR_TEST');
  assert.equal(
    store.get(space.id).activeTargetId,
    null,
    '舊 targetId 已被覆寫掉，activeTargetId 不得繼續指向它',
  );
  assert.equal(onDisk(file).spaces[space.id].activeTargetId, null, '落盤內容必須與記憶體一致');

  const reloaded = new Store(file);
  assert.equal(reloaded.get(space.id).activeTargetId, null, '重載後不得復活懸空的 activeTargetId');
  assert.equal(reloaded.get(space.id).pages.p1.targetId, 'T-NEW-FAKE_VALUE_FOR_TEST');
});

test('B1：以相同 targetId 重新綁定（冪等重綁）不得誤清 activeTargetId', (t) => {
  const { file, store, space } = seededStore(t, 'T-SAME-FAKE_VALUE_FOR_TEST');

  store.bindPage(space.id, 'p1', 'T-SAME-FAKE_VALUE_FOR_TEST');
  assert.equal(
    store.get(space.id).activeTargetId,
    'T-SAME-FAKE_VALUE_FOR_TEST',
    '分頁仍綁著同一個 target，作用中指標必須保留',
  );
  assert.equal(onDisk(file).spaces[space.id].activeTargetId, 'T-SAME-FAKE_VALUE_FOR_TEST');
});

test('B1：addPage 覆寫作用中 label 會清掉 activeTargetId；新增其他 label 則不受影響', (t) => {
  const { file, store, space } = seededStore(t, 'T-ACTIVE-FAKE_VALUE_FOR_TEST');

  store.addPage(space.id, 'p2', 'T-OTHER-FAKE_VALUE_FOR_TEST');
  assert.equal(
    store.get(space.id).activeTargetId,
    'T-ACTIVE-FAKE_VALUE_FOR_TEST',
    '新增不同 label 不得動到作用中指標',
  );

  store.addPage(space.id, 'p1', 'T-OVERWRITE-FAKE_VALUE_FOR_TEST');
  assert.equal(store.get(space.id).activeTargetId, null, 'p1 已被覆寫，作用中指標必須清掉');
  assert.equal(onDisk(file).spaces[space.id].activeTargetId, null);
  assert.equal(new Store(file).get(space.id).activeTargetId, null);
});

test('B1：兩個 label 共用同一個 targetId 時，覆寫其中一個不得誤清 activeTargetId', (t) => {
  const { file, store, space } = seededStore(t, 'T-SHARED-FAKE_VALUE_FOR_TEST');
  store.addPage(space.id, 'p2', 'T-SHARED-FAKE_VALUE_FOR_TEST');
  assert.equal(onDisk(file).spaces[space.id].activeTargetId, 'T-SHARED-FAKE_VALUE_FOR_TEST');

  store.bindPage(space.id, 'p1', 'T-OTHER-FAKE_VALUE_FOR_TEST');
  assert.equal(
    store.get(space.id).activeTargetId,
    'T-SHARED-FAKE_VALUE_FOR_TEST',
    'p2 仍綁著同一個 target，作用中指標必須保留',
  );

  store.bindPage(space.id, 'p2', 'T-ANOTHER-FAKE_VALUE_FOR_TEST');
  assert.equal(
    store.get(space.id).activeTargetId,
    null,
    '此時已無任何分頁引用該 targetId，必須清為 null',
  );
  assert.equal(onDisk(file).spaces[space.id].activeTargetId, null);
});

test('B2：setPage 的 patch 改掉 targetId 會清掉 activeTargetId；只改 title／url 則保留', (t) => {
  const { file, store, space } = seededStore(t, 'T-A-FAKE_VALUE_FOR_TEST');

  store.setPage(space.id, 'p1', { title: '只改標題', url: 'http://127.0.0.1:0/p1' });
  assert.equal(
    store.get(space.id).activeTargetId,
    'T-A-FAKE_VALUE_FOR_TEST',
    'patch 未動到 targetId，作用中指標必須保留',
  );

  // 明確寫回同一個 targetId 也不得誤清。
  store.setPage(space.id, 'p1', { targetId: 'T-A-FAKE_VALUE_FOR_TEST' });
  assert.equal(store.get(space.id).activeTargetId, 'T-A-FAKE_VALUE_FOR_TEST');

  store.setPage(space.id, 'p1', { targetId: 'T-B-FAKE_VALUE_FOR_TEST' });
  assert.equal(
    store.get(space.id).activeTargetId,
    null,
    'targetId 已被 patch 換掉，作用中指標必須清成 null',
  );
  assert.equal(onDisk(file).spaces[space.id].activeTargetId, null);
  assert.equal(new Store(file).get(space.id).activeTargetId, null);

  // patch 把 targetId 設成 null（解除綁定）時同理。
  const second = seededStore(t, 'T-C-FAKE_VALUE_FOR_TEST');
  second.store.setPage(second.space.id, 'p1', { targetId: null });
  assert.equal(second.store.get(second.space.id).activeTargetId, null);
});

test('B2：作用中指標不受其他分頁的 setPage 影響', (t) => {
  const { store, space } = seededStore(t, 'T-KEEP-FAKE_VALUE_FOR_TEST');
  store.addPage(space.id, 'p2', null);

  store.setPage(space.id, 'p2', { title: '別人的標題' });
  assert.equal(store.get(space.id).activeTargetId, 'T-KEEP-FAKE_VALUE_FOR_TEST');

  store.setPage(space.id, 'p2', { targetId: 'T-P2-FAKE_VALUE_FOR_TEST' });
  assert.equal(store.get(space.id).activeTargetId, 'T-KEEP-FAKE_VALUE_FOR_TEST');

  // 未知 label 仍是 no-op：不得動到任何狀態，也不得寫檔。
  store.setPage(space.id, 'p9', { targetId: 'T-GHOST-FAKE_VALUE_FOR_TEST' });
  assert.equal(store.get(space.id).activeTargetId, 'T-KEEP-FAKE_VALUE_FOR_TEST');
});

test('B3：removePage 只在「再沒有任何分頁引用該 targetId」時才清 activeTargetId', (t) => {
  const { file, store, space } = seededStore(t, 'T-SHARED-FAKE_VALUE_FOR_TEST');
  store.addPage(space.id, 'p2', 'T-SHARED-FAKE_VALUE_FOR_TEST');
  assert.equal(onDisk(file).spaces[space.id].activeTargetId, 'T-SHARED-FAKE_VALUE_FOR_TEST');

  store.removePage(space.id, 'p2');
  assert.equal(
    store.get(space.id).activeTargetId,
    'T-SHARED-FAKE_VALUE_FOR_TEST',
    'p1 仍綁著同一個 target，移除 p2 不得把作用中指標清掉',
  );
  assert.equal(onDisk(file).spaces[space.id].activeTargetId, 'T-SHARED-FAKE_VALUE_FOR_TEST');

  store.removePage(space.id, 'p1');
  assert.equal(store.get(space.id).activeTargetId, null, '最後一個引用被移除後必須清為 null');
  assert.equal(onDisk(file).spaces[space.id].activeTargetId, null);
  assert.equal(new Store(file).get(space.id).activeTargetId, null);
});

test('不變量：一連串綁定／覆寫／移除後，activeTargetId 必定是 null 或存在於某個分頁上', (t) => {
  const file = tempFile(t);
  const store = new Store(file);
  const space = store.create({ name: 'invariant' });

  const referenced = (id) => Object.values(store.get(space.id).pages)
    .some((page) => page && page.targetId === id);

  store.bindPage(space.id, 'p1', 'T1-FAKE_VALUE_FOR_TEST');
  store.get(space.id).activeTargetId = 'T1-FAKE_VALUE_FOR_TEST';
  store.persist();

  const steps = [
    () => store.bindPage(space.id, 'p2', 'T1-FAKE_VALUE_FOR_TEST'),
    () => store.bindPage(space.id, 'p1', 'T2-FAKE_VALUE_FOR_TEST'),
    () => store.setPage(space.id, 'p2', { targetId: 'T3-FAKE_VALUE_FOR_TEST' }),
    () => store.addPage(space.id, 'p3', 'T3-FAKE_VALUE_FOR_TEST'),
    () => store.removePage(space.id, 'p2'),
    () => store.removePage(space.id, 'p3'),
    () => store.removePage(space.id, 'p1'),
  ];

  for (const [i, step] of steps.entries()) {
    step();
    const active = store.get(space.id).activeTargetId;
    if (active !== null) {
      assert.ok(referenced(active), `第 ${i + 1} 步後 activeTargetId=${active} 必須仍有分頁引用`);
    }
    assert.equal(
      onDisk(file).spaces[space.id].activeTargetId,
      active,
      `第 ${i + 1} 步後磁碟內容必須與記憶體一致`,
    );
    assert.equal(new Store(file).get(space.id).activeTargetId, active, `第 ${i + 1} 步後重載仍須一致`);
  }

  assert.equal(store.get(space.id).activeTargetId, null, '全部分頁移除後必須是 null');
});
