// tests/fmb_w3_s07_tp_start_bin_env.test.mjs
// 回歸測試：TP_BROWSER_BIN 明確設定但不可執行時，tp-start.sh 必須在動到任何程序
// （flush、pkill、spawn daemon、spawn 瀏覽器）之前就以 exit 1 結束，
// 而不是靜默改用 PATH 上探測到的其他瀏覽器。
// 零依賴、零網路：全部使用 tmpdir() 沙箱、stub 執行檔，不讀寫 repo 以外的既定路徑。
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
const COREUTILS = ['dirname', 'mkdir', 'chmod', 'rm', 'grep', 'pwd', 'id', 'uname', 'cat', 'sh'];
const SKIP = process.platform === 'win32' ? 'tp-start.sh 只在 macOS/Linux 執行' : false;

function findExecutable(name) {
  for (const dir of ['/usr/bin', '/bin']) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate);
      return candidate;
    } catch {
      // 換下一個候選路徑
    }
  }
  throw new Error(`required system utility not found: ${name}`);
}

// 建立隔離沙箱：
//   home/          假的 HOME（DATA_DIR、PROFILE_DIR 都在裡面）
//   bin/           唯一 PATH；內含核心工具 symlink 與會記錄呼叫的 stub
//   *.log          stub 的呼叫紀錄
function makeSandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'fmb-w3-s07-tp-start-bin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const logs = {
    pkill: join(root, 'pkill.log'),
    browser: join(root, 'browser.log'),
    node: join(root, 'node.log'),
  };
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  for (const file of Object.values(logs)) writeFileSync(file, '');

  for (const name of COREUTILS) {
    try {
      symlinkSync(findExecutable(name), join(bin, name));
    } catch {
      // 由 shell builtin 提供時可省略
    }
  }

  const stubs = {
    // 若腳本真的進入自動探測（bug 回歸），就會選到這個 stub 並被記錄下來。
    chromium: '#!/bin/sh\nprintf "%s\\n" "$*" >> "$BROWSER_LOG"\nexit 0\n',
    curl: '#!/bin/sh\nexit 22\n',
    pkill: '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PKILL_LOG"\nexit 0\n',
    sleep: '#!/bin/sh\nexit 0\n',
    node: '#!/bin/sh\nprintf "%s\\n" "$@" >> "$NODE_LOG"\nexit 0\n',
  };
  for (const [name, contents] of Object.entries(stubs)) {
    const path = join(bin, name);
    writeFileSync(path, contents, { mode: 0o755 });
    chmodSync(path, 0o755);
  }

  return { root, home, bin, logs };
}

function runStart(sandbox, browserBin) {
  const env = {
    HOME: sandbox.home,
    PATH: sandbox.bin,
    PKILL_LOG: sandbox.logs.pkill,
    BROWSER_LOG: sandbox.logs.browser,
    NODE_LOG: sandbox.logs.node,
  };
  if (browserBin !== undefined) env.TP_BROWSER_BIN = browserBin;

  // --restart：略過 /health 早退，確保每次都走到瀏覽器解析流程。
  return spawnSync('/bin/sh', [SCRIPT, '--restart'], {
    encoding: 'utf8',
    timeout: 5000,
    env,
  });
}

test('TP_BROWSER_BIN 指向不存在的路徑：exit 1、stderr 指名，且不碰任何程序', { skip: SKIP }, (t) => {
  const sandbox = makeSandbox(t);
  const bogus = join(sandbox.root, 'no-such-dir', 'chrome');

  const result = runStart(sandbox, bogus);

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /TP_BROWSER_BIN/);
  assert.ok(result.stderr.includes(bogus), `stderr 應含使用者指定的路徑 ${bogus}：${result.stderr}`);
  assert.equal(readFileSync(sandbox.logs.pkill, 'utf8'), '', 'pkill 不應被呼叫');
  assert.equal(readFileSync(sandbox.logs.browser, 'utf8'), '', 'PATH 上的 chromium stub 不應被啟動');
  assert.equal(readFileSync(sandbox.logs.node, 'utf8'), '', 'node spawn helper 不應被呼叫');
});

test('TP_BROWSER_BIN 指向存在但不可執行的檔案：同樣 exit 1 且不碰任何程序', { skip: SKIP }, (t) => {
  const sandbox = makeSandbox(t);
  const notExecutable = join(sandbox.root, 'chrome-not-executable');
  writeFileSync(notExecutable, '#!/bin/sh\nexit 0\n');
  chmodSync(notExecutable, 0o644);

  const result = runStart(sandbox, notExecutable);

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /TP_BROWSER_BIN/);
  assert.ok(result.stderr.includes(notExecutable), `stderr 應含路徑 ${notExecutable}：${result.stderr}`);
  assert.equal(readFileSync(sandbox.logs.pkill, 'utf8'), '', 'pkill 不應被呼叫');
  assert.equal(readFileSync(sandbox.logs.browser, 'utf8'), '', 'PATH 上的 chromium stub 不應被啟動');
});

test('對照組：TP_BROWSER_BIN 指向可執行的 stub 時，使用該 stub 而非 PATH 上的瀏覽器', { skip: SKIP }, (t) => {
  const sandbox = makeSandbox(t);
  const customDir = join(sandbox.root, 'custom');
  const customBin = join(customDir, 'my-chrome');
  mkdirSync(customDir, { recursive: true });
  writeFileSync(customBin, '#!/bin/sh\nprintf "%s\\n" "$@" >> "$BROWSER_LOG"\nexit 0\n', { mode: 0o755 });
  chmodSync(customBin, 0o755);

  const result = runStart(sandbox, customBin);

  assert.notEqual(result.status, null, 'tp-start.sh 應在測試時限內結束');
  const nodeArgs = readFileSync(sandbox.logs.node, 'utf8').split('\n');
  assert.ok(
    nodeArgs.includes(customBin),
    `spawn helper 應以 ${customBin} 啟動瀏覽器，實際參數：\n${nodeArgs.join('\n')}`,
  );
  assert.ok(
    !nodeArgs.includes(join(sandbox.bin, 'chromium')),
    '不應改用 PATH 上自動探測到的 chromium',
  );
  assert.notEqual(
    readFileSync(sandbox.logs.pkill, 'utf8').trim(),
    '',
    'TP_BROWSER_BIN 有效時應照常 flush/pkill 舊程序',
  );
});
