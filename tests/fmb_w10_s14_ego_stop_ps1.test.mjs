// tests/fmb_w10_s14_ego_stop_ps1.test.mjs
//
// scripts/ego-stop.ps1 回歸測試。
//
// 真的 bug（已修）：被 Stop-Process 終止的程序，在 kernel 回收前仍會出現在 Win32_Process
// 快照裡。舊版把重試迴圈「最後一次 kill 之前」取得的快照直接當成最終結果，因此在最後一個
// 300ms 等待期間才消失的程序會被誤報成 EGO_STOP_FAILED 並 exit 1（與 scripts/tp-stop.sh
// 已修過的 SIGKILL 取樣競態同一類）。正確做法是：最終判定所用的列舉必須晚於最後一次 kill。
//
// 測試策略：
//   1. 靜態結構測試（任何平台都跑）：驗證「最終判定前重新取樣」這條不變式，以及
//      「只終止 EGO 自己的程序」的安全不變式。這部分不需要 PowerShell，也不會失敗於環境。
//      分析前先剝掉註解行，否則說明文字裡出現的指令名稱會讓位置比對失真。
//   2. 行為測試（僅在 pwsh 可用、且可 mock 內建 cmdlet 時執行）：用假的
//      Get-CimInstance／Stop-Process／Start-Sleep／Invoke-WebRequest 覆蓋真 cmdlet，
//      因此不連線任何服務、不終止任何真實程序，所有檔案都在 tmpdir 內。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/ego-stop.ps1', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'fmb-w10-s14-ego-stop-'));
after(() => rmSync(root, { recursive: true, force: true }));

// 刻意選一個幾乎不可能存在的 ProcessId：即使 mock 失效也不會誤殺真實程序。
const FAKE_PID = 999999;

// 只保留可執行的程式行（去掉整行註解）。註解裡會提到 Get-EgoProcess／Stop-Process／
// EGO_STOP_FAILED 等名稱，若不剝除，位置比對就會落在說明文字上而誤判。
function codeOf(src) {
  return src
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

// 假 cmdlet 定義。真正的 ego-stop.ps1 以 `& $env:FMB_TARGET` 在子範圍執行，
// 命令解析會先找到這裡的函式（函式優先於 cmdlet），所以完全不會碰到系統 cmdlet。
const WRAPPER = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
try { Set-Variable -Name HOME -Value $env:FMB_STUB_HOME -Scope Local -Force } catch {}

function Add-CallLog([string]$Kind) {
    [System.IO.File]::AppendAllText($env:FMB_LOG, $Kind + [Environment]::NewLine)
}

function Get-CimInstance {
    [CmdletBinding()]
    param(
        [Parameter(Position = 0)] $ClassName,
        [Parameter(ValueFromRemainingArguments = $true)] $Rest
    )
    $prior = @(Get-Content -LiteralPath $env:FMB_LOG | Where-Object { $_ -eq 'enum' }).Count
    Add-CallLog 'enum'
    if (($prior + 1) -le [int]$env:FMB_LIVE_ENUMS) {
        [pscustomobject]@{
            Name = 'node.exe'
            CommandLine = 'node C:\fake\fmb-w10-s14-ego-browserd.js'
            ProcessId = ${FAKE_PID}
        }
    }
}

function Stop-Process {
    [CmdletBinding()]
    param($Id, [switch]$Force)
    Add-CallLog 'kill'
}

function Start-Sleep {
    [CmdletBinding()]
    param([int]$Milliseconds, [int]$Seconds)
}

function Invoke-WebRequest {
    [CmdletBinding()]
    param([string]$Uri, [string]$Method, [switch]$UseBasicParsing, [int]$TimeoutSec)
    Add-CallLog ('flush:' + $Uri)
}

& $env:FMB_TARGET
$code = $LASTEXITCODE
if ($null -eq $code) { $code = 0 }
exit $code
`;

function pwshAvailable() {
  const probe = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'Write-Output OK'], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  return probe.status === 0 && String(probe.stdout ?? '').includes('OK');
}

function runScript(target, liveEnums) {
  const dir = mkdtempSync(join(root, 'run-'));
  const logPath = join(dir, 'calls.log');
  const stubHome = join(dir, 'home');
  mkdirSync(stubHome, { recursive: true });
  writeFileSync(logPath, '');
  const wrapperPath = join(dir, 'wrapper.ps1');
  writeFileSync(wrapperPath, WRAPPER);

  const res = spawnSync(
    'pwsh',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapperPath],
    {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        FMB_TARGET: target,
        FMB_LOG: logPath,
        FMB_STUB_HOME: stubHome,
        FMB_LIVE_ENUMS: String(liveEnums),
      },
    },
  );

  const calls = readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean);
  return {
    status: res.status,
    stdout: String(res.stdout ?? '').replace(/\u0000/g, ''),
    stderr: String(res.stderr ?? '').replace(/\u0000/g, ''),
    error: res.error,
    calls,
  };
}

// probe：先確認「用函式覆蓋 cmdlet」的手法在這台 pwsh 上成立，成立才跑行為測試。
function mockingWorks() {
  const dir = mkdtempSync(join(root, 'probe-'));
  const target = join(dir, 'probe-target.ps1');
  writeFileSync(
    target,
    "$procs = @(Get-CimInstance Win32_Process)\nWrite-Output ('PROBE_COUNT=' + $procs.Count)\n",
  );
  const run = runScript(target, 1);
  return run.status === 0 && run.stdout.includes('PROBE_COUNT=1') && run.calls.includes('enum');
}

const hasPwsh = pwshAvailable();
const mockOk = hasPwsh ? mockingWorks() : false;
const skipBehaviour = mockOk
  ? false
  : hasPwsh
    ? 'pwsh 存在但無法 mock 內建 cmdlet（probe 失敗），跳過行為測試'
    : 'pwsh not available';

test('ego-stop.ps1：最終判定前必須在最後一次 Stop-Process 之後重新取樣（回歸）', () => {
  const code = codeOf(readFileSync(SCRIPT, 'utf8'));

  // 只看「實際輸出失敗訊息」那一行，避免撞到其他同名文字。
  const verdictIdx = code.indexOf('Write-Output "EGO_STOP_FAILED');
  assert.ok(verdictIdx > 0, '找不到 EGO_STOP_FAILED 的輸出敘述');

  const before = code.slice(0, verdictIdx);
  const lastKill = before.lastIndexOf('Stop-Process');
  assert.ok(lastKill > 0, '找不到 Stop-Process');

  let lastSample = -1;
  const sampler = /Get-EgoProcess|Get-CimInstance/g;
  let m;
  while ((m = sampler.exec(before)) !== null) lastSample = m.index;

  assert.ok(
    lastSample > lastKill,
    '最終判定沿用了最後一次 kill 之前的程序快照：kill 後才消失的程序會被誤報 EGO_STOP_FAILED',
  );
});

test('ego-stop.ps1：只終止 EGO 自己的程序，絕不碰使用者個人瀏覽器', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  assert.ok(
    src.includes("'^(node|chrome|msedge|brave)\\.exe$'"),
    '程序名稱比對必須限定在已知的 node／瀏覽器執行檔',
  );
  for (const marker of ['"*ego-browserd.js*"', '"*tp-browserd.js*"', '"*ego-linux*profile-agent*"']) {
    assert.ok(src.includes(marker), `缺少命令列標記比對 ${marker}`);
  }
  assert.ok(!/Stop-Process\s+-Name/.test(codeOf(src)), '不得只憑程序名稱就終止程序');
});

test('ego-stop.ps1：先 flush-and-close 9772／9774，且 flush 失敗不得中斷停止流程', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  const code = codeOf(src);
  assert.match(code, /\$Ports\s*=\s*@\(9772,\s*9774\)/);
  assert.ok(code.includes('flush-and-close'), '缺少 flush-and-close');
  // flush 呼叫必須包在 try 裡並帶 -ErrorAction Stop，否則連線失敗會被靜靜吞掉。
  const flushCalls = code.split(/\r?\n/).filter((l) => l.includes('flush-and-close'));
  assert.equal(flushCalls.length, 1, 'flush 迴圈應只寫一次（跑多個埠位）');
  assert.match(flushCalls[0], /-ErrorAction Stop/);
  assert.match(code, /catch \{\}/);
});

test('ego-stop.ps1：沒有殘留時 exit 0 並回報 EGO_STOPPED', () => {
  const code = codeOf(readFileSync(SCRIPT, 'utf8'));
  assert.match(code, /Write-Output "EGO_STOPPED \(terminated \$Stopped processes\)"/);
  assert.match(
    code,
    /Write-Output "EGO_STOP_FAILED \(terminated \$Stopped processes, \$\(\$Remaining\.Count\) still running\)"[\s\S]*?exit 1/,
  );
});

test('ego-stop.ps1：程序一直不死時回報 EGO_STOP_FAILED（exit 1）', { skip: skipBehaviour }, () => {
  // 永遠看得到程序：腳本會用盡重試並以 exit 1 收場；重點是最終判定用的列舉
  // 必須晚於最後一次 kill，而不是沿用 kill 前的快照。
  const run = runScript(SCRIPT, 999);
  assert.equal(run.status, 1, run.stderr || run.stdout || run.error?.message || 'pwsh failed');
  assert.match(run.stdout, /EGO_STOP_FAILED/);

  const kinds = run.calls.filter((c) => c === 'enum' || c === 'kill');
  const lastEnum = kinds.lastIndexOf('enum');
  const lastKill = kinds.lastIndexOf('kill');
  assert.ok(lastKill >= 0, `腳本未嘗試終止程序：${JSON.stringify(run.calls)}`);
  assert.ok(lastEnum > lastKill, `最終判定沿用 kill 前快照（enum=#${lastEnum}, kill=#${lastKill}）`);
});

test('ego-stop.ps1：沒有目標程序時 exit 0 且不終止任何東西', { skip: skipBehaviour }, () => {
  const run = runScript(SCRIPT, 0);
  assert.equal(run.status, 0, run.stderr || run.stdout || run.error?.message || 'pwsh failed');
  assert.match(run.stdout, /EGO_STOPPED \(terminated 0 processes\)/);
  assert.equal(run.calls.filter((c) => c === 'kill').length, 0, '不應終止任何程序');
  assert.ok(run.calls.includes('enum'), '應至少列舉一次程序');
});

test('ego-stop.ps1：kill 後即消失的程序算一次終止，且會重新取樣確認', { skip: skipBehaviour }, () => {
  // 第一次列舉看得到程序、之後看不到（模擬 kill 後被 kernel 回收）。
  const run = runScript(SCRIPT, 1);
  assert.equal(run.status, 0, run.stderr || run.stdout || run.error?.message || 'pwsh failed');
  assert.match(run.stdout, /EGO_STOPPED \(terminated 1 processes\)/);
  assert.equal(run.calls.filter((c) => c === 'kill').length, 1);
  assert.ok(
    run.calls.filter((c) => c === 'enum').length >= 2,
    '終止後必須重新取樣才能確認已經停止',
  );
});
