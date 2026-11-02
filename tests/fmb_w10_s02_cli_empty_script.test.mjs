// tests/fmb_w10_s02_cli_empty_script.test.mjs
// bin/tp-browser.js 的回歸測試：「沒有腳本」時必須在產生任何副作用之前就以 exit 2 結束。
//
// 修好之前的行為（真的 bug）：
//   * `tp-browser nodejs -e`（漏給 code）→ code 變成 undefined → 被 `String(code || '')` 吞成空字串；
//   * `tp-browser nodejs < /dev/null`（空 heredoc／BOM＋空白）→ 讀到空字串。
//   兩者都會先 ensureRunning() 拉起 daemon 與 Chrome，再匯入一個空腳本，最後 exit 0，
//   讓自動化腳本誤判「任務已執行」，還多啟動一次瀏覽器。
//
// 測試特性：零網路（TP_DAEMON_PORT 指向必然拒絕連線的 127.0.0.1:1，修好後根本不會被用到）、
// HOME/USERPROFILE 只指向 mkdtempSync(tmpdir()) 的暫存目錄、結束後清除，且只用假值。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/tp-browser.js', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'fmb-w10-s02-cli-empty-'));

after(() => rmSync(home, { recursive: true, force: true }));

function runCli(args, input) {
  return spawnSync(process.execPath, [CLI, ...args], {
    input,
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      // 一定拒絕連線的本機埠；修好後不會被讀到，若回歸也不會誤觸真實服務。
      TP_DAEMON_PORT: '1',
      // 避免任何意外路徑真的去探測／啟動本機瀏覽器。
      TP_BROWSER_BIN: join(home, 'no-such-browser'),
    },
  });
}

const NO_SCRIPT = /no script provided/;

test('nodejs -e 漏給 code：exit 2，且在啟動 daemon 前就結束', () => {
  const res = runCli(['nodejs', '-e']);
  assert.equal(res.status, 2, res.stderr || res.stdout || res.error?.message);
  assert.match(res.stderr, NO_SCRIPT);
  // 只有「完全沒有進入 ensureRunning()」時才不會出現 daemon 不可達的訊息。
  assert.doesNotMatch(res.stderr, /not reachable/);
  assert.equal(String(res.stdout ?? '').trim(), '');
});

test('nodejs 空 stdin（空 heredoc／< /dev/null）：exit 2 且不啟動任何東西', () => {
  const res = runCli(['nodejs'], '');
  assert.equal(res.status, 2, res.stderr || res.stderr);
  assert.match(res.stderr, NO_SCRIPT);
  assert.doesNotMatch(res.stderr, /not reachable/);
  assert.equal(String(res.stdout ?? '').trim(), '');
});

test('nodejs 只有 BOM 與空白的 stdin：視為沒有腳本', () => {
  const res = runCli(['nodejs'], '\uFEFF\n   \n\t\n');
  assert.equal(res.status, 2, res.stderr || res.stdout);
  assert.match(res.stderr, NO_SCRIPT);
});

test('nodejs -e ""：視為沒有腳本，不以 exit 0 假裝執行成功', () => {
  const res = runCli(['nodejs', '-e', '']);
  assert.equal(res.status, 2, res.stderr || res.stdout);
  assert.match(res.stderr, NO_SCRIPT);
});

test('version 子命令仍為純本機輸出並 exit 0', () => {
  const res = runCli(['version']);
  assert.equal(res.status, 0, res.stderr);
  assert.match(String(res.stdout ?? ''), /TooPower Browser/);
});

test('無參數時印出 usage 並 exit 0（維持既有說明行為）', () => {
  const res = runCli([]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(String(res.stdout ?? ''), /usage:/);
});
