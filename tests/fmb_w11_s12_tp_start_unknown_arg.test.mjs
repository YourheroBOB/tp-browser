// tests/fmb_w11_s12_tp_start_unknown_arg.test.mjs
// scripts/tp-start.sh：健康檢查快取分支（health fast-path）與 --restart / --alt-port 旗標的關鍵行為測試。
//
// 覆蓋重點：
// 1. 已健康時的快速就緒（Fast-path ready）：
//    當 daemon 與 Chrome 均健康（/health 回應 "chrome":true）且未要求 --restart 時，
//    tp-start.sh 必須立即輸出 TP_READY 並以 exit 0 退出，絕不呼叫 pkill、也不重置
//    現有 profile/daemon，確保既有 session / tabs / 登入狀態不被中斷。
// 2. --alt-port 模式下的健康檢查快取：
//    驗證健康檢查精準探測 9774 埠，輸出正確對應的 port=9774, chrome=9775。
// 3. --restart 旗標強制繞過快取：
//    即使 /health 判定正常，帶有 --restart 時必須繞過快取，繼續向下執行
//    flush-and-close 與後續重啟流程。
//
// 本測試零外部依賴、零網路連線、零真實程序操作：curl／sleep／pkill／pgrep／node 全部使用
// 隔離暫存目錄中的 stub 模擬，HOME 導向獨立 mkdtempSync() 目錄。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../scripts/tp-start.sh', import.meta.url));
const SH = '/bin/sh';
const runnable = existsSync(SH) && existsSync(scriptPath);
const skip = runnable ? false : '/bin/sh 或 scripts/tp-start.sh 不存在，略過';

const tempRoot = mkdtempSync(join(tmpdir(), 'fmb-w11-s12-tp-start-fastpath-'));
after(() => rmSync(tempRoot, { recursive: true, force: true }));

function writeExecutable(path, body) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`, 'utf8');
  chmodSync(path, 0o755);
}

function prepareRun({ healthy = true } = {}) {
  const workDir = mkdtempSync(join(tempRoot, 'run-'));
  const home = join(workDir, 'home');
  const stubDir = join(workDir, 'stubs');
  const logPath = join(workDir, 'stub.log');
  mkdirSync(home, { recursive: true });
  mkdirSync(stubDir, { recursive: true });

  const curlScript = healthy
    ? `printf 'curl %s\\n' "$*" >> "$STUB_LOG"
for arg in "$@"; do
  case "$arg" in
    *"/health"*)
      printf '{"ok":true,"chrome":true}\\n'
      exit 0
      ;;
    *"/flush-and-close"*)
      exit 0
      ;;
  esac
done
exit 0
`
    : `printf 'curl %s\\n' "$*" >> "$STUB_LOG"; exit 1`;

  writeExecutable(join(stubDir, 'curl'), curlScript);
  writeExecutable(join(stubDir, 'pkill'), `printf 'pkill %s\\n' "$*" >> "$STUB_LOG"; exit 0`);
  writeExecutable(join(stubDir, 'pgrep'), `printf 'pgrep %s\\n' "$*" >> "$STUB_LOG"; exit 1`);
  writeExecutable(join(stubDir, 'node'), `printf 'node %s\\n' "$*" >> "$STUB_LOG"; exit 0`);
  writeExecutable(join(stubDir, 'sleep'), 'exit 0');

  const browser = join(workDir, 'fake-browser');
  writeExecutable(browser, 'exit 0');

  return { workDir, home, stubDir, logPath, browser };
}

function runScript(args, { healthy = true } = {}) {
  const env = prepareRun({ healthy });
  const res = spawnSync(SH, [scriptPath, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      PATH: `${env.stubDir}:/usr/local/bin:/usr/bin:/bin`,
      HOME: env.home,
      STUB_LOG: env.logPath,
      TP_BROWSER_BIN: env.browser,
    },
  });
  const calls = existsSync(env.logPath) ? readFileSync(env.logPath, 'utf8') : '';
  return { res, calls };
}

test('健康檢查快取：已在線時無頭模式立即印出 TP_READY 並結束，不執行 pkill', { skip }, () => {
  const { res, calls } = runScript([], { healthy: true });

  assert.equal(res.status, 0, `status=${res.status} stderr=${res.stderr}`);
  assert.match(String(res.stdout), /^TP_READY \(port=9772, chrome=9773,/);
  assert.match(calls, /curl .*9772\/health/);
  assert.doesNotMatch(calls, /pkill/, '已健康狀態不應執行 pkill 終止既有程序');
  assert.doesNotMatch(calls, /flush-and-close/, '已健康狀態不應要求既有程序關閉');
});

test('健康檢查快取：--alt-port 模式下探測 9774 埠並輸出對應埠位', { skip }, () => {
  const { res, calls } = runScript(['--alt-port'], { healthy: true });

  assert.equal(res.status, 0, `status=${res.status} stderr=${res.stderr}`);
  assert.match(String(res.stdout), /^TP_READY \(port=9774, chrome=9775,/);
  assert.match(calls, /curl .*9774\/health/);
  assert.doesNotMatch(calls, /pkill/);
});

test('--restart 旗標：即使健康檢查正常也必須繞過快取，向下執行 flush 與停止', { skip }, () => {
  const { res, calls } = runScript(['--restart'], { healthy: true });

  // 繞過 fast-path 之後，腳本會執行 flush-and-close 與 pkill
  assert.match(calls, /flush-and-close/, '--restart 模式必須執行 flush-and-close');
  assert.match(calls, /pkill/, '--restart 模式必須執行 pkill');
});
