// tests/fmb_w2_s14_ego_stop_verify.test.mjs
// ego-stop.ps1 迴歸測試（s14）：
//   1) Stop-Process 失敗（例如權限不足）不得計入 terminated。
//   2) 終止後必須重新查詢並輪詢（最多 5 秒）確認符合條件的程序真的消失。
//   3) 仍有殘留時輸出 EGO_STOP_FAILED（列出 pid）並 exit 1，不再永遠 exit 0。
//
// 零依賴、零網路：有 pwsh 時以 stub 函式覆蓋 Get-CimInstance / Stop-Process /
// Invoke-WebRequest / Start-Sleep，HOME／USERPROFILE 一律指向 mkdtemp() 的暫存目錄，
// 不會讀到真實使用者的 daemon.json，也不會真的去停任何程序或連任何服務。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../scripts/ego-stop.ps1', import.meta.url));
const workDir = mkdtempSync(join(tmpdir(), 'fmb-w2-s14-ego-stop-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

const source = readFileSync(scriptPath, 'utf8');

const STUCK_PID = 4101;
const OK_PID = 4102;

function pwshOk() {
  const probe = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'Write-Output OK'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  return probe.status === 0 && String(probe.stdout ?? '').includes('OK');
}

const hasPwsh = pwshOk();

// ---- 結構斷言（沒有 pwsh 也一定會跑）----------------------------------------

test('ego-stop.ps1：$Stopped++ 只有在 Stop-Process 成功時才執行', () => {
  assert.match(
    source,
    /try\s*\{[\s\S]*?Stop-Process[\s\S]*?if\s*\(\s*\$\?\s*\)\s*\{\s*\$Stopped\+\+\s*\}/,
    'Stop-Process 之後必須先確認成功（try/catch 或 $?）才遞增 $Stopped',
  );
});

test('ego-stop.ps1：終止後重新查詢並以有上限的重試迴圈確認', () => {
  const queries = source.match(/Get-CimInstance Win32_Process/g) ?? [];
  assert.ok(queries.length >= 2, `終止後必須重新查詢程序清單，實際查詢次數：${queries.length}`);
  assert.match(source, /for\s*\(\$Attempt\s*=\s*0;\s*\$Attempt\s*-lt\s*\d+/, '重新查詢必須有次數上限');
  assert.match(source, /Start-Sleep -Milliseconds \d+\s*\n\}/, '重試之間必須實際等待再重查');
});

test('ego-stop.ps1：殘留走 EGO_STOP_FAILED + exit 1，成功才 EGO_STOPPED + exit 0', () => {
  assert.match(source, /still running:/, 'EGO_STOP_FAILED 必須列出殘留 pid');
  assert.match(source, /EGO_STOP_FAILED[\s\S]{0,300}?exit 1/, '仍有殘留時必須 exit 1');
  assert.match(
    source,
    /Write-Output "EGO_STOPPED \(terminated \$Stopped processes\)"[\s\S]{0,20}exit 0/,
    '全部停止時仍輸出 EGO_STOPPED 並 exit 0',
  );
});

// ---- pwsh 行為測試（stub 覆蓋所有對外呼叫）----------------------------------

const STUB_TEMPLATE = `$global:FmbMode = '__MODE__'
$global:FmbProcs = @(
    [pscustomobject]@{ Name = 'node.exe'; ProcessId = ${STUCK_PID}; CommandLine = 'node C:\\fake\\ego-browserd.js' }
    [pscustomobject]@{ Name = 'chrome.exe'; ProcessId = ${OK_PID}; CommandLine = 'chrome --user-data-dir=C:\\fake\\ego-linux\\profile-agent' }
)

function Get-CimInstance {
    param([Parameter(ValueFromRemainingArguments = $true)] $Rest)
    return $global:FmbProcs
}

function Stop-Process {
    param([int]$Id, [switch]$Force, [Parameter(ValueFromRemainingArguments = $true)] $Rest)
    if ($global:FmbMode -eq 'stuck' -and $Id -eq ${STUCK_PID}) {
        # 模擬權限不足：Stop-Process 失敗，程序仍存活。
        throw "Access is denied (pid $Id) [FAKE_VALUE_FOR_TEST]"
    }
    $global:FmbProcs = @($global:FmbProcs | Where-Object { $_.ProcessId -ne $Id })
}

function Invoke-WebRequest {
    param([Parameter(ValueFromRemainingArguments = $true)] $Rest)
    return [pscustomobject]@{ StatusCode = 200 }
}

function Start-Sleep {
    param([Parameter(ValueFromRemainingArguments = $true)] $Rest)
}
`;

const wrapperPath = join(workDir, 'run-ego-stop.ps1');
writeFileSync(
  wrapperPath,
  'param([string]$StubFile, [string]$TargetFile)\n. $StubFile\n& $TargetFile\nexit $LASTEXITCODE\n',
  'utf8',
);

function runStop(mode) {
  const stubPath = join(workDir, `stub-${mode}.ps1`);
  writeFileSync(stubPath, STUB_TEMPLATE.replace('__MODE__', mode), 'utf8');
  const home = mkdtempSync(join(workDir, `home-${mode}-`));
  return spawnSync(
    'pwsh',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      wrapperPath,
      '-StubFile',
      stubPath,
      '-TargetFile',
      scriptPath,
    ],
    {
      encoding: 'utf8',
      timeout: 90_000,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        LOCALAPPDATA: join(home, 'LocalAppData'),
      },
    },
  );
}

test(
  'ego-stop.ps1：有一個程序殺不掉時輸出 EGO_STOP_FAILED（列出 pid）並 exit 1',
  { skip: hasPwsh ? false : 'pwsh not available' },
  () => {
    const res = runStop('stuck');
    const stdout = String(res.stdout ?? '');
    const stderr = String(res.stderr ?? '');

    assert.equal(res.status, 1, `expected exit 1 / got ${res.status}: ${stderr || stdout || res.error?.message}`);
    assert.match(stdout, /EGO_STOP_FAILED/);
    assert.match(stdout, new RegExp(`still running:.*${STUCK_PID}`), '失敗訊息必須列出殺不掉的 pid');
    assert.doesNotMatch(stdout, /EGO_STOPPED/, '不得回報成功');
    // 殺不掉的那個不能計入 terminated（另一個成功，所以只算 1）。
    assert.match(stdout, /terminated 1 processes/, 'Stop-Process 失敗的程序不得計入 terminated');
    assert.doesNotMatch(stdout, new RegExp(String(OK_PID)), '已終止的程序不應出現在殘留清單');
  },
);

test(
  'ego-stop.ps1：全部成功時輸出 EGO_STOPPED 並 exit 0',
  { skip: hasPwsh ? false : 'pwsh not available' },
  () => {
    const res = runStop('all');
    const stdout = String(res.stdout ?? '');
    const stderr = String(res.stderr ?? '');

    assert.equal(res.status, 0, `expected exit 0 / got ${res.status}: ${stderr || stdout || res.error?.message}`);
    assert.match(stdout, /EGO_STOPPED \(terminated 2 processes\)/);
    assert.doesNotMatch(stdout, /EGO_STOP_FAILED/);
  },
);
