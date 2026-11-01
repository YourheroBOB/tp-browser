// tests/fmb_w2_s05_cli_eval_missing.test.mjs
//
// 回歸測試（fan-out s05 / w2）：`node bin/tp-browser.js nodejs -e`（-e 後面沒有程式碼）
// 舊行為：code 變成空字串 → 先跑去叫 tp-start.sh → 最後以「daemon 不在線」exit 2；
//         若 daemon 剛好在線，則執行空腳本並 exit 0，使用者完全看不出是參數錯誤。
// 新行為：在 ensureRunning() 之前驗證參數，印出用法並 exit 2，且不得呼叫啟動器。
//         另外驗證：ensureRunning 在啟動器回非 0 時，把啟動器的退出碼與標籤寫進錯誤訊息。
//
// 隔離手法（零外部依賴）：
//   * HOME 指向空的暫存目錄（daemon.json / token 都不存在，daemon 視為不在線）。
//   * PATH 換成不含 sh 啟動器依賴的 stub 目錄，避免誤觸系統上的啟動器。
//   * 啟動器 stub 放在 $HOME/.local/share/ego-linux/scripts/tp-start.sh（CLI 的
//     resolveScript 會優先找到它），它被執行時會在 stub 目錄留下標記檔，
//     用來斷言「啟動器沒有被呼叫」。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const tempRoot = mkdtempSync(join(tmpdir(), 'fmb-w2-s05-cli-eval-'));
const home = join(tempRoot, 'home');
const stubBin = join(tempRoot, 'stub-bin');
const dataDir = join(home, '.local', 'share', 'ego-linux');
const launcherScript = join(dataDir, 'scripts', 'tp-start.sh');
const marker = join(stubBin, 'launcher-invoked');

mkdirSync(home, { recursive: true });
mkdirSync(stubBin, { recursive: true });
mkdirSync(join(dataDir, 'scripts'), { recursive: true });

after(() => {
  try { rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});

const skipWin = process.platform === 'win32' ? 'launcher stub 為 POSIX sh，Windows 不適用' : false;

function writeLauncher(body) {
  mkdirSync(dirname(launcherScript), { recursive: true });
  writeFileSync(launcherScript, `#!/bin/sh\n: > ${JSON.stringify(marker)}\n${body}\n`, 'utf8');
  chmodSync(launcherScript, 0o755);
}

function cliPath(name) {
  return fileURLToPath(new URL(`../bin/${name}.js`, import.meta.url));
}

function cliEnv() {
  return { ...process.env, HOME: home, USERPROFILE: home, PATH: stubBin };
}

function runCli(name, args) {
  rmSync(marker, { force: true });
  return spawnSync(process.execPath, [cliPath(name), ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: cliEnv(),
  });
}

// 預設 stub：正常結束。若它真的被呼叫，會留下標記檔（測試就會失敗）。
writeLauncher('echo TP_READY\nexit 0');

for (const name of ['tp-browser', 'ego-browser']) {
  test(`${name} nodejs -e（後面沒有程式碼）→ exit 2、印用法、不呼叫啟動器`, { skip: skipWin }, () => {
    const r = runCli(name, ['nodejs', '-e']);
    assert.equal(r.status, 2, `exit code 應為 2，實際 ${r.status}；stderr=${r.stderr}`);
    assert.match(r.stderr, /usage:/i);
    assert.match(r.stderr, /nodejs/);
    assert.equal(existsSync(marker), false, '啟動器 stub 不該留下標記檔（代表 tp-start.sh 被呼叫了）');
    assert.doesNotMatch(r.stderr, /is not reachable/, '參數錯誤不應被誤導成 daemon 不在線');
  });

  test(`${name} nodejs -e ''（空字串）→ 同樣視為用法錯誤且不呼叫啟動器`, { skip: skipWin }, () => {
    const r = runCli(name, ['nodejs', '-e', '']);
    assert.equal(r.status, 2, `exit code 應為 2，實際 ${r.status}；stderr=${r.stderr}`);
    assert.match(r.stderr, /usage:/i);
    assert.equal(existsSync(marker), false, '啟動器 stub 不該留下標記檔（代表 tp-start.sh 被呼叫了）');
  });
}

test('tp-browser nodejs：ensureRunning 啟動器回非 0 時，錯誤訊息帶出退出碼與標籤', { skip: skipWin }, () => {
  writeLauncher('echo "tp-start: simulated failure" >&2\nexit 7');
  const r = runCli('tp-browser', ['nodejs', '-e', 'void 0;']);
  assert.equal(r.status, 2, `exit code 應為 2，實際 ${r.status}；stderr=${r.stderr}`);
  assert.match(r.stderr, /exited with code 7/, `stderr 應帶出啟動器退出碼；實際：${r.stderr}`);
  assert.match(r.stderr, /tp-start\.sh/, `stderr 應帶出啟動器標籤；實際：${r.stderr}`);
  assert.equal(existsSync(marker), true, '此案例啟動器應該真的被執行過');
});
