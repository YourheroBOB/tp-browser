// tests/fmb_w11_s01_ego_browser_empty_script.test.mjs
// 回歸測試：`tp-browser nodejs` 收到「空腳本」時（空 stdin／只有空白的 heredoc／`-e ''`）
// 必須在連線或啟動任何 daemon／瀏覽器之前，就以用法錯誤（exit 2）結束。
//
// 修正前的行為：先跑 ensureRunning()（沒有 daemon 時甚至會執行啟動器去重啟瀏覽器），
// 再「成功」執行一支什麼都不做的腳本並回 exit 0 —— 使用者無法分辨
// 「腳本沒做事」與「內容根本沒送進來」（空 heredoc、`< /dev/null`、被截斷的管線）。
//
// 零網路、零正式服務、零真實憑證：
//   * HOME／USERPROFILE 指向 mkdtemp() 目錄，CLI 讀到的 daemon.json / token 都在該目錄內。
//   * 該目錄內另備「無害假啟動器」，萬一 CLI 真的去 ensureRunning()，也只會跑到那支 exit 0 的
//     shell 腳本，不會啟動瀏覽器、不會連線到任何服務。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const CLI = fileURLToPath(new URL('../bin/ego-browser.js', import.meta.url));
const roots = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fakeHome() {
  const root = mkdtempSync(join(tmpdir(), 'fmb-w11-s01-ego-browser-'));
  roots.push(root);
  const scripts = join(root, '.local', 'share', 'ego-linux', 'app', 'scripts');
  mkdirSync(scripts, { recursive: true });
  for (const name of ['tp-start.sh', 'tp-stop.sh']) {
    const p = join(scripts, name);
    writeFileSync(p, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    chmodSync(p, 0o755);
  }
  return { ...process.env, HOME: root, USERPROFILE: root, TP_DAEMON_PORT: '' };
}

const run = (env, args, extra = {}) =>
  spawnSync(process.execPath, [CLI, 'nodejs', ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env,
    ...extra,
  });

function assertEmptyScriptRejected(res) {
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr=${res.stderr}`);
  assert.match(res.stderr, /script is empty/);
  // 必須在接觸 daemon 之前就結束：不能出現埠號或「連不上」的訊息。
  assert.doesNotMatch(res.stderr, /not reachable/);
  assert.doesNotMatch(res.stderr, /127\.0\.0\.1/);
  assert.doesNotMatch(res.stderr, /failed to run launcher/);
  assert.equal(res.stdout, '');
}

test('nodejs：stdin 完全沒有內容（/dev/null）→ exit 2，且不得先去連線或啟動瀏覽器', () => {
  const res = run(fakeHome(), [], { stdio: ['ignore', 'pipe', 'pipe'] });
  assertEmptyScriptRejected(res);
});

test('nodejs：heredoc／管線只有空白與換行 → exit 2', () => {
  const res = run(fakeHome(), [], { input: '  \n\t\n\n' });
  assertEmptyScriptRejected(res);
});

test('nodejs：只帶 UTF-8 BOM 的輸入 → exit 2', () => {
  const res = run(fakeHome(), [], { input: '\uFEFF' });
  assertEmptyScriptRejected(res);
});

test("nodejs：-e '' → exit 2", () => {
  const res = run(fakeHome(), ['-e', '']);
  assertEmptyScriptRejected(res);
});
