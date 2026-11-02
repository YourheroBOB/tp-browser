// tests/fmb_w13_s04_ego_browserd_dir_perms.test.mjs
//
// 回歸測試：daemon/ego-browserd.js 啟動時必須把「既有、權限較鬆」的資料根目錄、
// downloads/ 與 daemon.json 收斂成文件承諾的 0700 / 0600。
//
// 為什麼會壞：mkdirSync(dir, { mode: 0o700 }) 與 writeFileSync(file, data, { mode: 0o600 })
// 的 mode 只在「新建」時才生效；舊版安裝器、不同 umask 或前一次啟動留下的 0755 目錄 /
// 0644 檔案不會被修正。資料根目錄內含 profile-agent 的登入態 Cookie、auth token、
// spaces.json（分頁 URL／title）與登入後下載的檔案，因此這是實際的本機隱私缺口。
//
// 測試策略：只驗證「啟動期的檔案副作用」，並且刻意做到零 socket 足跡，避免與同一個
// `node --test` 平行執行的 tp-start／tp-stop 測試互相干擾：
//   1. 以 `node --input-type=module -e <bootstrap>` 載入 daemon；bootstrap 把
//      `http.Server.prototype.listen` 換成 no-op，因此永遠不會綁定 9772／9774。
//   2. bootstrap 同時停用 `fetch`，daemon 不會嘗試連線 9773／9775 的 Chromium。
//   3. 子行程的 argv 不含 `ego-browserd`／`profile-agent` 字樣（daemon 路徑走環境變數
//      傳入），不會被其他測試的 `pgrep`／`pkill -f` 誤配。
//   4. 一看到 daemon.json 被本次行程的 pid 覆寫就立刻終止，佔用時間只有數十毫秒。
// 不呼叫任何需要認證的 RPC、不連線任何正式服務；所有檔案都在 mkdtempSync(tmpdir())；
// 憑證一律使用明顯假值。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DAEMON_URL = pathToFileURL(fileURLToPath(new URL('../daemon/ego-browserd.js', import.meta.url))).href;
const FAKE_TOKEN = 'FAKE_VALUE_FOR_TEST_legacy_token';
const SKIP_ON_WIN = process.platform === 'win32' ? 'Windows 無 POSIX mode bits，略過' : false;

// 只跑 daemon 的啟動期初始化（建目錄、寫 token／daemon.json、收斂權限），
// 不綁埠、不對外連線、載入完成即自行結束。
const BOOTSTRAP = `
import { Server } from 'node:http';
Server.prototype.listen = function listenDisabledForTest() { return this; };
globalThis.fetch = () => Promise.reject(new Error('network disabled in test'));
await import(process.env.FMB_W13_S04_DAEMON);
process.exit(0);
`;

const homesToClean = [];
after(() => {
  for (const dir of homesToClean) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function modeBits(p) { return statSync(p).mode & 0o777; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 啟動 daemon 並等到它把 daemon.json 覆寫成「本次子行程 pid」，之後立刻終止。
// 回傳是否觀察到覆寫；權限與內容由呼叫端斷言。
async function runDaemonStartup(home, dataDir) {
  const daemonJsonPath = join(dataDir, 'daemon.json');
  const child = spawn(process.execPath, ['--input-type=module', '-e', BOOTSTRAP], {
    cwd: home,
    stdio: 'ignore',
    env: { HOME: home, USERPROFILE: home, FMB_W13_S04_DAEMON: DAEMON_URL },
  });
  let rewritten = false;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      if (JSON.parse(readFileSync(daemonJsonPath, 'utf8')).pid === child.pid) { rewritten = true; break; }
    } catch {}
    await sleep(10);
  }
  try { child.kill('SIGKILL'); } catch {}
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', resolve);
    setTimeout(resolve, 5000).unref?.();
  });
  return rewritten;
}

test('ego-browserd 啟動時把既有寬鬆權限的資料目錄、downloads 與 daemon.json 收斂為 0700/0600', { skip: SKIP_ON_WIN }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'fmb-w13-s04-home-'));
  homesToClean.push(home);
  const dataDir = join(home, '.local', 'share', 'ego-linux');
  const downloadsDir = join(dataDir, 'downloads');
  const tokenPath = join(dataDir, 'token');
  const daemonJsonPath = join(dataDir, 'daemon.json');

  // 前置條件：模擬「舊版安裝器／不同 umask 留下」的寬鬆權限。
  mkdirSync(downloadsDir, { recursive: true });
  for (const p of [dataDir, downloadsDir]) chmodSync(p, 0o755);
  writeFileSync(tokenPath, FAKE_TOKEN, 'utf8');
  chmodSync(tokenPath, 0o644);
  writeFileSync(daemonJsonPath, JSON.stringify({ port: 1, chromePort: 1, pid: 1, startedAt: 'stale' }), 'utf8');
  chmodSync(daemonJsonPath, 0o644);

  assert.equal(modeBits(dataDir), 0o755, '前置條件：資料根目錄起始為 0755');
  assert.equal(modeBits(downloadsDir), 0o755, '前置條件：downloads 起始為 0755');
  assert.equal(modeBits(daemonJsonPath), 0o644, '前置條件：daemon.json 起始為 0644');

  const rewritten = await runDaemonStartup(home, dataDir);
  assert.equal(rewritten, true, 'daemon 應在啟動期覆寫 daemon.json（內容含本次子行程 pid）');

  assert.equal(modeBits(dataDir), 0o700,
    '資料根目錄必須收斂為 0700（內含 profile-agent 登入態、token、spaces.json）');
  assert.equal(modeBits(downloadsDir), 0o700,
    'downloads 目錄必須收斂為 0700（可能含登入後下載的私人檔案）');
  assert.equal(modeBits(daemonJsonPath), 0o600, 'daemon.json 必須收斂為 0600');
  assert.equal(modeBits(tokenPath), 0o600, '既有的非空 token 檔必須被收斂為 0600');

  const info = JSON.parse(readFileSync(daemonJsonPath, 'utf8'));
  assert.notEqual(info.startedAt, 'stale', 'daemon.json 內容應由本次啟動重寫');
  assert.equal(info.port, 9772, '預設埠應為 daemon 9772');
  assert.equal(info.chromePort, 9773, '預設埠應為 Chromium CDP 9773');
  assert.equal(readFileSync(tokenPath, 'utf8'), FAKE_TOKEN, '既有的非空 token 應沿用，不重新產生');
});
