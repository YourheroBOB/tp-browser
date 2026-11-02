// tests/fmb_w11_s11_ego_start_flush_cfg.test.mjs
// 回歸測試（w11 / s11）：scripts/ego-start.ps1 的 flush 名單漏掉 daemon.json 指定的自訂 daemon 埠。
// 背景：step 4 的 flush 之後，Stop-Process 掃描會終止「所有」ego daemon（不分埠），
// 因此自訂埠的 stack 會被硬殺而沒有機會 flush cookie / storage。ego-stop.ps1 早就為此讀
// daemon.json，ego-start.ps1 沒有 → 真實的錯誤處理缺口。
// 本測試零依賴、零網路；只在 os.tmpdir() 內建立 daemon.json 測試檔，結束即刪除。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../scripts/ego-start.ps1', import.meta.url));
const src = readFileSync(scriptPath, 'utf8');

// 從腳本原始碼取出單一頂層函式（到下一個第 0 欄的 "}" 為止），以便獨立執行驗證。
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  if (start < 0) return null;
  const end = source.indexOf('\n}', start);
  if (end < 0) return null;
  return source.slice(start, end + 2);
}

test('ego-start.ps1：自訂 daemon 埠必須在 Stop-Process 掃描前被 flush（靜態）', () => {
  assert.match(src, /function\s+Get-FlushPorts\s*\(/, 'Get-FlushPorts 未定義');
  assert.match(
    src,
    /foreach\s*\(\s*\$FlushPort\s+in\s+@\(9772,\s*9774\)\s*\)/,
    '既有 9772/9774 flush 不可移除',
  );
  assert.match(
    src,
    /Get-FlushPorts\s+-DaemonJsonPath\s+\(Join-Path\s+\$DataDir\s+"daemon\.json"\)/,
    'flush 名單必須包含 daemon.json 的自訂埠',
  );

  const cfgFlush = src.indexOf('Get-FlushPorts -DaemonJsonPath');
  // Search for the actual process termination command, not earlier comments
  // that mention the Stop-Process sweep.
  const sweep = src.indexOf('Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue');
  assert.ok(cfgFlush > 0, 'flush 區塊沒有使用 Get-FlushPorts');
  assert.ok(sweep > 0, '找不到 Stop-Process 掃描');
  assert.ok(cfgFlush < sweep, '自訂埠 flush 必須早於 Stop-Process 掃描');
});

test('ego-start.ps1：Get-FlushPorts 對壞檔／重複埠／越界埠都要安全回退', (t) => {
  const fn = extractFunction(src, 'Get-FlushPorts');
  assert.ok(fn, '無法從 ego-start.ps1 取出 Get-FlushPorts');

  const dir = mkdtempSync(join(tmpdir(), 'fmb-w11-s11-ego-flush-'));
  try {
    writeFileSync(join(dir, 'custom.json'), JSON.stringify({ port: 18802, chromePort: 18800 }), 'utf8');
    writeFileSync(join(dir, 'strport.json'), JSON.stringify({ port: '18802' }), 'utf8');
    writeFileSync(join(dir, 'dup.json'), JSON.stringify({ port: 9772 }), 'utf8');
    writeFileSync(join(dir, 'oor.json'), JSON.stringify({ port: 70000 }), 'utf8');
    writeFileSync(join(dir, 'zero.json'), JSON.stringify({ port: 0 }), 'utf8');
    writeFileSync(join(dir, 'broken.json'), '{"port": ', 'utf8');
    writeFileSync(join(dir, 'empty.json'), '', 'utf8');
    writeFileSync(join(dir, 'array.json'), '[1,2]', 'utf8');

    const q = (name) => `(Join-Path $p '${name}')`;
    const cmd = [
      fn,
      `$p = '${dir.replace(/'/g, "''")}'`,
      '$r = @()',
      `$r += ((Get-FlushPorts -DaemonJsonPath ${q('missing.json')}) -join ',')`,
      `$r += ((Get-FlushPorts -DaemonJsonPath ${q('custom.json')}) -join ',')`,
      `$r += ((Get-FlushPorts -DaemonJsonPath ${q('strport.json')}) -join ',')`,
      `$r += ((Get-FlushPorts -DaemonJsonPath ${q('dup.json')}) -join ',')`,
      `$r += ((Get-FlushPorts -DaemonJsonPath ${q('oor.json')}) -join ',')`,
      `$r += ((Get-FlushPorts -DaemonJsonPath ${q('zero.json')}) -join ',')`,
      `$r += ((Get-FlushPorts -DaemonJsonPath ${q('broken.json')}) -join ',')`,
      `$r += ((Get-FlushPorts -DaemonJsonPath ${q('empty.json')}) -join ',')`,
      `$r += ((Get-FlushPorts -DaemonJsonPath ${q('array.json')}) -join ',')`,
      `$r -join '|'`,
    ].join('\n');

    const res = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
      encoding: 'utf8',
      timeout: 25_000,
    });
    if (res.error && res.error.code === 'ENOENT') {
      t.skip('pwsh not available');
      return;
    }
    assert.equal(res.status, 0, String(res.stderr ?? '') || String(res.error?.message ?? ''));

    const rows = String(res.stdout ?? '').trim().split('|');
    assert.deepEqual(rows, [
      '9772,9774', // 檔案不存在 → 內建埠對
      '9772,9774,18802', // 自訂埠（數字）
      '9772,9774,18802', // 自訂埠（字串）
      '9772,9774', // 與內建埠重複 → 不重複 flush
      '9772,9774', // 70000 越界 → 回退
      '9772,9774', // 0 → 回退
      '9772,9774', // 壞 JSON → 回退
      '9772,9774', // 空檔 → 回退
      '9772,9774', // JSON 陣列 → 回退
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
