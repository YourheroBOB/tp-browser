// tests/fmb_w12_s12_tp_start_missing_daemon.test.mjs
// 迴歸測試：tp-start.sh 必須在「破壞性動作（flush-and-close／pkill 清掃）之前」驗證
// 它接下來真正要啟動的 runtime（daemon JS 與 node）。舊行為只驗證了瀏覽器二元檔，
// 於是破損／不完整的安裝會：先 flush + pkill 掉使用者原本正在跑的 daemon 與
// profile Chrome → 再 spawn 一個不存在的 daemon JS（錯誤被 detached helper 吞掉）
// → 空轉 10 秒健康檢查 → 最後只吐一行 TP_NOT_READY，完全看不出原因。
//
// 零依賴、零網路、零真實憑證：`--restart` 讓 /health 早退分支不參與；修正後腳本在
// 任何 curl／pkill 之前就結束，所以連 127.0.0.1 都不會連線。所有檔案都在
// mkdtempSync(tmpdir()) 內，測試結束即刪除；不 spawn 任何常駐程序。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../scripts/tp-start.sh', import.meta.url));

test('tp-start.sh：daemon／node 的前置驗證必須排在 flush 與 pkill 之前', () => {
  const src = readFileSync(SRC, 'utf8');

  const firstFlush = src.indexOf('/flush-and-close');
  const firstPkill = src.search(/^pkill /m);
  assert.ok(firstFlush > 0, '預期在腳本中找得到 /flush-and-close 呼叫');
  assert.ok(firstPkill > 0, '預期在腳本中找得到 pkill 呼叫');

  for (const marker of ['daemon script not found', 'node not found in PATH']) {
    const at = src.indexOf(marker);
    assert.ok(at > 0, `缺少 fail-fast 檢查：${marker}`);
    assert.ok(at < firstFlush, `${marker} 必須排在第一次 /flush-and-close 之前`);
    assert.ok(at < firstPkill, `${marker} 必須排在第一次 pkill 之前`);
  }
});

test('tp-start.sh：daemon 腳本缺失時，在 flush／pkill 之前以具名錯誤結束', () => {
  const root = mkdtempSync(join(tmpdir(), 'fmb-w12-s12-tp-start-'));
  try {
    const home = join(root, 'home');
    const scripts = join(root, 'scripts');
    mkdirSync(home, { recursive: true });
    mkdirSync(scripts, { recursive: true });

    // 暫存樹裡只放 scripts/tp-start.sh：SCRIPT_DIR/.. 與
    // $HOME/.local/share/ego-linux/app 底下都沒有 daemon/ego-browserd.js，
    // 藉此重現「只複製 scripts/ 的不完整安裝」。
    const script = join(scripts, 'tp-start.sh');
    copyFileSync(SRC, script);
    chmodSync(script, 0o755);

    // 讓瀏覽器探測通過，確保唯一可能的失敗原因是 daemon 缺失。
    const fakeBrowser = join(root, 'fake-browser');
    writeFileSync(fakeBrowser, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(fakeBrowser, 0o755);

    const startedAt = Date.now();
    const res = spawnSync('sh', [script, '--restart'], {
      encoding: 'utf8',
      timeout: 60_000,
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        TP_BROWSER_BIN: fakeBrowser,
        TP_START_PROC_VERSION: join(root, 'no-such-proc-version'),
        TP_START_WIN_PS: join(root, 'no-such-powershell'),
        TP_START_WIN_USERS: join(root, 'no-such-users'),
      },
    });
    const elapsed = Date.now() - startedAt;
    const stdout = String(res.stdout ?? '');
    const stderr = String(res.stderr ?? '');

    assert.equal(res.status, 1, `status=${res.status} stdout=${stdout} stderr=${stderr}`);
    assert.match(stderr, /daemon script not found/);
    assert.match(stderr, /Nothing was flushed, stopped or launched/);
    // 舊行為只會吐 TP_NOT_READY，看不出是 daemon 缺失。
    assert.doesNotMatch(stderr, /TP_NOT_READY/);
    assert.equal(stdout.trim(), '');
    // 舊行為要先空等 10 秒健康檢查輪詢；修正後應立即失敗。
    assert.ok(elapsed < 8_000, `應立即失敗，實際耗時 ${elapsed}ms`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
