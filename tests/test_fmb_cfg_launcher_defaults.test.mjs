// tests/test_fmb_cfg_launcher_defaults.test.mjs
//
// 目的：以「靜態讀檔」鎖定啟動器與 systemd unit 的設定契約——
// 埠號預設值、環境變數名稱、loopback 綁定、資料根目錄預設值。
//
// 為什麼不執行 .sh／.ps1：執行它們會真的啟動 Chrome 與 daemon（行程、開檔、可能碰網路），
// 那是 E2E 冒煙測試（tests/smoke.ego.js）的職責。設定層的契約用文字比對即可穩定守住。
//
// 邊界：只讀 repo 內的檔案；不連網、不讀寫 repo 以外的路徑、不含任何憑證或個資。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (relPath) => readFileSync(join(ROOT, relPath), 'utf8');

const TP_START = 'scripts/tp-start.sh';
const TP_STOP = 'scripts/tp-stop.sh';
const EGO_START_PS1 = 'scripts/ego-start.ps1';
const CHROME_UNIT = 'scripts/ego-linux-chrome.service';
const BROWSERD_UNIT = 'scripts/ego-linux-browserd.service';

test('tp-start.sh：預設埠對為 9772/9773，--alt-port 走備援埠對 9774/9775', () => {
  const sh = read(TP_START);
  assert.match(sh, /DAEMON_PORT=9772/, '預設 daemon 埠應為 9772');
  assert.match(sh, /CHROME_PORT=9773/, '預設 CDP 埠應為 9773');
  assert.match(sh, /DAEMON_PORT=9774/, '備援 daemon 埠應為 9774');
  assert.match(sh, /CHROME_PORT=9775/, '備援 CDP 埠應為 9775');
  assert.match(sh, /--alt-port\|-AltPort\) ALT_PORT=1/, '--alt-port 應切換到備援埠對');
});

test('tp-start.sh：CDP 僅綁定 127.0.0.1，且埠號／profile 由變數帶入', () => {
  const sh = read(TP_START);
  assert.match(sh, /--remote-debugging-address=127\.0\.0\.1/, '不得綁定非 loopback 位址');
  assert.match(sh, /--remote-debugging-port="\$CHROME_PORT"/, 'CDP 埠應由 CHROME_PORT 帶入');
  assert.match(sh, /--user-data-dir="\$PROFILE_DIR"/, 'profile 路徑應由 PROFILE_DIR 帶入');
});

test('tp-start.sh：資料根目錄預設為 $HOME/.local/share/ego-linux，瀏覽器可用 TP_BROWSER_BIN 覆寫', () => {
  const sh = read(TP_START);
  assert.match(sh, /DATA_DIR="\$HOME\/\.local\/share\/ego-linux"/, '資料根目錄預設值不應漂移');
  assert.match(sh, /PROFILE_DIR="\$DATA_DIR\/profile-agent"/, 'profile 應位於資料根目錄下的 profile-agent');
  assert.match(sh, /\$\{TP_BROWSER_BIN:-\}/, '應支援以 TP_BROWSER_BIN 覆寫瀏覽器執行檔');
});

test('tp-start.sh：無頭模式使用 --headless=new', () => {
  assert.match(read(TP_START), /--headless=new/, '無頭模式旗標不應改名');
});

test('ego-start.ps1：支援 TP_BROWSER_BIN 覆寫，埠對預設 9772/9773、-AltPort 為 9774/9775', () => {
  const ps1 = read(EGO_START_PS1);
  assert.match(ps1, /\$env:TP_BROWSER_BIN/, '應讀取 TP_BROWSER_BIN 環境變數');
  assert.match(ps1, /if \(\$UseAlt\) \{ 9774 \} else \{ 9772 \}/, 'daemon 埠對預設值不應漂移');
  assert.match(ps1, /if \(\$UseAlt\) \{ 9775 \} else \{ 9773 \}/, 'CDP 埠對預設值不應漂移');
  assert.match(ps1, /\$DataDir = Join-Path \$HOME "\.local\\share\\ego-linux"/, '資料根目錄預設值不應漂移');
  assert.match(ps1, /--remote-debugging-address=127\.0\.0\.1/, '不得綁定非 loopback 位址');
  assert.match(ps1, /--remote-debugging-port=\$ChromePort/, 'CDP 埠應由 $ChromePort 帶入');
});

test('systemd unit：Chrome 僅綁 loopback 且使用 profile-agent 預設資料夾；daemon unit 於 Chrome 之後啟動', () => {
  const chrome = read(CHROME_UNIT);
  assert.match(chrome, /--remote-debugging-address=127\.0\.0\.1/, '不得綁定非 loopback 位址');
  assert.match(chrome, /--remote-debugging-port=9773/, '預設 CDP 埠應為 9773');
  assert.match(chrome, /--user-data-dir=%h\/\.local\/share\/ego-linux\/profile-agent/, 'profile 預設路徑不應漂移');
  assert.match(chrome, /^Restart=on-failure$/m, '應設定失敗重啟策略');
  assert.match(chrome, /^WantedBy=default\.target$/m, '應可安裝為使用者服務');

  const browserd = read(BROWSERD_UNIT);
  assert.match(
    browserd,
    /^ExecStart=\/usr\/bin\/env node %h\/\.local\/share\/ego-linux\/app\/daemon\/ego-browserd\.js$/m,
    'daemon 啟動指令應指向安裝後的 ego-browserd.js',
  );
  assert.match(browserd, /^After=ego-linux-chrome\.service$/m, 'daemon 應在 Chrome 之後啟動');
  assert.match(browserd, /^WantedBy=default\.target$/m, '應可安裝為使用者服務');
});

test('tp-stop.sh：同時 flush 預設與備援埠對，並停止兩個 daemon 名稱', () => {
  const sh = read(TP_STOP);
  // 埠號由迴圈變數帶入，URL 不再寫死 9772／9774。
  assert.match(sh, /\$flush_port\/flush-and-close/, '應透過埠變數呼叫 flush-and-close');
  assert.match(sh, /127\.0\.0\.1/, 'flush 應打在 loopback');
  assert.match(sh, /9772/, '應 flush 預設 daemon 埠');
  assert.match(sh, /9774/, '應 flush 備援 daemon 埠');
  assert.match(sh, /ego-browserd\\?\.js/, '應停止 ego-browserd');
  assert.match(sh, /tp-browserd\\?\.js/, '應停止 tp-browserd');
});
