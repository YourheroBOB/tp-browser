// tests/fmb_w11_s14_ego_stop_ps1_verify.test.mjs
// 回歸測試：scripts/ego-stop.ps1 在「最後一次強制終止之後」必須重新查詢程序狀態才能判定成敗。
//
// base 的 bug：
//   ego-stop.ps1 的重試迴圈是「查詢 → 非空就 Stop-Process -Force → 等 300ms」，共 10 輪。
//   Stop-Process -Force 只送出終止訊號；chrome.exe（多子程序）或被其他 shell 回收中的
//   程序，從系統消失的時間可能比最後一輪的 300ms 更久。此時迴圈結束、$Remaining 仍是
//   終止前拍下的快照，腳本就把一次其實成功的 stop 印成失敗訊息並 exit 1。
//   scripts/tp-stop.sh 已針對同一類 bug 修過（kill 後 bounded wait 再判定），ego-stop.ps1 沒有。
//
// 測試策略（零網路、零真實程序終止）：
//   1) 靜態：最終查詢必須存在，且發生在最後一次 Stop-Process 之後（沒有 pwsh 也能跑）。
//   2) 有 pwsh 時：以函式覆寫 Get-CimInstance / Stop-Process / Start-Sleep /
//      Invoke-WebRequest，再 dot-source ego-stop.ps1 做行為驗證。不會終止任何真實程序，
//      也不會發出任何 HTTP 請求（flush-and-close 端點被 stub 掉）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/ego-stop.ps1', import.meta.url));
const source = readFileSync(SCRIPT, 'utf8');

test('ego-stop.ps1 靜態：最後一次 Stop-Process 之後必須重新查詢程序狀態', () => {
  const failureIdx = source.indexOf('Write-Output "EGO_STOP_FAILED');
  assert.ok(failureIdx > 0, '找不到 EGO_STOP_FAILED 的失敗輸出分支');

  const loopIdx = source.indexOf('for ($Attempt');
  assert.ok(loopIdx > 0, '找不到重試迴圈');
  assert.ok(loopIdx < failureIdx, '重試迴圈必須在失敗判定之前');

  const between = source.slice(loopIdx, failureIdx);
  const queries = between.match(/Get-CimInstance\s+Win32_Process/g) ?? [];
  assert.ok(
    queries.length >= 2,
    `重試迴圈與失敗判定之間只有 ${queries.length} 次 Get-CimInstance 查詢；` +
      '終止後必須重新查詢，否則程序其實已結束仍會誤報失敗',
  );

  const lastKill = between.lastIndexOf('Stop-Process -Id');
  assert.ok(lastKill >= 0, '重試迴圈內必須實際終止程序');

  let lastQuery = -1;
  for (let from = 0; ; ) {
    const next = between.indexOf('Get-CimInstance', from);
    if (next < 0) break;
    lastQuery = next;
    from = next + 1;
  }
  assert.ok(
    lastQuery > lastKill,
    '最終查詢必須發生在最後一次 Stop-Process 之後（不能沿用終止前的快照）',
  );
});

test('ego-stop.ps1 靜態：輸出訊息與退出碼契約不變', () => {
  assert.match(source, /Write-Output "EGO_STOPPED \(terminated \$Stopped processes\)"/);
  assert.match(
    source,
    /Write-Output "EGO_STOP_FAILED \(terminated \$Stopped processes, \$\(\s*\$Remaining\.Count\s*\) still running\)"/,
  );
  assert.match(source, /exit 1/);
  assert.match(source, /\$ErrorActionPreference\s*=\s*"SilentlyContinue"/);
  assert.match(source, /\$Ports\s*=\s*@\(9772,\s*9774\)/);
  assert.match(source, /127\.0\.0\.1:\$Port\/flush-and-close/);
});

// 以函式覆寫 cmdlet 後 dot-source 目標腳本；Get-CimInstance 前 N 次查詢回報一個
// 「還活著」的假程序（node.exe 跑 ego-browserd.js），第 N+1 次之後回報空集合。
const HARNESS = `param([string]$Target, [int]$AliveQueries = 11)

$global:QueryCount = 0
$global:KillCount = 0

function Get-CimInstance {
    param([Parameter(Position = 0)][string]$ClassName)
    $global:QueryCount++
    if ($global:QueryCount -le $script:AliveQueries) {
        [pscustomobject]@{
            ProcessId   = 4242
            Name        = 'node.exe'
            CommandLine = 'node C:/fake/ego-browserd.js'
        }
    }
}

function Stop-Process {
    [CmdletBinding()]
    param([int]$Id, [switch]$Force)
    $global:KillCount++
}

function Start-Sleep {
    param([int]$Milliseconds = 0, [int]$Seconds = 0)
}

function Invoke-WebRequest {
    [CmdletBinding()]
    param([string]$Uri, $Method, [switch]$UseBasicParsing, $TimeoutSec)
}

. $Target
`;

const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'Write-Output OK'], {
  encoding: 'utf8',
  timeout: 20_000,
}).status === 0;

const skip = hasPwsh ? false : 'pwsh not available';

function runStopScript(aliveQueries) {
  const root = mkdtempSync(join(tmpdir(), 'fmb-w11-s14-ego-stop-'));
  try {
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    const harness = join(root, 'harness.ps1');
    writeFileSync(harness, HARNESS, 'utf8');

    const res = spawnSync(
      'pwsh',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        harness,
        '-Target',
        SCRIPT,
        '-AliveQueries',
        String(aliveQueries),
      ],
      {
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          LOCALAPPDATA: join(home, 'AppData', 'Local'),
          APPDATA: join(home, 'AppData'),
        },
      },
    );
    return {
      status: res.status,
      stdout: String(res.stdout ?? '').replace(/\u0000/g, ''),
      stderr: String(res.stderr ?? '').replace(/\u0000/g, ''),
      error: res.error,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test(
  'ego-stop.ps1：最後一次強制終止後程序才消失時，必須回報成功而不是誤報失敗',
  { skip },
  () => {
    // 1 次初始掃描 + 10 次重試查詢都還看得到程序，第 12 次（最終確認）才消失。
    const res = runStopScript(11);
    const detail = `${res.stdout}${res.stderr}${res.error ? res.error.message : ''}`;
    assert.equal(res.status, 0, detail);
    assert.match(res.stdout, /EGO_STOPPED \(terminated 1 processes\)/);
  },
);

test('ego-stop.ps1：程序真的殺不掉時仍須回報失敗並 exit 1', { skip }, () => {
  const res = runStopScript(100_000);
  const detail = `${res.stdout}${res.stderr}${res.error ? res.error.message : ''}`;
  assert.equal(res.status, 1, detail);
  assert.match(res.stdout, /EGO_STOP_FAILED \(terminated 1 processes, 1 still running\)/);
});

test('ego-stop.ps1：沒有任何目標程序時快速成功且不誤報', { skip }, () => {
  const res = runStopScript(0);
  const detail = `${res.stdout}${res.stderr}${res.error ? res.error.message : ''}`;
  assert.equal(res.status, 0, detail);
  assert.match(res.stdout, /EGO_STOPPED \(terminated 0 processes\)/);
});
