// tests/fmb_w14_s04_ego_browserd_argv.test.mjs
// 回歸測試：daemon/ego-browserd.js 的啟動參數處理。
//
// 修正前的行為：啟動參數只用 `process.argv.includes('--alt-port')` 掃過一次，其餘參數
// 一律靜默丟棄。因此 `ego-browserd --help` 不會印出用法，而是直接啟動一個常駐 daemon
// 綁定「預設」埠 9772：呼叫端以為自己只是問用法，實際上多了一個佔用固定埠的背景程序，
// 後續 `tp-browser`／SDK 就可能連到這個意外啟動的 daemon。
//
// 本檔的足跡刻意壓到最小（全套測試是平行執行的，任何額外子程序都可能與其他測試的
// `pgrep`／`pkill` 樣式互相干擾）：
//   * 只啟動 2 個「按到 --help 就立刻結束」的短命子程序，不綁任何連接埠、不連線網路。
//   * daemon 檔案先複製到 os.tmpdir() 下的暫存目錄，且路徑刻意不含 `daemon`、
//     `ego-browserd`、`profile-agent`、`ego-linux` 等字樣，避免被其他測試清理程序時
//     使用的寬鬆樣式命中（也不會反過來誤殺別人）。
//   * HOME 指向各自獨立的暫存目錄，並斷言連資料目錄 / token / daemon.json 都沒被建立，
//     證明 help 分支確實早於所有檔案副作用。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const daemonDir = fileURLToPath(new URL('../daemon/', import.meta.url));
const sandboxDir = mkdtempSync(join(tmpdir(), 'fmb-w14-s04-sbx-'));
const copyDir = join(sandboxDir, 'copy');
const entryPath = join(copyDir, 'w14s04-entry.js');

cpSync(daemonDir, copyDir, { recursive: true });
renameSync(join(copyDir, 'ego-browserd.js'), entryPath);

after(() => rmSync(sandboxDir, { recursive: true, force: true }));

const DATA_SUBPATH = join('.local', 'share', 'ego-linux');

// 固定上限：若 help 分支沒有在啟動前生效（daemon 真的起來了），子程序不會自行結束，
// spawnSync 會以 SIGTERM 收掉它，測試再以 signal !== null 明確失敗，而不是讓
// `node --test` 卡住。
const TIMEOUT_MS = 5000;

function runDaemon(args) {
  const home = mkdtempSync(join(tmpdir(), 'fmb-w14-s04-home-'));
  const r = spawnSync(process.execPath, [entryPath, ...args], {
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    // 明確清空 EGO_BROWSERD_PORT，避免外部環境影響子程序的埠位選擇。
    env: { ...process.env, HOME: home, USERPROFILE: home, EGO_BROWSERD_PORT: '' },
  });
  return { r, home };
}

function assertUsageOnly(r, home) {
  assert.equal(r.signal, null, `daemon 未結束（signal=${r.signal}）：help 分支沒有在啟動前生效`);
  assert.equal(r.status, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.equal(r.stderr, '');
  assert.match(r.stdout, /^usage: ego-browserd \[--alt-port\]$/m);
  assert.match(r.stdout, /127\.0\.0\.1:9772/);
  assert.match(r.stdout, /127\.0\.0\.1:9774/);
  // help 早於所有檔案副作用：連資料目錄都不該被建立。
  assert.equal(
    existsSync(join(home, DATA_SUBPATH)),
    false,
    'help 必須早於資料目錄 / token / daemon.json 的建立',
  );
}

test('--help：印出用法、以 0 結束，且不建立任何資料目錄（不會意外啟動 daemon）', () => {
  const { r, home } = runDaemon(['--help']);
  try {
    assertUsageOnly(r, home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('-h 與 --alt-port 併用：仍只印用法並以 0 結束（help 具優先權，--alt-port 為已知參數）', () => {
  const { r, home } = runDaemon(['-h', '--alt-port']);
  try {
    assertUsageOnly(r, home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
