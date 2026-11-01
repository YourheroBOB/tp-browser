// tests/fmb_w4_s12_tp_start_kill_wait.test.mjs
// 回歸測試：tp-start.sh 送出 SIGTERM 之後，必須「等到舊程序真的消失」才刪除
// profile-agent 的 Singleton* 鎖檔並啟動新的 Chrome；等不到時要升級為 SIGKILL。
// 全部使用 tmpdir() 沙箱 + shell stub，不連線網路、不寫入 repo 以外的既有路徑。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accessSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/tp-start.sh', import.meta.url));
const COREUTILS = ['dirname', 'mkdir', 'chmod', 'grep', 'pwd', 'id', 'sh', 'cat'];

function findExecutable(name) {
  for (const dir of ['/usr/bin', '/bin']) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate);
      return candidate;
    } catch {
      // 繼續找下一個路徑
    }
  }
  throw new Error(`required system utility not found: ${name}`);
}

// 每個 stub 都把自己的呼叫（含參數）依序寫進 $TP_LOG，用來驗證順序。
const stub = (tag, code = 0) => `#!/bin/sh\necho "${tag} $*" >> "$TP_LOG"\nexit ${code}\n`;

function makeSandbox(t, { oldProcessesAlive }) {
  const root = mkdtempSync(join(tmpdir(), 'fmb-w4-s12-tp-start-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const log = join(root, 'calls.log');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(log, '');

  for (const name of COREUTILS) {
    try {
      symlinkSync(findExecutable(name), join(bin, name));
    } catch {
      // 部分工具可能是 shell builtin，缺少時忽略。
    }
  }

  const browserBin = join(root, 'fake-browser');
  writeFileSync(browserBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  chmodSync(browserBin, 0o755);

  const stubs = {
    // 沒有任何 daemon 在跑：所有 /health 探測都失敗
    curl: '#!/bin/sh\nexit 22\n',
    uname: '#!/bin/sh\necho Linux\n',
    // node 會被 spawn_detached 以多行的 -e 腳本呼叫；只記錄第一個參數，
    // 避免整段腳本內容混進 calls.log 讓斷言誤判。
    node: '#!/bin/sh\necho "node $1" >> "$TP_LOG"\nexit 0\n',
    sleep: stub('sleep'),
    pkill: stub('pkill'),
    rm: stub('rm'),
    pgrep: stub('pgrep', oldProcessesAlive ? 0 : 1),
  };
  for (const [name, contents] of Object.entries(stubs)) {
    const path = join(bin, name);
    writeFileSync(path, contents, { mode: 0o755 });
    chmodSync(path, 0o755);
  }

  return { root, home, bin, log, browserBin };
}

function runStart(sandbox) {
  return spawnSync('/bin/sh', [SCRIPT, '--restart'], {
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      HOME: sandbox.home,
      PATH: sandbox.bin,
      TP_LOG: sandbox.log,
      TP_BROWSER_BIN: sandbox.browserBin,
    },
  });
}

const readCalls = (sandbox) =>
  readFileSync(sandbox.log, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');

// 只認「-9 出現在旗標位置」的呼叫。tmpdir 的隨機後綴可能長成 "-9abc"，
// 所以用 includes('-9') 會把
//   pkill -f /tmp/...-9abc/home/.local/share/ego-linux/profile-agent
// 這種一般的 SIGTERM 誤判成 SIGKILL（真實發生過的間歇性偽失敗）。
const isSigkill = (line) => /^pkill\s+-9(\s|$)/.test(line);

test(
  'tp-start waits for the old daemon/profile to exit and escalates before deleting Singleton locks',
  { skip: process.platform === 'win32' },
  (t) => {
    const sandbox = makeSandbox(t, { oldProcessesAlive: true });
    const result = runStart(sandbox);
    const calls = readCalls(sandbox);

    // 舊程序一直活著：仍應以 TP_NOT_READY 收尾，而不是讓 set -e 提早爆掉。
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /TP_NOT_READY/);

    assert.ok(
      calls.some((line) => line.startsWith('pgrep ')),
      `tp-start never polled for the old processes:\n${calls.join('\n')}`,
    );

    const killLines = calls.filter(isSigkill);
    assert.ok(
      killLines.length > 0,
      `tp-start never escalated to SIGKILL:\n${calls.join('\n')}`,
    );

    const lastKill = calls.findLastIndex(isSigkill);
    const lockRemoval = calls.findIndex(
      (line) => line.startsWith('rm ') && line.includes('SingletonLock'),
    );
    assert.ok(
      lockRemoval >= 0,
      `tp-start never removed the profile Singleton lock files:\n${calls.join('\n')}`,
    );
    assert.ok(
      lockRemoval > lastKill,
      `Singleton locks were deleted while the old processes were still alive:\n${calls.join('\n')}`,
    );
  },
);

test(
  'tp-start does not escalate to SIGKILL when the old processes are already gone',
  { skip: process.platform === 'win32' },
  (t) => {
    const sandbox = makeSandbox(t, { oldProcessesAlive: false });
    const result = runStart(sandbox);
    const calls = readCalls(sandbox);

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /TP_NOT_READY/);
    assert.equal(
      calls.filter(isSigkill).length,
      0,
      `unexpected SIGKILL escalation:\n${calls.join('\n')}`,
    );
    assert.ok(
      calls.some((line) => line.startsWith('rm ') && line.includes('SingletonLock')),
      `tp-start did not remove the profile Singleton lock files:\n${calls.join('\n')}`,
    );
  },
);
