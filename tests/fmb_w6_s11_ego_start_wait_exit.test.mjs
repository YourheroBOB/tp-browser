// ego-start.ps1：Stop-Process 之後必須確認舊程序已結束，才可刪 Singleton 鎖並啟動新程序。
// 零依賴、零網路。有 pwsh 時以函式覆寫 Get-CimInstance／Stop-Process／Remove-Item／
// Invoke-CimMethod／Start-Process／Invoke-RestMethod／Start-Sleep／Get-Command 並記錄呼叫；
// HOME／LOCALAPPDATA／TP_BROWSER_BIN 都只指向暫存目錄。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

function wrapperSource({ logPath, busyCalls }) {
  return `
$ErrorActionPreference = 'Stop'
$global:FakeLogPath = ${psq(logPath)}
$global:FakeBusyCalls = ${busyCalls}
$global:FakeCimCalls = 0
$FakeProfileDir = Join-Path (Join-Path $HOME ".local\\share\\ego-linux") "profile-agent"
New-Item -ItemType Directory -Force -Path $FakeProfileDir | Out-Null
New-Item -ItemType File -Force -Path (Join-Path $FakeProfileDir "SingletonLock") | Out-Null

function Write-FakeLog([string]$Line) { Add-Content -LiteralPath $global:FakeLogPath -Value $Line }

function Get-CimInstance {
    $global:FakeCimCalls++
    Write-FakeLog ("Get-CimInstance " + $global:FakeCimCalls)
    if ($global:FakeBusyCalls -lt 0 -or $global:FakeCimCalls -le $global:FakeBusyCalls) {
        [pscustomobject]@{
            Name = 'msedge.exe'
            ProcessId = 4242
            SessionId = 1
            CommandLine = '"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe" --user-data-dir=C:\\Users\\fake\\.local\\share\\ego-linux\\profile-agent'
        }
    }
}
function Stop-Process { Write-FakeLog ("Stop-Process " + ($args -join ' ')) }
function Remove-Item { Write-FakeLog ("Remove-Item " + ($args -join ' ')) }
function Invoke-CimMethod { Write-FakeLog ("Invoke-CimMethod " + ($args -join ' ')) }
function Start-Process { Write-FakeLog ("Start-Process " + ($args -join ' ')) }
function Invoke-RestMethod { Write-FakeLog ("Invoke-RestMethod " + ($args -join ' ')); throw "FAKE_VALUE_FOR_TEST offline" }
function Start-Sleep { }
function Get-Command { [pscustomobject]@{ Source = 'FakeNodeForTest' } }
function FakeNodeForTest { Write-FakeLog ("FakeNode " + ($args -join ' ')) }

& ${psq(scriptPath)} -Restart
exit $LASTEXITCODE
`;
}

function runScenario(busyCalls) {
  const root = mkdtempSync(join(tmpdir(), 'fmb-w6-s11-ego-start-'));
  try {
    const home = join(root, 'home');
    const logPath = join(root, 'calls.log');
    const browser = join(root, 'msedge.exe');
    const wrapper = join(root, 'run.ps1');
    writeFileSync(browser, 'FAKE_VALUE_FOR_TEST', 'utf8');
    writeFileSync(logPath, '', 'utf8');
    writeFileSync(wrapper, wrapperSource({ logPath, busyCalls }), 'utf8');

    const res = spawnSync(
      'pwsh',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapper],
      {
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          LOCALAPPDATA: join(home, 'LocalAppData'),
          APPDATA: join(home, 'AppData'),
          TP_BROWSER_BIN: browser,
        },
      },
    );
    const calls = existsSync(logPath)
      ? readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean)
      : [];
    return {
      status: res.status,
      stdout: String(res.stdout ?? '').replace(/\u0000/g, ''),
      stderr: String(res.stderr ?? '').replace(/\u0000/g, ''),
      error: res.error,
      calls,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const indexes = (calls, re) => calls.map((c, i) => (re.test(c) ? i : -1)).filter((i) => i >= 0);

test('ego-start.ps1：殘留程序判定在刪鎖之前', () => {
  const src = readFileSync(scriptPath, 'utf8');
  const notReady = src.indexOf('EGO_NOT_READY (profile still in use)');
  const lockRemoval = src.indexOf('@("SingletonLock"');
  assert.notEqual(notReady, -1, 'missing profile-still-in-use exit');
  assert.notEqual(lockRemoval, -1);
  assert.ok(notReady < lockRemoval, 'residual-process check must come before Singleton lock removal');
});

test('ego-start.ps1：舊瀏覽器一直不結束時不刪鎖、不啟動，exit 1', { skip: hasPwsh ? false : 'pwsh not available' }, () => {
  const r = runScenario(-1);
  const diag = `${r.stdout}\n${r.stderr}\n${r.error?.message ?? ''}\n${r.calls.join('\n')}`;
  assert.equal(r.status, 1, diag);
  assert.match(r.stdout, /EGO_NOT_READY \(profile still in use\)/, diag);
  assert.ok(indexes(r.calls, /^Stop-Process /).length > 1, `Stop-Process should be retried\n${diag}`);
  assert.deepEqual(indexes(r.calls, /^Remove-Item /), [], diag);
  assert.deepEqual(indexes(r.calls, /^Invoke-CimMethod .*Create/), [], diag);
  assert.deepEqual(indexes(r.calls, /^Start-Process /), [], diag);
  assert.deepEqual(indexes(r.calls, /^FakeNode /), [], diag);
});

test('ego-start.ps1：舊瀏覽器在期限內結束後才刪鎖並啟動', { skip: hasPwsh ? false : 'pwsh not available' }, () => {
  const r = runScenario(3);
  const diag = `${r.stdout}\n${r.stderr}\n${r.error?.message ?? ''}\n${r.calls.join('\n')}`;
  assert.doesNotMatch(r.stdout, /profile still in use/, diag);

  const stops = indexes(r.calls, /^Stop-Process /);
  const removes = indexes(r.calls, /^Remove-Item .*SingletonLock/);
  const creates = indexes(r.calls, /^Invoke-CimMethod .*Create/);
  assert.equal(stops.length, 3, diag);
  assert.equal(removes.length, 1, diag);
  assert.equal(creates.length, 2, diag);
  assert.ok(stops.at(-1) < removes[0], `lock removed before old process exited\n${diag}`);
  assert.ok(removes[0] < creates[0], diag);

  // 健康檢查被 mock 成離線，最後應落到一般的 EGO_NOT_READY。
  assert.equal(r.status, 1, diag);
  assert.match(r.stdout, /EGO_NOT_READY/, diag);
});
