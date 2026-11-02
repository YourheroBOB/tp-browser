// tests/tp_browserd_token_file_permissions.test.mjs
// 回歸測試：daemon/tp-browserd.js 必須把自己信任的 token 檔鎖成 0600。
//
// Bug（修好前）：ensureToken() 只在「新建」token 檔時帶 mode 0o600，而
// writeFileSync() 的 mode 對「已存在」的檔案不生效。因此當 token 檔是由其他
// 工具以寬鬆權限留下的（手動 `touch token`、備份還原、舊版啟動腳本、安裝腳本
// chmod 之前的時間窗），daemon 會照單全收：
//   * 既有且非空的 token → 權限原封不動（例如 0644）＝同機其他使用者可讀；
//   * 空 token 被重新產生時 → 內容換新，但舊檔的寬鬆權限仍被沿用。
// token 是 daemon 唯一的認證祕密（/rpc、/events 全靠它），等同把整個本機瀏覽器
// （含登入態 Cookie）授權給同機其他使用者。
//
// 修好後：不論走「沿用既有 token」或「重新產生 token」哪條路徑，權限都會被收斂
// 為 0600，且有效的既有 token 不會被輪替。
//
// 測試設計：只使用 tmpdir() 隔離的 HOME 與本機子程序；不連線任何正式服務；
// 憑證一律使用明顯假值 FAKE_VALUE_FOR_TEST。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const DAEMON = fileURLToPath(new URL('../daemon/tp-browserd.js', import.meta.url));
const FAKE_TOKEN = 'FAKE_VALUE_FOR_TEST';
const roots = [];

after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function dataDirOf(home) {
  return join(home, '.local', 'share', 'ego-linux');
}

function modeOf(p) {
  return statSync(p).mode & 0o777;
}

// 建立「data 目錄已存在、token 檔已存在且權限寬鬆」的 HOME，
// 模擬安裝腳本／備份還原／舊版 daemon 留下的 token。
function makeHomeWithToken(contents) {
  const home = mkdtempSync(join(tmpdir(), 'fmb-tpd-tokenperm-'));
  roots.push(home);
  const dataDir = dataDirOf(home);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const tokenPath = join(dataDir, 'token');
  writeFileSync(tokenPath, contents, { mode: 0o644 });
  chmodSync(tokenPath, 0o644); // 明確設定，避免 umask 影響前置條件
  return { home, dataDir, tokenPath };
}

function spawnDaemon(home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.EGO_BROWSERD_PORT; // 不讓外部環境把 daemon 導到 alt 埠，保持測試決定性
  return spawn(process.execPath, [DAEMON], { stdio: 'ignore', env });
}

async function waitFor(pred, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let v;
    try { v = pred(); } catch { v = undefined; }
    if (v) return v;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
}

// daemon.json 是在 ensureToken() 之後同步寫出的啟動里程碑，因此它的出現可證明
// token 處理已完成（不依賴 daemon 是否搶到 9772 埠，避開平行測試競爭）。
async function waitDaemonStartup(dataDir) {
  return waitFor(() => existsSync(join(dataDir, 'daemon.json')));
}

test('daemon adopts an existing token file but tightens its permissions to 0600', { skip: process.platform === 'win32' }, async () => {
  const { home, dataDir, tokenPath } = makeHomeWithToken(FAKE_TOKEN);
  assert.equal(modeOf(tokenPath), 0o644, 'precondition: 故意留下寬鬆權限的 token');

  const child = spawnDaemon(home);
  try {
    const started = await waitDaemonStartup(dataDir);
    assert.ok(started, 'daemon 未完成啟動流程（找不到 daemon.json）');
    assert.equal(readFileSync(tokenPath, 'utf8').trim(), FAKE_TOKEN, '有效的既有 token 不應被輪替');
    assert.equal(modeOf(tokenPath), 0o600, 'daemon 沿用的 token 檔權限必須收斂為 0600');
  } finally {
    child.kill('SIGKILL');
  }
});

test('daemon regenerates an empty token file and writes it with 0600 permissions', { skip: process.platform === 'win32' }, async () => {
  const { home, dataDir, tokenPath } = makeHomeWithToken('');
  assert.equal(modeOf(tokenPath), 0o644, 'precondition: 空檔但權限寬鬆的 token');

  const child = spawnDaemon(home);
  try {
    const started = await waitDaemonStartup(dataDir);
    assert.ok(started, 'daemon 未完成啟動流程（找不到 daemon.json）');
    const token = readFileSync(tokenPath, 'utf8').trim();
    assert.ok(token.length > 0, '空 token 必須被重新產生');
    assert.equal(modeOf(tokenPath), 0o600, '重新產生的 token 檔權限必須是 0600');
  } finally {
    child.kill('SIGKILL');
  }
});
