// tests/fmb_w10_s11_ego_start_node_preflight.test.mjs
//
// scripts/ego-start.ps1 的回歸測試：node.exe 是啟動 ego-browserd.js 的必要條件，
// 所以「ERROR: node.exe not found!」的致命檢查必須早於任何破壞性動作
// （/flush-and-close、Stop-Process 掃描、刪除 SingletonLock）。
//
// 修正前的行為：先把 9772／9774 上的 daemon flush-and-close 並殺掉正在執行的
// daemon/browser，之後才發現根本沒有 node 可以啟動替代的 stack —— 使用者被中斷，
// 而且沒有任何服務可用。這與檔案自己在瀏覽器二元檔驗證處寫下的原則
// （任何檢查都要在 flush-and-close / Stop-Process 之前）互相矛盾。
//
// 零依賴、不連線外部服務：行為測試只綁 127.0.0.1 的臨時 HTTP 伺服器，
// 暫存檔全部在 os.tmpdir() 底下；假值一律使用 FAKE_VALUE_FOR_TEST。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../scripts/ego-start.ps1', import.meta.url));
const scriptSrc = readFileSync(scriptPath, 'utf8');

test('靜態：node.exe 致命檢查必須早於 flush-and-close 與第一次 Stop-Process', () => {
  const nodeCheckAt = scriptSrc.indexOf('ERROR: node.exe not found!');
  const flushAt = scriptSrc.indexOf('/flush-and-close');
  const stopAt = scriptSrc.indexOf('Stop-Process -Id $_.ProcessId -Force');

  assert.ok(nodeCheckAt > 0, '找不到 node.exe 的致命檢查');
  assert.ok(flushAt > 0, '找不到 flush-and-close 呼叫');
  assert.ok(stopAt > 0, '找不到 Stop-Process 掃描');
  assert.ok(nodeCheckAt < flushAt, 'node.exe 檢查必須在 flush-and-close 之前，否則會先破壞既有連線再失敗');
  assert.ok(nodeCheckAt < stopAt, 'node.exe 檢查必須在 Stop-Process 之前，否則會先殺掉執行中的 stack');
});

function resolvePwsh() {
  for (const exe of ['pwsh', 'pwsh.exe']) {
    const probe = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', '(Get-Process -Id $PID).Path'], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    if (probe.status === 0) {
      const resolved = String(probe.stdout ?? '').trim();
      if (resolved) return resolved;
    }
  }
  return null;
}

const pwshBin = resolvePwsh();
const skipReason = !pwshBin
  ? 'pwsh not available'
  : existsSync('C:\\Program Files\\nodejs\\node.exe')
    ? '此機器存在 Windows 慣用 node.exe 路徑，無法模擬 node 遺失'
    : false;

test('行為：node.exe 不存在時，不得對 9772／9774 發出任何 flush-and-close', { skip: skipReason }, async (t) => {
  const hits = [];
  const handler = (req, res) => {
    hits.push(String(req.url ?? ''));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, chrome: false, webSocketDebuggerUrl: '' }));
  };

  const servers = [];
  try {
    for (const port of [9772, 9774]) {
      const srv = await new Promise((resolve, reject) => {
        const s = createServer(handler);
        s.once('error', reject);
        s.listen(port, '127.0.0.1', () => resolve(s));
      });
      servers.push(srv);
    }
  } catch (e) {
    for (const s of servers) await new Promise((r) => s.close(r));
    t.skip(`無法綁定 127.0.0.1:9772/9774（${e && e.code ? e.code : e && e.message}）`);
    return;
  }

  const home = mkdtempSync(join(tmpdir(), 'fmb-w10-s11-ego-start-'));
  try {
    const emptyBin = join(home, 'empty-bin');
    mkdirSync(emptyBin);
    const fakeExe = join(home, 'fake-browser.exe');
    // 只用來通過 Get-BrowserBinProblem 的副檔名／存在性檢查，絕不會被執行。
    writeFileSync(fakeExe, 'FAKE_VALUE_FOR_TEST');

    const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
    const res = spawnSync(
      pwshBin,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      {
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          LOCALAPPDATA: join(home, 'LocalAppData'),
          APPDATA: join(home, 'AppData'),
          TP_BROWSER_BIN: fakeExe,
          // 讓 Get-Command node 找不到 node（真正的節點在測試結束後仍然存在於父程序）。
          [pathKey]: emptyBin,
        },
      },
    );
    const stderr = String(res.stderr ?? '').replace(/\u0000/g, '');

    if (!/node\.exe not found/.test(stderr)) {
      t.skip(`此環境無法模擬 node 遺失（stderr 開頭：${stderr.trim().slice(0, 200)}）`);
      return;
    }

    assert.equal(res.status, 1, stderr || String(res.stdout ?? ''));
    assert.deepEqual(
      hits,
      [],
      `node 不存在時不得呼叫任何 flush-and-close，實際呼叫了：${hits.join(', ')}`,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    for (const s of servers) await new Promise((r) => s.close(r));
  }
});
