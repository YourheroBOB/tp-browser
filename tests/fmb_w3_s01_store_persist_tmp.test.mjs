// tests/fmb_w3_s01_store_persist_tmp.test.mjs
// 回歸測試（wave w3 / s01）：daemon/store.js 的兩個缺陷
//   B1 persist() 的暫存檔清理：renameSync 失敗（Windows 防毒鎖檔 EPERM）後改為直接寫入，
//      但 `${file}.${pid}.tmp` 從此殘留；若直接寫入也失敗，例外外拋、暫存檔同樣沒清掉。
//   B2 removePage(spaceId, label) 移除的分頁正好是 activeTargetId 指向的 target 時，
//      activeTargetId 仍留著已失效的 targetId。
//
// 測試邊界：所有檔案讀寫都在 mkdtempSync(tmpdir()) 內；零網路、零正式服務連線，
// 示例值一律使用 FAKE_VALUE_FOR_TEST 這類明顯假字串。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../daemon/store.js';

const RENAME_CALLS = '__fmbW3S01RenameCalls';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-w3-s01-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const tmpLeftovers = (dir) => readdirSync(dir).filter((name) => name.includes('.tmp'));

// 把 store.js 原碼中的 node:fs renameSync 換成「一定失敗」的樁。這樣就不必依賴
// 目錄權限技巧（rename 與 unlink 都受目錄寫入權限制，無法同時滿足），也能在
// Linux／macOS／Windows 與 root 環境下穩定重現 rename 失敗（EPERM）路徑。
const RENAME_STUB = [
  'const renameSync = () => {',
  `  globalThis.${RENAME_CALLS} = (globalThis.${RENAME_CALLS} ?? 0) + 1;`,
  "  const err = new Error('EPERM: simulated rename failure (FAKE_VALUE_FOR_TEST)');",
  "  err.code = 'EPERM';",
  '  throw err;',
  '};',
].join('\n');

async function loadStoreWithFailingRename() {
  const source = readFileSync(new URL('../daemon/store.js', import.meta.url), 'utf8');
  const importRe = /^import\s*\{([^}]*)\}\s*from\s*['"]node:fs['"];?[ \t]*$/m;
  const match = source.match(importRe);
  if (!match) throw new Error('daemon/store.js 找不到 node:fs 匯入述句，請同步更新本測試');
  const names = match[1]
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean)
    .filter((n) => n !== 'renameSync');
  if (names.length === 0) throw new Error('daemon/store.js 的 node:fs 匯入清單為空');
  const patched = source.replace(
    importRe,
    () => `import { ${names.join(', ')} } from 'node:fs';\n${RENAME_STUB}`,
  );
  const url = `data:text/javascript;base64,${Buffer.from(patched, 'utf8').toString('base64')}`;
  const mod = await import(url);
  if (typeof mod.Store !== 'function') throw new Error('故障注入版 store 模組未匯出 Store');
  return mod.Store;
}

test('B1：file 指向既有目錄時 persist 會丟錯，且不留下任何 *.tmp', (t) => {
  const dir = tempDir(t);
  const target = join(dir, 'ledger.json');
  mkdirSync(target); // file 本身是目錄 → rename 與直接寫入都會失敗
  t.mock.method(console, 'error', () => {}); // new Store() 讀目錄失敗時會印警告（既有行為）

  const store = new Store(target);
  assert.throws(
    () => store.persist(),
    (err) => err instanceof Error && typeof err.code === 'string',
    'persist 應把 rename／直接寫入的檔案系統錯誤往外拋',
  );

  const leftovers = tmpLeftovers(dir);
  assert.deepEqual(leftovers, [], `persist 失敗後不得殘留暫存檔，實際：${leftovers.join(',')}`);
});

test('B1：rename 失敗、直接寫入成功時，正本已更新且不留暫存檔', async (t) => {
  let PatchedStore;
  try {
    PatchedStore = await loadStoreWithFailingRename();
  } catch (err) {
    t.skip(`無法建立故障注入版 Store：${err.message}`);
    return;
  }

  const dir = tempDir(t);
  const file = join(dir, 'ledger.json');
  globalThis[RENAME_CALLS] = 0;
  t.after(() => { delete globalThis[RENAME_CALLS]; });

  const store = new PatchedStore(file);
  const space = store.create({ name: 'rename-fallback' });

  assert.ok(globalThis[RENAME_CALLS] > 0, '測試前提：renameSync 必須被呼叫且失敗');
  assert.equal(tmpLeftovers(dir).length, 0, 'fallback 之後不得留下 *.tmp');

  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(onDisk.spaces[space.id].name, 'rename-fallback');
  assert.equal(onDisk.nextSpaceId, 2);
  assert.equal(JSON.stringify(onDisk), JSON.stringify(store.data), '直接寫入的正本必須等於記憶體狀態');

  // 之後每一次 persist 都走同一條 fallback，仍不得累積暫存檔
  store.setPage(space.id, 'p1', { title: '標題', url: 'http://127.0.0.1:0/p1' });
  const again = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(again.spaces[space.id].pages.p1.title, '標題');
  assert.equal(tmpLeftovers(dir).length, 0, '重複 fallback 不得累積 *.tmp');
});

test('B2：removePage 移除作用中分頁後 activeTargetId 清為 null（含重新載入）', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'ledger.json');
  const store = new Store(file);
  const space = store.create({ name: 'active-target' });

  store.bindPage(space.id, 'p1', 'T1-FAKE_VALUE_FOR_TEST');
  store.get(space.id).activeTargetId = 'T1-FAKE_VALUE_FOR_TEST';
  store.persist();

  store.removePage(space.id, 'p1');
  assert.equal(store.get(space.id).pages.p1, undefined);
  assert.equal(store.get(space.id).activeTargetId, null);

  const reloaded = new Store(file);
  assert.equal(reloaded.get(space.id).pages.p1, undefined);
  assert.equal(reloaded.get(space.id).activeTargetId, null);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).spaces[space.id].activeTargetId, null);
});

test('B2：移除其他分頁不得清掉仍有效的 activeTargetId', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'ledger.json');
  const store = new Store(file);
  const space = store.create({ name: 'keep-active' });

  store.bindPage(space.id, 'p1', 'T1-FAKE_VALUE_FOR_TEST');
  store.addPage(space.id, 'p2', 'T2-FAKE_VALUE_FOR_TEST');
  store.get(space.id).activeTargetId = 'T1-FAKE_VALUE_FOR_TEST';
  store.persist();

  store.removePage(space.id, 'p2');
  assert.equal(store.get(space.id).activeTargetId, 'T1-FAKE_VALUE_FOR_TEST');

  store.removePage(space.id, 'p1');
  assert.equal(store.get(space.id).activeTargetId, null);
  assert.equal(new Store(file).get(space.id).activeTargetId, null);
});
