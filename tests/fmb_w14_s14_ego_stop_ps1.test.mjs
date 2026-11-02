// ego-stop.ps1 回歸：
// 1. daemon.json 的非整數埠不得被 [int] 四捨五入到別的埠；布林 true 不得變成埠 1。
//    整數值 Double（PS 5.1 ConvertFrom-Json 的正常形態）仍要 flush。
// 2. 終止計數必須反映實際送出 Stop-Process 的支數。管線 ForEach-Object 在
//    Windows PowerShell 5.1 是子範圍，裸的 $Stopped++ 會永遠報 terminated 0；
//    必須寫進 $script:Stopped。失敗字樣不得出現在「仍有存活程序」判斷之前，
//    且 Where-Object 的右大括號要直接接到 | ForEach-Object。
// 測試只覆寫 Invoke-WebRequest / Get-CimInstance / Stop-Process / Start-Sleep，
// 不連線、不殺真程序；暫存檔只在 os.tmpdir()。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../scripts/ego-stop.ps1', import.meta.url));

function clean(text) {
  return String(text ?? '').replace(/\u0000/g, '');
}

function lines(text) {
  return clean(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function pwshOk() {
  const probe = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'Write-Output OK'], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  return probe.status === 0 && clean(probe.stdout).includes('OK');
}

const hasPwsh = pwshOk();

function portCount(flushed, port) {
  const needle = `127.0.0.1:${port}/flush-and-close`;
  return lines(flushed).filter((line) => line.includes(needle)).length;
}

function runStop({ daemonJson = '', procs = [], sticky = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fmb-w14-s14-ego-stop-'));
  const home = join(root, 'home');
  const procsPath = join(root, 'procs.json');
  const killLog = join(root, 'killed.txt');
  const flushLog = join(root, 'flushed.txt');
  const wrapper = join(root, 'wrap.ps1');
  mkdirSync(home, { recursive: true });
  writeFileSync(procsPath, JSON.stringify(procs), 'utf8');
  writeFileSync(killLog, '', 'utf8');
  writeFileSync(flushLog, '', 'utf8');
  writeFileSync(wrapper, `
$ErrorActionPreference = 'Stop'
$parsed = $null
if ($env:EGO_STOP_PROCS -and (Test-Path -LiteralPath $env:EGO_STOP_PROCS)) {
  $parsed = Get-Content -Raw -LiteralPath $env:EGO_STOP_PROCS | ConvertFrom-Json
}
$global:FakeProcs = @()
if ($null -ne $parsed) { $global:FakeProcs = @($parsed) }
if ($env:EGO_STOP_DAEMON_JSON) {
  $dataDir = Join-Path $HOME '.local\\share\\ego-linux'
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $dataDir 'daemon.json'), $env:EGO_STOP_DAEMON_JSON)
}
function Invoke-WebRequest {
  [CmdletBinding()]
  param($Uri, $Method, [switch]$UseBasicParsing, $TimeoutSec)
  Add-Content -LiteralPath $env:EGO_STOP_FLUSHLOG -Value ([string]$Uri) -Encoding utf8
}
function Start-Sleep {
  [CmdletBinding()]
  param($Milliseconds, $Seconds)
}
function Get-CimInstance {
  [CmdletBinding()]
  param([Parameter(Position = 0)]$ClassName)
  foreach ($p in @($global:FakeProcs)) {
    if ($null -ne $p) { Write-Output $p }
  }
}
function Stop-Process {
  [CmdletBinding()]
  param($Id, [switch]$Force)
  Add-Content -LiteralPath $env:EGO_STOP_KILLLOG -Value ([string]$Id) -Encoding utf8
  if ($env:EGO_STOP_STICKY -ne '1') {
    $global:FakeProcs = @($global:FakeProcs | Where-Object { $null -ne $_ -and ([int]$_.ProcessId -ne [int]$Id) })
  }
}
foreach ($cmd in @('Invoke-WebRequest', 'Start-Sleep', 'Get-CimInstance', 'Stop-Process')) {
  $info = Get-Command $cmd
  if ($info.CommandType -ne 'Function') {
    Write-Error "EGO_STOP_SHIM_MISS $cmd $($info.CommandType)"
    exit 2
  }
}
. $env:EGO_STOP_SCRIPT
exit 0
`, 'utf8');
  try {
    const res = spawnSync(
      'pwsh',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapper],
      {
        encoding: 'utf8',
        timeout: 20_000,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          EGO_STOP_SCRIPT: scriptPath,
          EGO_STOP_PROCS: procsPath,
          EGO_STOP_KILLLOG: killLog,
          EGO_STOP_FLUSHLOG: flushLog,
          EGO_STOP_DAEMON_JSON: daemonJson,
          EGO_STOP_STICKY: sticky ? '1' : '',
        },
      },
    );
    return {
      status: res.status,
      stdout: clean(res.stdout),
      stderr: clean(res.stderr),
      killed: lines(readFileSync(killLog, 'utf8')),
      flushed: readFileSync(flushLog, 'utf8'),
      error: res.error ? String(res.error.message ?? res.error) : '',
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const targets = [
  { Name: 'node.exe', ProcessId: 4242, CommandLine: 'C:\\fake\\node.exe C:\\fake\\daemon\\ego-browserd.js' },
  { Name: 'node.exe', ProcessId: 4244, CommandLine: 'C:\\fake\\node.exe C:\\fake\\daemon\\tp-browserd.js --alt-port' },
  { Name: 'brave.exe', ProcessId: 4245, CommandLine: 'C:\\fake\\brave.exe --user-data-dir=C:\\fake\\.local\\share\\ego-linux\\profile-agent' },
  { Name: 'chrome.exe', ProcessId: 1111, CommandLine: 'C:\\fake\\chrome.exe --user-data-dir=C:\\fake\\Chrome\\User Data' },
  { Name: 'notepad.exe', ProcessId: 3333, CommandLine: 'C:\\fake\\notepad.exe C:\\fake\\ego-browserd.js' },
];

test('ego-stop.ps1：來源上拒絕非整數埠，且終止計數不在管線子範圍', () => {
  const src = readFileSync(scriptPath, 'utf8');
  assert.match(src, /if \(\$Cfg\.port\) \{/);
  assert.match(src, /\$RawPort -is \[bool\]/);
  assert.match(src, /\[math\]::Truncate\(\$RawPort\)/);
  assert.match(src, /\[int\]\$Cfg\.port/);
  assert.match(src, /\$CfgPort -ge 1 -and \$CfgPort -le 65535/);
  assert.match(
    src,
    /\}\s*\|\s*ForEach-Object \{\s*Stop-Process -Id \$_\.ProcessId -Force -ErrorAction SilentlyContinue\s*\$script:Stopped\+\+/,
  );
  const guardIdx = src.search(/if\s*\(\s*\$Remaining\.Count\s+-gt\s+0\s*\)/);
  const failIdx = src.indexOf('EGO_STOP_FAILED');
  assert.ok(guardIdx >= 0 && failIdx > guardIdx);
});

test('ego-stop.ps1：只終止 daemon／profile 行程，並報對支數', { skip: hasPwsh ? false : 'pwsh not available' }, () => {
  const res = runStop({ procs: targets });
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}\n${res.error}`);
  assert.match(res.stdout, /EGO_STOPPED \(terminated 3 processes\)/);
  assert.deepEqual(res.killed.map((id) => Number(id)).sort((a, b) => a - b), [4242, 4244, 4245]);
  assert.equal(portCount(res.flushed, 9772), 1);
  assert.equal(portCount(res.flushed, 9774), 1);
});

test('ego-stop.ps1：殺不掉的行程以 EGO_STOP_FAILED 結束且計數不是 0', { skip: hasPwsh ? false : 'pwsh not available' }, () => {
  const res = runStop({
    procs: [
      { Name: 'chrome.exe', ProcessId: 7777, CommandLine: 'C:\\fake\\chrome.exe --user-data-dir=C:\\fake\\.local\\share\\ego-linux\\profile-agent' },
    ],
    sticky: true,
  });
  assert.equal(res.status, 1, `${res.stdout}\n${res.stderr}\n${res.error}`);
  assert.match(res.stdout, /EGO_STOP_FAILED \(terminated 1 processes, 1 still running\)/);
  assert.ok(res.killed.includes('7777'), res.killed.join(','));
});

test('ego-stop.ps1：非整數埠不四捨五入，整數 Double 與字串埠仍 flush', { skip: hasPwsh ? false : 'pwsh not available' }, () => {
  const fractional = runStop({ daemonJson: '{"port":18802.9}' });
  assert.equal(fractional.status, 0, `${fractional.stdout}\n${fractional.stderr}`);
  assert.equal(portCount(fractional.flushed, 18802), 0, fractional.flushed);
  assert.equal(portCount(fractional.flushed, 18803), 0, fractional.flushed);
  assert.equal(portCount(fractional.flushed, 9772), 1);
  assert.equal(portCount(fractional.flushed, 9774), 1);
  assert.match(fractional.stdout, /EGO_STOPPED \(terminated 0 processes\)/);

  const wholeDouble = runStop({ daemonJson: '{"port":18802.0}' });
  assert.equal(wholeDouble.status, 0, `${wholeDouble.stdout}\n${wholeDouble.stderr}`);
  assert.equal(portCount(wholeDouble.flushed, 18802), 1, wholeDouble.flushed);
  assert.equal(portCount(wholeDouble.flushed, 9772), 1);
  assert.equal(portCount(wholeDouble.flushed, 9774), 1);

  const numericString = runStop({ daemonJson: '{"port":" 18802 "}' });
  assert.equal(numericString.status, 0, `${numericString.stdout}\n${numericString.stderr}`);
  assert.equal(portCount(numericString.flushed, 18802), 1, numericString.flushed);

  const alreadyListed = runStop({ daemonJson: '{"port":9772}' });
  assert.equal(alreadyListed.status, 0, `${alreadyListed.stdout}\n${alreadyListed.stderr}`);
  assert.equal(portCount(alreadyListed.flushed, 9772), 1, alreadyListed.flushed);

  const upperBound = runStop({ daemonJson: '{"port":65535}' });
  assert.equal(upperBound.status, 0, `${upperBound.stdout}\n${upperBound.stderr}`);
  assert.equal(portCount(upperBound.flushed, 65535), 1, upperBound.flushed);

  const tooHigh = runStop({ daemonJson: '{"port":65536}' });
  assert.equal(tooHigh.status, 0, `${tooHigh.stdout}\n${tooHigh.stderr}`);
  assert.equal(portCount(tooHigh.flushed, 65536), 0, tooHigh.flushed);
});

test('ego-stop.ps1：布林埠、埠 0、壞 JSON 都不會 flush 錯埠，也不會中止停止流程', { skip: hasPwsh ? false : 'pwsh not available' }, () => {
  for (const daemonJson of ['{"port":true}', '{"port":0}', '{', '']) {
    const res = runStop({ daemonJson });
    assert.equal(res.status, 0, `${daemonJson}\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /EGO_STOPPED \(terminated 0 processes\)/);
    assert.equal(portCount(res.flushed, 1), 0, res.flushed);
    assert.equal(portCount(res.flushed, 9772), 1, res.flushed);
    assert.equal(portCount(res.flushed, 9774), 1, res.flushed);
    assert.deepEqual(res.killed, []);
  }
});
