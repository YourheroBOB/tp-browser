// tests/fmb_w1_s05_launcher_status.test.mjs
// 回歸測試（w1/s05）：CLI 的 start / stop 啟動器若「被 signal 終止」或「spawn 失敗」，
// 必須讓 CLI 以非 0 結束；啟動器正常 exit 0 時仍必須回 0。
//
// 重現的 bug：bin/tp-browser.js 與 bin/ego-browser.js 的 runLauncher 都寫
// `return r.status ?? 0;`。spawnSync 在被 signal 終止時 status 為 null（signal 有值），
// spawn 失敗（例如 ENOENT）時 status 也是 null（error 有值），
// 於是 `tp-browser stop` 明明沒停成功卻回 0，自動化流程誤判服務狀態。
//
// 邊界：只使用 os.tmpdir() 建立的暫存 HOME 當作資料根目錄；不連線任何網路服務、
// 不讀寫 repo 以外的既有檔案（暫存目錄會在 after() 清除）。不使用任何真實憑證。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const BINS = ['bin/tp-browser.js', 'bin/ego-browser.js'];

// Windows 分支走 powershell.exe，與本測試的 /bin/sh 啟動器無關；
// 在非 POSIX 平台上整組跳過（skip 不計入失敗）。
const skip = process.platform === 'win32'
  ? '本測試只涵蓋 POSIX /bin/sh 啟動器分支'
  : false;

const tempHomes = [];
after(() => {
  for (const home of tempHomes) {
    try { rmSync(home, { recursive: true, force: true }); } catch {}
  }
});

function newTempHome(prefix) {
  const home = mkdtempSync(join(tmpdir(), prefix));
  tempHomes.push(home);
  return home;
}

// 建立 $HOME/.local/share/ego-linux/app/scripts/<scriptName>，這是 resolveScript()
// 在 POSIX 下的第一順位候選路徑。
function makeHome(scriptName, body) {
  const home = newTempHome('fmb-w1-s05-home-');
  const scriptsDir = join(home, '.local', 'share', 'ego-linux', 'app', 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(join(scriptsDir, scriptName), body, { mode: 0o755 });
  return home;
}

function runCli(binRel, args, home) {
  return spawnSync(process.execPath, [join(repoRoot, binRel), ...args], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
    timeout: 60_000,
  });
}

for (const bin of BINS) {
  test(`${bin} stop：啟動器被 SIGKILL 終止時必須回非 0，並在 stderr 說明被 signal 終止`, { skip }, () => {
    const home = makeHome('tp-stop.sh', '#!/bin/sh\nkill -9 $$\n');
    const res = runCli(bin, ['stop'], home);
    assert.notEqual(res.status, 0, `預期非 0，實際 status=${res.status}，stderr=${res.stderr}`);
    assert.equal(res.signal, null, 'CLI 本身不應被 signal 終止');
    assert.match(res.stderr, /signal/i);
    assert.match(res.stderr, /SIGKILL/);
  });

  test(`${bin} start：啟動器被 SIGKILL 終止時必須回非 0，並在 stderr 說明被 signal 終止`, { skip }, () => {
    const home = makeHome('tp-start.sh', '#!/bin/sh\nkill -9 $$\n');
    const res = runCli(bin, ['start'], home);
    assert.notEqual(res.status, 0, `預期非 0，實際 status=${res.status}，stderr=${res.stderr}`);
    assert.match(res.stderr, /signal/i);
    assert.match(res.stderr, /SIGKILL/);
  });

  test(`${bin} stop：啟動器正常 exit 0 時仍必須回 0`, { skip }, () => {
    const home = makeHome('tp-stop.sh', '#!/bin/sh\necho TP_STOPPED\nexit 0\n');
    const res = runCli(bin, ['stop'], home);
    assert.equal(res.status, 0, `stderr=${res.stderr}`);
    assert.match(res.stdout, /TP_STOPPED/);
    assert.equal(res.stderr, '');
  });

  test(`${bin} start：啟動器正常 exit 0 時仍必須回 0`, { skip }, () => {
    const home = makeHome('tp-start.sh', '#!/bin/sh\necho TP_STARTED\nexit 0\n');
    const res = runCli(bin, ['start'], home);
    assert.equal(res.status, 0, `stderr=${res.stderr}`);
    assert.match(res.stdout, /TP_STARTED/);
    assert.equal(res.stderr, '');
  });

  test(`${bin} stop：啟動器的非 0 退出碼必須原樣透傳（不可被吞掉或改成 0）`, { skip }, () => {
    const home = makeHome('tp-stop.sh', '#!/bin/sh\nexit 7\n');
    const res = runCli(bin, ['stop'], home);
    assert.equal(res.status, 7, `stderr=${res.stderr}`);
  });
}
