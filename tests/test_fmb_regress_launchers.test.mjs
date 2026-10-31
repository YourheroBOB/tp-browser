// tests/test_fmb_regress_launchers.test.mjs
// 回歸測試（靜態契約）：啟動／停止腳本與 package.json 的既有修正不得回退。
// 只讀 repo 內檔案，不啟動任何程序、不連線任何服務、不讀寫 repo 以外的路徑。
//
// 對應的修正痕跡：
//   - Chrome/Chromium 一律 `--remote-debugging-address=127.0.0.1`（杜絕區網探測）；
//     曾有人改成 0.0.0.0 而把 CDP 暴露出去。
//   - tp-stop.sh 只終止本專屬 profile/daemon（README：絕不影響你個人日常開啟的瀏覽器視窗）；
//     曾經用無差別 pkill 殺掉使用者自己的 Chrome。
//   - tp-start.sh 先起 daemon 再起瀏覽器（/newtab 需已就緒）、並清除殘留 Singleton lock；
//     曾經因為掉換順序或殘留 lock 而啟動失敗。
//   - 背景啟動走 detached + unref（避免在 SSH／pipe 下卡死父程序）。
//   - package.json 維持零 npm 相依、ESM 與 Node >= 22 的對外契約。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const startSh = read('../scripts/tp-start.sh');
const stopSh = read('../scripts/tp-stop.sh');
const chromeService = read('../scripts/ego-linux-chrome.service');
const pkg = JSON.parse(read('../package.json'));

test('launcher：Chrome 的 CDP 只綁 127.0.0.1，不得回退成 0.0.0.0', () => {
  const targets = [
    ['scripts/tp-start.sh', startSh],
    ['scripts/ego-linux-chrome.service', chromeService],
  ];
  for (const [name, text] of targets) {
    assert.match(text, /--remote-debugging-address=127\.0\.0\.1/, `${name} 必須指定 loopback CDP`);
    assert.doesNotMatch(
      text,
      /--remote-debugging-address=(?:0\.0\.0\.0|\[::\])/,
      `${name} 不得綁定非 loopback 位址`,
    );
  }
});

test('launcher：tp-stop.sh 只終止本專屬 profile/daemon，不得無差別殺掉使用者的瀏覽器', () => {
  const pkillLines = stopSh
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('pkill'));

  assert.ok(pkillLines.length > 0, 'tp-stop.sh 應以 pkill 收斂程序');
  for (const line of pkillLines) {
    assert.match(
      line,
      /\$PROFILE_DIR|ego-browserd\.js|tp-browserd\.js/,
      `不可無差別終止程序：${line}`,
    );
  }
});

test('launcher：tp-start.sh 先起 daemon 再起瀏覽器，且清理殘留 Singleton lock', () => {
  const daemonIdx = startSh.indexOf('spawn_detached "$LOGS_DIR/daemon.log"');
  const chromeIdx = startSh.indexOf('spawn_detached "$LOGS_DIR/chrome.log"');

  assert.ok(daemonIdx >= 0, '找不到 daemon 啟動指令');
  assert.ok(chromeIdx >= 0, '找不到瀏覽器啟動指令');
  assert.ok(daemonIdx < chromeIdx, 'daemon 必須先於瀏覽器啟動（/newtab 需已就緒）');

  for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    assert.match(startSh, new RegExp(lock), `啟動前必須清掉 ${lock}`);
  }

  assert.match(startSh, /detached: true/, '背景啟動必須 detached');
  assert.match(startSh, /unref\(\)/, '背景啟動必須 unref，避免卡住父程序');
});

test('package：維持零 npm 相依、ESM 與 Node >= 22 的對外契約', () => {
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const value = pkg[field];
    assert.equal(
      value === undefined || Object.keys(value).length === 0,
      true,
      `${field} 必須為空（零依賴是本專案賣點）`,
    );
  }
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.engines?.node, '>=22');
  assert.equal(pkg.bin?.['tp-browser'], 'bin/tp-browser.js');
  assert.equal(pkg.bin?.['ego-browser'], 'bin/ego-browser.js');
});
