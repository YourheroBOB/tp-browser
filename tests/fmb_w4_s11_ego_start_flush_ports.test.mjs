// tests/fmb_w4_s11_ego_start_flush_ports.test.mjs
// ego-start.ps1 迴歸測試：第 4 步的 Stop-Process 掃描會終止「所有」ego daemon（9772 與 9774
// 兩套 stack 都可能同時存在），因此關閉前必須對「兩個預設埠」都送出 /flush-and-close；
// 只 flush 即將啟動的那個埠，會讓另一套 stack 的 Chrome 被 -Force 硬殺，導致剛建立的
// cookie / storage 狀態遺失、失去 flush-and-close 的收尾保證。
// 零依賴、零外部網路（只連 127.0.0.1 臨時測試伺服器）、只寫系統暫存目錄（mkdtempSync(tmpdir())）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../scripts/ego-start.ps1', import.meta.url));
const src = readFileSync(scriptPath, 'utf8');

// 只在本機 9772/9774 監聽，把收到的 request 寫進檔案（供被測腳本以獨立程序存取）。
const LISTENER_SRC = `
const http = require('node:http');
const fs = require('node:fs');
const file = process.argv[2];
let up = 0;
function make(port) {
  const s = http.createServer((req, res) => {
    try { fs.appendFileSync(file, port + ' ' + (req.url || '/') + '\\n'); } catch {}
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, chrome: false }));
  });
  s.on('error', () => process.exit(3));
  s.listen(port, '127.0.0.1', () => { if (++up === 2) process.stdout.write('READY\\n'); });
}
make(9772);
make(9774);
setTimeout(() => process.exit(0), 60000);
`;

function pwshOk() {
  const probe = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'Write-Output OK'], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  return probe.status === 0 && String(probe.stdout ?? '').includes('OK');
}

const hasPwsh = pwshOk();

test('ego-start.ps1：關閉既有 stack 前，9772 與 9774 兩個預設埠都要 flush-and-close', () => {
  // 1) 舊寫法（只 flush 目標埠）必須消失。
  assert.equal(
    /\$DaemonPort\/flush-and-close/.test(src),
    false,
    'flush-and-close 不可只打 $DaemonPort：下方的 Stop-Process 會殺掉另一套 daemon 與它的 Chrome',
  );

  // 2) 必須存在同時涵蓋兩個預設埠的 flush 迴圈，且 URL 使用迴圈變數。
  const m = src.match(/foreach\s*\(\s*\$(\w+)\s+in\s*@\(\s*9772\s*,\s*9774\s*\)\s*\)\s*\{([\s\S]{0,400}?)\n\}/);
  assert.ok(m, '找不到 "foreach ($X in @(9772, 9774)) { ... }" 的 flush 迴圈');
  const varName = m[1];
  const body = m[2];
  assert.ok(body.includes('flush-and-close'), 'flush 迴圈內必須呼叫 flush-and-close');
  assert.ok(body.includes(`:$${varName}/flush-and-close`), 'flush URL 必須使用迴圈變數，逐一打每個埠');

  // 3) 順序即安全語意：flush 必須早於 Stop-Process。
  const flushIdx = src.indexOf('flush-and-close');
  const killIdx = src.indexOf('Stop-Process -Id $_.ProcessId');
  assert.ok(flushIdx > -1, '找不到 flush-and-close');
  assert.ok(killIdx > -1, '找不到 Stop-Process -Id $_.ProcessId');
  assert.ok(flushIdx < killIdx, 'flush-and-close 必須在 Stop-Process 之前發生');
});

test(
  'ego-start.ps1（行為）：實際執行時 9772 與 9774 都收到 /flush-and-close',
  { skip: hasPwsh ? false : 'pwsh not available' },
  async (t) => {
    if (process.platform === 'win32') {
      // 在 Windows 上跑這支腳本會真的執行 Get-CimInstance / Stop-Process 掃描，
      // 可能誤殺開發機上正在運行的 ego 程序；改由上面的靜態契約測試守住。
      t.skip('僅在非 Windows 的 pwsh 上做行為驗證');
      return;
    }

    const dir = mkdtempSync(join(tmpdir(), 'fmb-w4-s11-ego-start-'));
    const hits = join(dir, 'hits.txt');
    const helper = join(dir, 'listener.cjs');
    writeFileSync(hits, '');
    writeFileSync(helper, LISTENER_SRC, 'utf8');

    const child = spawn(process.execPath, [helper, hits], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('listener start timeout')), 8000);
          child.stdout.once('data', (buf) => {
            if (String(buf).includes('READY')) {
              clearTimeout(timer);
              resolve();
            }
          });
          child.once('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`listener exited code=${code}`));
          });
        });
      } catch (e) {
        t.skip(`無法在 127.0.0.1:9772/9774 監聽（${e.message}）`);
        return;
      }

      const home = join(dir, 'home');
      const fakeBrowser = join(dir, 'fake-browser.exe');
      // 明顯假值：只用來讓腳本通過第 2 步的「路徑存在」檢查，才會走到第 4 步的 flush。
      writeFileSync(fakeBrowser, 'FAKE_VALUE_FOR_TEST', 'utf8');

      // 逾時 10 秒即中止：flush 在第 4 步就會發生，後面等待 daemon 的迴圈不必跑完。
      spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          LOCALAPPDATA: join(home, 'AppData', 'Local'),
          APPDATA: join(home, 'AppData', 'Roaming'),
          TP_BROWSER_BIN: fakeBrowser,
        },
      });

      const lines = readFileSync(hits, 'utf8').split('\n').filter(Boolean);
      const flushes = lines.filter((l) => l.includes('/flush-and-close'));
      assert.ok(
        flushes.some((l) => l.startsWith('9772 ')),
        `9772 沒收到 flush-and-close；實際收到的請求：${JSON.stringify(lines)}`,
      );
      assert.ok(
        flushes.some((l) => l.startsWith('9774 ')),
        `9774 沒收到 flush-and-close；實際收到的請求：${JSON.stringify(lines)}`,
      );
    } finally {
      child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
