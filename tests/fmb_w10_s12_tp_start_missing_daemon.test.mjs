// tests/fmb_w10_s12_tp_start_missing_daemon.test.mjs
//
// 回歸測試（fmb/w10/s12）：scripts/tp-start.sh 在拆掉現有實例
// （flush-and-close + pkill）之前，必須先確認要啟動的 daemon 腳本真的存在。
//
// 原本行為：APP_DIR 被中斷的 install.sh 清掉（或 repo 被搬走）時，
// $DAEMON_JS 指向不存在的檔案，但腳本仍先 flush 9772/9774 並 pkill 掉健康的
// daemon 與 Chrome，接著 node 以 "Cannot find module" 失敗，最後只留下
// TP_NOT_READY —— 使用者從「有可用的瀏覽器」變成「什麼都沒有」。
//
// 全程零網路、零真實程序：curl/node/pgrep/pkill/sleep 都是 tmpdir() 內的 stub，
// HOME 與所有被啟動的路徑一律指向 tmpdir()。

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SH = '/bin/sh';
const repoScript = fileURLToPath(new URL('../scripts/tp-start.sh', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'fmb-w10-s12-tp-start-'));

after(() => rmSync(root, { recursive: true, force: true }));

function writeStubs(binDir, callsLog, { healthy }) {
  mkdirSync(binDir, { recursive: true });
  const logArgs = [
    'name=$(basename "$0")',
    `printf '%s' "$name" >> '${callsLog}'`,
    `for a in "$@"; do printf ' %s' "$a" >> '${callsLog}'; done`,
    `printf '\\n' >> '${callsLog}'`,
  ].join('\n');
  const write = (name, body) => {
    const p = join(binDir, name);
    writeFileSync(p, `#!/bin/sh\n${logArgs}\n${body}\n`);
    chmodSync(p, 0o755);
  };
  write(
    'curl',
    healthy
      ? `case "$*" in *"/health"*) printf '%s' '{"ok":true,"chrome":true}' ;; esac\nexit 0`
      : 'exit 7',
  );
  write('node', 'exit 0');
  write('pgrep', 'exit 1');
  write('pkill', 'exit 0');
  write('sleep', 'exit 0');
}

function makeBox(name, { withDaemon, healthy }) {
  const box = join(root, name);
  const home = join(box, 'home');
  const scriptDir = join(box, 'scripts');
  const binDir = join(box, 'bin');
  const calls = join(box, 'calls.log');
  mkdirSync(home, { recursive: true });
  mkdirSync(scriptDir, { recursive: true });
  copyFileSync(repoScript, join(scriptDir, 'tp-start.sh'));
  chmodSync(join(scriptDir, 'tp-start.sh'), 0o755);
  if (withDaemon) {
    mkdirSync(join(box, 'daemon'), { recursive: true });
    writeFileSync(join(box, 'daemon', 'ego-browserd.js'), '// stub daemon for tp-start test\n');
  }
  const browser = join(box, 'fake-browser');
  writeFileSync(browser, '#!/bin/sh\nexit 0\n');
  chmodSync(browser, 0o755);
  writeStubs(binDir, calls, { healthy });
  return { box, home, scriptDir, binDir, calls, browser };
}

function runScript(box, args = []) {
  return spawnSync(SH, [join(box.scriptDir, 'tp-start.sh'), ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: box.home,
      PATH: `${box.binDir}:${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`,
      TP_BROWSER_BIN: box.browser,
      // 不讓 WSL 委派分支有任何機會接觸真實的 /proc/version 或 /mnt/c。
      TP_START_PROC_VERSION: join(box.box, 'no-such-proc-version'),
      TP_START_WIN_PS: join(box.box, 'no-such-powershell'),
      TP_START_WIN_USERS: join(box.box, 'no-such-users'),
    },
  });
}

const readCalls = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

test('tp-start.sh：daemon 腳本不存在時先報錯，不得 flush／pkill／spawn', () => {
  const box = makeBox('missing-daemon', { withDaemon: false, healthy: false });
  const res = runScript(box);
  const calls = readCalls(box.calls);

  assert.equal(res.status, 1, `stdout=${res.stdout}\nstderr=${res.stderr}\ncalls=${calls}`);
  assert.match(res.stderr, /daemon script not found/);
  assert.doesNotMatch(calls, /flush-and-close/, `驗證前就 flush 了：\n${calls}`);
  assert.doesNotMatch(calls, /^pkill /m, `驗證前就 pkill 了：\n${calls}`);
  assert.doesNotMatch(calls, /^node /m, `驗證前就 spawn 了：\n${calls}`);
});

test('tp-start.sh：daemon 腳本存在時（--restart）仍會 flush → spawn → TP_READY', () => {
  const box = makeBox('with-daemon', { withDaemon: true, healthy: true });
  const res = runScript(box, ['--restart']);
  const calls = readCalls(box.calls);

  assert.equal(res.status, 0, `stdout=${res.stdout}\nstderr=${res.stderr}\ncalls=${calls}`);
  assert.match(res.stdout, /TP_READY/);
  assert.match(calls, /flush-and-close/);
  assert.match(calls, /^pkill /m);
  assert.match(calls, /ego-browserd\.js/);

  const flushAt = calls.indexOf('flush-and-close');
  const nodeAt = calls.search(/^node /m);
  assert.ok(nodeAt > flushAt, `flush 應早於 spawn：\n${calls}`);
});
