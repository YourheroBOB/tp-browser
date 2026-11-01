// ego-start.ps1：未安裝時 daemon 應退回 repo；致命錯誤不得被 SilentlyContinue 吞掉。
// 零依賴。有 pwsh 時 HOME／LOCALAPPDATA／TP_BROWSER_BIN 都只指向暫存目錄。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../scripts/ego-start.ps1', import.meta.url));

const FATAL = [
  'ERROR: No Chrome or Edge binary found on this Windows machine!',
  'ERROR: node.exe not found!',
];

function fatalLineIsVisible(src, message) {
  const line = src.split(/\r?\n/).find((l) => l.includes(message));
  if (!line) return false;
  if (line.includes('[Console]::Error.WriteLine')) return true;
  return /Write-Error\b/.test(line) && /-ErrorAction\s+Continue/.test(line);
}

function pwshOk() {
  const probe = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'Write-Output OK'], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  return probe.status === 0 && String(probe.stdout ?? '').includes('OK');
}

const hasPwsh = pwshOk();

test('ego-start.ps1：daemon 退回 PSScriptRoot，致命錯誤不受 SilentlyContinue 影響', () => {
  const src = readFileSync(scriptPath, 'utf8');
  assert.match(src, /\$ErrorActionPreference\s*=\s*["']SilentlyContinue["']/);
  assert.match(
    src,
    /\$DaemonJs\s*=\s*Join-Path\s+\$DataDir\s+"daemon\\ego-browserd\.js"[\s\S]*?if\s*\(\s*-not\s*\(\s*Test-Path\s+\$DaemonJs\s*\)\s*\)\s*\{[\s\S]*?Join-Path\s+\(\s*Split-Path\s+\$PSScriptRoot\s+-Parent\s*\)\s+"daemon\\ego-browserd\.js"/,
  );
  for (const message of FATAL) {
    assert.equal(fatalLineIsVisible(src, message), true, message);
  }
});

test('ego-start.ps1：pwsh 下找不到瀏覽器時 exit 1 且 stderr 含 No Chrome', { skip: hasPwsh ? false : 'pwsh not available' }, () => {
  const home = mkdtempSync(join(tmpdir(), 'fmb-w1-s12-ego-start-'));
  try {
    const res = spawnSync(
      'pwsh',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      {
        encoding: 'utf8',
        timeout: 25_000,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          LOCALAPPDATA: join(home, 'LocalAppData'),
          APPDATA: join(home, 'AppData'),
          TP_BROWSER_BIN: join(home, 'missing-browser'),
        },
      },
    );
    const stderr = String(res.stderr ?? '').replace(/\u0000/g, '');
    assert.equal(res.status, 1, stderr || String(res.stdout ?? '') || res.error?.message || 'pwsh failed');
    assert.match(stderr, /No Chrome/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
