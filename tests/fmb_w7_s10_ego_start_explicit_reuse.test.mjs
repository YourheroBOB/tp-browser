// tests/fmb_w7_s10_ego_start_explicit_reuse.test.mjs
// w7-s10: ego-start.ps1 明確指定 -Edge / -Chrome 時，若已健康堆疊的主瀏覽器就是該瀏覽器，
// 必須沿用（不再 flush-and-close + Stop-Process -Force 砍掉現有分頁與登入態）；
// 只有在堆疊跑的是另一個瀏覽器時才重啟。另驗 profile-init 收到 EGO_LINUX_DATA_DIR === $DataDir。
// 零依賴、零網路、不連線正式服務；只在 pwsh 存在時執行，否則 skip。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const PS1 = fileURLToPath(new URL('../scripts/ego-start.ps1', import.meta.url));
const PWSH = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
const hasPwsh = !PWSH.error && PWSH.status === 0 && PWSH.stdout.trim() !== '';
const maybe = hasPwsh ? test : test.skip;

const EDGE_BIN = join('C:', 'edge', 'msedge.exe');
const CHROME_BIN = join('C:', 'chrome', 'chrome.exe');

// 在隔離的 fake home 裡產生 scripts/ 與 daemon/，回傳 ego-start.ps1 執行所需的環境與 stub 檔。
function setupFakeHome(browserBin) {
  const root = mkdtempSync(join(tmpdir(), 'fmb-w7-s10-'));
  const home = join(root, 'home');
  const dataDir = join(home, '.local', 'share', 'ego-linux');
  const appDir = join(home, 'app');
  const logs = [];
  mkdirSync(join(dataDir, 'scripts'), { recursive: true });
  mkdirSync(join(dataDir, 'tools'), { recursive: true });
  mkdirSync(join(dataDir, 'logs'), { recursive: true });
  mkdirSync(join(dataDir, 'profile-agent'), { recursive: true });
  mkdirSync(join(appDir, 'daemon'), { recursive: true });
  writeFileSync(join(appDir, 'daemon', 'ego-browserd.js'), '// stub\n', 'utf8');
  writeFileSync(browserBin, 'stub', 'utf8');

  const ua = browserBin.includes('msedge') ? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
  const exe = browserBin.includes('msedge') ? 'msedge.exe' : 'chrome.exe';

  const stubPs1 = `
$ErrorActionPreference = 'SilentlyContinue'
function Invoke-RestMethod {
    param([string]$Uri, [int]$TimeoutSec = 0)
    $logFile = Join-Path $env:EGO_TEST_LOG_DIR 'rest.log'
    Add-Content -Path $logFile -Value $Uri
    if ($Uri -like '*/health') { return [pscustomobject]@{ ok = $true; chrome = $true } }
    if ($Uri -like '*/json/version') {
        return [pscustomobject]@{ 'User-Agent' = '${ua}'; Browser = '${exe}/FAKE_VERSION'; webSocketDebuggerUrl = 'ws://127.0.0.1:1/devtools/page/FAKE' }
    }
    if ($Uri -like '*/flush-and-close') { return [pscustomobject]@{ ok = $true } }
    if ($Uri -like '*/json/list') { return @() }
    return [pscustomobject]@{}
}
function Stop-Process {
    param([int]$Id, [switch]$Force, [string]$ErrorAction)
    Add-Content -Path (Join-Path $env:EGO_TEST_LOG_DIR 'stop.log') -Value "$Id"
}
function Get-CimInstance {
    param([string]$ClassName, [string]$Filter, [scriptblock]$Filter2)
    Add-Content -Path (Join-Path $env:EGO_TEST_LOG_DIR 'cim.log') -Value "$ClassName"
    if ($ClassName -ne 'Win32_Process') { return $null }
    return @([pscustomobject]@{
        Name = '${exe}'; ProcessId = 4242; SessionId = 1
        CommandLine = '${browserBin} --headless=new --user-data-dir=' + (Join-Path $env:EGO_TEST_HOME '.local/share/ego-linux/profile-agent') + ' --remote-debugging-port=9773'
    })
}
function Get-Process { param([int]$Id) return [pscustomobject]@{ SessionId = 1 } }
function Get-Command { param([string]$Name, [string]$ErrorAction) return $null }
function Invoke-CimMethod { param([string]$ClassName, [string]$MethodName, [hashtable]$Arguments) }
function Start-Sleep { param([int]$Milliseconds, [int]$Seconds) }
function Start-Process { param([string]$FilePath, [string]$ArgumentList, [string]$WindowStyle) }
function Set-Content { param([string]$Path, $Value, [string]$Encoding) }
function Test-Path { param([Parameter(Position=0)][string]$Path, [string]$LiteralPath, [switch]$ErrorAction)
    return [Microsoft.PowerShell.Commands.TestPathCommand]::new().Invoke($Path) }
. '${PS1.replace(/'/g, "''")}'
`;
  writeFileSync(join(dataDir, 'scripts', 'ego-start.ps1'), stubPs1.replace(/\r\n/g, '\n'), 'utf8');
  return { root, home, dataDir, appDir };
}

function runEgoStart(home, dataDir, appDir, browserBin, logDir, args) {
  const res = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    join(dataDir, 'scripts', 'ego-start.ps1'), ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      LOCALAPPDATA: join(home, 'AppData', 'Local'),
      TP_BROWSER_BIN: browserBin,
      EGO_TEST_LOG_DIR: logDir,
      EGO_TEST_HOME: home,
      EGO_LINUX_DATA_DIR: dataDir,
    },
  });
  return res;
}

function readLog(logDir, name) {
  const p = join(logDir, name);
  let txt = '';
  try { txt = require('node:fs').readFileSync(p, 'utf8'); } catch {}
  return txt;
}

maybe('-Edge 沿用已健康的同瀏覽器堆疊：EGO_READY、不殺程式、不 flush', async () => {
  const { root, home, dataDir, appDir } = setupFakeHome(EDGE_BIN);
  try {
    const logDir = join(dataDir, 'logs');
    const res = runEgoStart(home, dataDir, appDir, EDGE_BIN, logDir, ['-Edge']);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /EGO_READY/);
    assert.match(res.stdout, /reused=true/);
    assert.equal(readLog(logDir, 'stop.log').trim(), '', 'Stop-Process 絕不被呼叫');
    assert.equal(readLog(logDir, 'rest.log').split('\n').filter((l) => l.includes('flush-and-close')).length, 0, '不得 flush-and-close');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

maybe('沒有 -Edge/-Chrome 的 headless 堆疊也沿用', async () => {
  const { root, home, dataDir, appDir } = setupFakeHome(EDGE_BIN);
  try {
    const logDir = join(dataDir, 'logs');
    const res = runEgoStart(home, dataDir, appDir, EDGE_BIN, logDir, []);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /EGO_READY/);
    assert.equal(readLog(logDir, 'stop.log').trim(), '', 'Stop-Process 絕不被呼叫');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

maybe('堆疊是另一個瀏覽器時，-Chrome 仍走重啟路徑', async () => {
  const { root, home, dataDir, appDir } = setupFakeHome(EDGE_BIN);
  try {
    const logDir = join(dataDir, 'logs');
    const res = runEgoStart(home, dataDir, appDir, CHROME_BIN, logDir, ['-Chrome']);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.ok(/flush-and-close/.test(readLog(logDir, 'rest.log')), '必須 flush-and-close');
    assert.ok(/Stop-Process|Win32_Process/.test(readLog(logDir, 'cim.log')) || readLog(logDir, 'stop.log').trim() !== '', '必須進行程序清理');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

maybe('profile-init 收到 EGO_LINUX_DATA_DIR === $DataDir', async () => {
  const { root, home, dataDir, appDir } = setupFakeHome(EDGE_BIN);
  try {
    const logDir = join(dataDir, 'logs');
    // 讓節點環境可取得：使用程序內 node 的 stub，攔 profile-init 寫檔。
    const marker = join(logDir, 'profile-init-env.txt');
    writeFileSync(join(dataDir, 'tools', 'profile-init.js'),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.env.EGO_LINUX_DATA_DIR || '');\n`, 'utf8');
    const res = runEgoStart(home, dataDir, appDir, EDGE_BIN, logDir, ['-Restart']);
    assert.equal(res.status, 0, res.stderr || res.stdout);
    const recorded = readLog(logDir, 'profile-init-env.txt').trim();
    assert.equal(recorded, dataDir, `profile-init 收到的 EGO_LINUX_DATA_DIR 應為 ${dataDir}，實得 ${recorded}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
>>>>>>> REPLACE
