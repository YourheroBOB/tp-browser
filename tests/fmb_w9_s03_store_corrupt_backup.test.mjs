// tests/fmb_w9_s03_store_corrupt_backup.test.mjs
// 回歸測試（wave w9 / s03）：daemon/store.js 的 ledger 損毀備份缺陷。
//
//   B1 load() 失敗降級成空 ledger 後，下一個 persist() 直接覆寫原檔：截斷 JSON、
//      根節點 null、根節點陣列等原本可手動救回的損壞檔（含 space／page／targetId）
//      會永久消失，且不留任何備份。
//   修法（daemon/store.js）：load() 的失敗分支先把原檔原樣複製成
//      `${file}.corrupt-<timestamp>`（刻意不用 .tmp 結尾，避免與 persist() 的
//      `${file}.${pid}.tmp` 暫存檔清理規則衝突），才以空 ledger 繼續。
//
// 測試邊界：所有檔案讀寫都在 mkdtempSync(tmpdir()) 內，結束即刪除；零網路、零正式服務
// 連線；示例值一律使用 FAKE_VALUE_FOR_TEST 這類明顯假字串。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../daemon/store.js';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-w9-s03-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const corruptBackups = (dir) => readdirSync(dir).filter((name) => name.includes('.corrupt-'));

// 三種「無法當 ledger 使用」的損毀內容：截斷 JSON、根節點 null、根節點陣列。
const CORRUPT_CASES = [
  { label: '截斷 JSON', raw: '{"nextSpaceId":3,"spaces":{"1":' },
  { label: '根節點 null', raw: 'null' },
  { label: '根節點陣列', raw: '[]' },
];

for (const { label, raw } of CORRUPT_CASES) {
  test(`損毀 ledger（${label}）：降級為空前先留下 .corrupt- 備份，新 ledger 可正常讀回`, (t) => {
    const dir = tempDir(t);
    const file = join(dir, 'ledger.json');
    const original = Buffer.from(raw, 'utf8');
    writeFileSync(file, original);

    const errors = t.mock.method(console, 'error', () => {});
    const store = new Store(file); // 不得拋出；載入失敗並留下備份
    assert.ok(errors.mock.callCount() >= 1, '損毀 ledger 應留下載入失敗的診斷訊息');

    // 降級行為不變：空 ledger、可繼續操作。
    assert.deepEqual(store.list(), []);
    assert.equal(store.data.nextSpaceId, 1);

    // 建構階段（任何 persist 之前）就該留下恰一個備份，且原檔尚未被覆寫。
    const backups = corruptBackups(dir);
    assert.equal(backups.length, 1, `應留下恰一個 .corrupt- 備份，實際：${backups.join(',') || '(無)'}`);
    assert.match(backups[0], /^ledger\.json\.corrupt-\d+$/, '備份檔名應為 <ledger>.corrupt-<timestamp>');
    assert.ok(!backups[0].endsWith('.tmp'), '備份副檔名不得以 .tmp 結尾（避免與 persist 暫存檔清理規則衝突）');

    const backupPath = join(dir, backups[0]);
    assert.ok(readFileSync(backupPath).equals(original), '備份內容必須與原始位元組完全相同');
    assert.ok(readFileSync(file).equals(original), 'load() 失敗不得立刻覆寫原檔');

    // 寫入新空間：persist 覆寫正本，備份仍保留原始位元組。
    const created = store.create({ name: 'recovered' });
    assert.equal(created.id, 1);
    assert.equal(store.list().length, 1);

    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(onDisk.spaces['1'].name, 'recovered');
    assert.equal(onDisk.nextSpaceId, 2);

    const reloaded = new Store(file);
    assert.equal(reloaded.get(1)?.name, 'recovered', '新 ledger 必須可正常讀回');
    assert.equal(corruptBackups(dir).length, 1, '重載合法 ledger 不得再產生備份');
    assert.ok(readFileSync(backupPath).equals(original), '備份內容不得被後續操作改動');
  });
}

test('正常 ledger：載入成功不產生 .corrupt- 備份，也不影響後續寫入', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'ledger.json');
  writeFileSync(file, JSON.stringify({ nextSpaceId: 1, labelSeq: {}, spaces: {} }), 'utf8');

  const store = new Store(file);
  assert.deepEqual(store.list(), []);

  const created = store.create({ name: 'FAKE_VALUE_FOR_TEST' });
  assert.equal(created.id, 1);
  assert.equal(store.nextLabel(created.id), 'p2');

  assert.deepEqual(corruptBackups(dir), [], '合法 ledger 不得留下任何 .corrupt- 備份');
  assert.deepEqual(readdirSync(dir), ['ledger.json'], '目錄內只應有 ledger 本體（不留暫存檔或備份）');
  assert.equal(new Store(file).get(1)?.name, 'FAKE_VALUE_FOR_TEST');
});
