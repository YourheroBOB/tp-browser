// ego-start.ps1：TP_BROWSER_BIN 指向資料夾或非 .exe 檔時，必須在任何 flush-and-close／Stop-Process 之前 exit 1。
// 零依賴。有 pwsh 才跑行為測試；HOME／LOCALAPPDATA 只指向暫存目錄，網路與程序操作全以函式覆寫攔截。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../scripts/ego-start.ps1', import.meta.url));

function pwshOk() {
  const probe = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'Write-Output OK'], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  return probe.status === 0 && String(probe.stdout ?? '').includes('OK');
}

const hasPwsh = pwshOk();

// Global function overrides shadow the cmdlets inside the child script scope.
// Get-CimInstance always reports one live ego browser, so if validation were
// bypassed Stop-Process would be logged; with Start-Sleep stubbed out the
// script ends quickly with "EGO_NOT_READY (profile still in use)".
const HARNESS = [
  'function global:Invoke-RestMethod { [CmdletBinding()] param([string]$Uri, $TimeoutSec) Add-Content -LiteralPath $env:FMB_LOG -Value ("irm " + $Uri); throw "offline (test)" }',
  'function global:Invoke-WebRequest { [CmdletBinding()] param([string]$Uri, $TimeoutSec, $Method, [switch]$UseBasicParsing) Add-Content -LiteralPath $env:FMB_LOG -Value ("iwr " + $Uri); throw "offline (test)" }',
  'function global:Stop-Process { [CmdletBinding()] param([int]$Id, [switch]$Force) Add-Content -LiteralPath $env:FMB_LOG -Value ("stop " + $Id) }',
  'function global:Get-CimInstance { [CmdletBinding()] param([Parameter(Position=0)][string]$ClassName) [pscustomobject]@{ Name = "chrome.exe"; CommandLine = "chrome.exe --user-data-dir=/fake/ego-linux/profile-agent"; ProcessId = 424242; SessionId = 1 } }',
  'function global:Invoke-CimMethod { [CmdletBinding()] param($ClassName, $MethodName, $Arguments) Add-Content -LiteralPath $env:FMB_LOG -Value "cim-create" }',
  'function global:Start-Sleep { [CmdletBinding()] param([Parameter(Position=0)]$Seconds, [int]$Milliseconds) }',
  '& $env:FMB_SCRIPT -Restart',
  'exit $LASTEXITCODE',
].join('\n');

function runWithBin(root, browserBin) {
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const log = join(root, 'calls.log');
  writeFileSync(log, '');
  const res = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', HARNESS], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      LOCALAPPDATA: join(home, 'LocalAppData'),
      APPDATA: join(home, 'AppData'),
      EGO_LINUX_DATA_DIR: join(home, 'data'),
      TP_BROWSER_BIN: browserBin,
      FMB_LOG: log,
      FMB_SCRIPT: scriptPath,
    },
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8') : '';
  return {
    status: res.status,
    stdout: String(res.stdout ?? '').replace(/\u0000/g, ''),
    stderr: String(res.stderr ?? '').replace(/\u0000/g, ''),
    calls,
    error: res.error,
  };
}

test('ego-start.ps1：瀏覽器路徑驗證要求檔案（Leaf）且為 .exe，並在 flush 之前完成', () => {
  const src = readFileSync(scriptPath, 'utf8');
  assert.match(src, /-PathType\s+Leaf/);
  assert.match(src, /-PathType\s+Container/);
  assert.match(src, /GetExtension\(\$Path\)\s+-ine\s+"\.exe"/);
  const check = src.indexOf('Get-BrowserBinProblem -Path $BrowserBin');
  const flush = src.indexOf('/flush-and-close"');
  const stop = src.indexOf('Stop-Process -Id');
  assert.ok(check > 0, 'TP_BROWSER_BIN must be validated with Get-BrowserBinProblem');
  assert.ok(flush > check, 'validation must run before flush-and-close');
  assert.ok(stop > check, 'validation must run before Stop-Process');
});

test('ego-start.ps1：TP_BROWSER_BIN 指向資料夾時 exit 1，不 flush、不 Stop-Process', { skip: hasPwsh ? false : 'pwsh not available' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'fmb-w9-s11-dir-'));
  try {
    const dir = join(root, 'Chrome', 'Application');
    mkdirSync(dir, { recursive: true });
    const r = runWithBin(root, dir);
    assert.equal(r.status, 1, r.stderr || r.stdout || r.error?.message || 'pwsh failed');
    assert.match(r.stderr, /TP_BROWSER_BIN/);
    assert.match(r.stderr, /is a directory/);
    assert.doesNotMatch(r.calls, /flush-and-close/);
    assert.doesNotMatch(r.calls, /^stop /m);
    assert.doesNotMatch(r.calls, /cim-create/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ego-start.ps1：TP_BROWSER_BIN 指向 .txt 檔時 exit 1，不 flush、不 Stop-Process', { skip: hasPwsh ? false : 'pwsh not available' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'fmb-w9-s11-txt-'));
  try {
    const txt = join(root, 'notes.txt');
    writeFileSync(txt, 'FAKE_VALUE_FOR_TEST\n');
    const r = runWithBin(root, txt);
    assert.equal(r.status, 1, r.stderr || r.stdout || r.error?.message || 'pwsh failed');
    assert.match(r.stderr, /TP_BROWSER_BIN/);
    assert.match(r.stderr, /not an \.exe file/);
    assert.doesNotMatch(r.calls, /flush-and-close/);
    assert.doesNotMatch(r.calls, /^stop /m);
    assert.doesNotMatch(r.calls, /cim-create/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ego-start.ps1：TP_BROWSER_BIN 指向合法 .exe 檔時通過驗證並進入停止流程', { skip: hasPwsh ? false : 'pwsh not available' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'fmb-w9-s11-exe-'));
  try {
    const exe = join(root, 'chrome.exe');
    writeFileSync(exe, 'FAKE_VALUE_FOR_TEST');
    const r = runWithBin(root, exe);
    assert.doesNotMatch(r.stderr, /TP_BROWSER_BIN is set to/);
    assert.match(r.calls, /flush-and-close/);
    assert.match(r.calls, /^stop 424242$/m);
    assert.equal(r.status, 1, r.stderr || r.stdout || r.error?.message || 'pwsh failed');
    assert.match(r.stdout, /EGO_NOT_READY \(profile still in use\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
