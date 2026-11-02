// tests/ego_browser_launcher_failure_exit_code.test.mjs
// 回歸測試：`tp-browser nodejs` 需要自動啟動瀏覽器時，若啟動器失敗，
// 必須沿用啟動器的退出碼並把原因留在 stderr，不能吞掉退出碼後改喊
// 「tp-browserd is not reachable / 請先執行 tp-start」再以 exit 2 結束。
//
// 重現方式（修好前）：把 tp-start.sh 換成一個必定失敗的啟動器，對著一個沒有
// daemon 的埠執行 `tp-browser nodejs -e '...'`；舊版輸出「is not reachable」＋ exit 2，
// 使用者因此被叫去重跑剛才失敗的指令，自動化也誤判失敗原因。
//
// 邊界：只用暫存 HOME 與 127.0.0.1 上一個已關閉的埠；不連線任何正式服務、
// 不讀寫 repo 以外的路徑（暫存目錄於 after() 清除），假啟動器只印 FAKE 字串。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';

const CLI = fileURLToPath(new URL('../bin/ego-browser.js', import.meta.url));
const LAUNCHER_EXIT = 7;
const MARKER = 'FAKE_LAUNCHER_FAILED_FOR_TEST';

const tempRoot = mkdtempSync(join(tmpdir(), 'fmb-ego-browser-launcher-failure-'));
after(() => rmSync(tempRoot, { recursive: true, force: true }));

const home = join(tempRoot, 'home');
const dataDir = join(home, '.local', 'share', 'ego-linux');
mkdirSync(join(dataDir, 'app', 'scripts'), { recursive: true });
mkdirSync(join(dataDir, 'scripts'), { recursive: true });

// 兩個平台的啟動器都放假的：非 Windows 走 /bin/sh + tp-start.sh，
// Windows 走 powershell.exe -File ego-start.ps1。兩者都印出 marker 並以 7 結束。
writeFileSync(
  join(dataDir, 'app', 'scripts', 'tp-start.sh'),
  `#!/bin/sh\necho "${MARKER}" >&2\nexit ${LAUNCHER_EXIT}\n`,
  'utf8',
);
writeFileSync(
  join(dataDir, 'scripts', 'ego-start.ps1'),
  `[Console]::Error.WriteLine('${MARKER}')\nexit ${LAUNCHER_EXIT}\n`,
  'utf8',
);

// 取一個「現在沒有東西在聽」的 loopback 埠，讓 /health 立刻失敗，
// 逼 CLI 走「自動啟動」路徑；不使用正式服務、也不依賴 9772/9774 是否被占用。
function closedLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

test('nodejs：自動啟動失敗時沿用啟動器退出碼並保留原因', async () => {
  const port = await closedLoopbackPort();
  // 用 daemon.json（啟動器寫下的埠）指向關閉的埠，而不是 TP_DAEMON_PORT：
  // TP_DAEMON_PORT 明確指定時 CLI 刻意不自動啟動（見 fmb_no_autostart_leak.test.mjs）。
  writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify({ port, chromePort: port }), 'utf8');
  const res = spawnSync(process.execPath, [CLI, 'nodejs', '-e', 'console.log("FAKE_SCRIPT_MUST_NOT_RUN")'], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      TP_DAEMON_PORT: '',
    },
  });

  // 修好前：exit 2（「daemon 連不上」）且 stderr 叫人重跑 tp-start。
  assert.equal(res.status, LAUNCHER_EXIT, `expected launcher exit code, got ${res.status}\nstderr:\n${res.stderr}`);
  assert.match(res.stderr, new RegExp(MARKER), 'the fake launcher must actually have been executed');
  assert.match(res.stderr, /failed to start the browser/, 'the launcher failure must be reported as such');
  assert.doesNotMatch(res.stderr, /is not reachable/, 'must not misreport a failed start as an unreachable daemon');
  assert.doesNotMatch(res.stdout, /FAKE_SCRIPT_MUST_NOT_RUN/, 'the user script must not run when the browser could not be started');
});
