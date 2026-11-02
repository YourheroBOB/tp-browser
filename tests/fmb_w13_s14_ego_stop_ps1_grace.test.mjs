// tests/fmb_w13_s14_ego_stop_ps1_grace.test.mjs
//
// 回歸測試：scripts/ego-stop.ps1 的「寬限後判定」off-by-one。
//
// 舊行為：驗證迴圈（$Verify）每一輪都先查、再「無條件」睡 300ms。當最後一輪仍查到
// 程序時，迴圈會先睡完才結束，接著卻用「睡前」的快照判定失敗 → 一個其實已在寬限期
// 內停好的 stop 被誤報成 EGO_STOP_FAILED（exit 1），而最後一次 300ms 的寬限完全白等。
// 新行為：最後一輪只查不睡，判定用的永遠是最新的快照。
//
// 測試方式：在 pwsh 內以函式替身覆寫 Get-CimInstance / Stop-Process / Invoke-WebRequest
// / Start-Sleep，因此不碰 WMI、不連任何 port、不執行任何真實程序操作；HOME 只指到
// mkdtempSync(tmpdir()) 的暫存目錄，結束即刪除。沒有 pwsh 時，行為測試自動 skip，
// 但仍保留不依賴 pwsh 的原始碼結構檢查。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/ego-stop.ps1', import.meta.url));
const FAKE_CMDLINE = 'node C:\\fake\\ego-browserd.js';

function pwshOk() {
  const probe = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'Write-Output OK'], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  return probe.status === 0 && String(probe.stdout ?? '').includes('OK');
}

const hasPwsh = pwshOk();

// aliveQueries：前 N 次 Get-CimInstance 查詢會回報同一個（假的）daemon 程序，之後回空。
function buildCommand(aliveQueries) {
  const quotedScript = SCRIPT.replace(/'/g, "''");
  return [
    '$global:FmbQueryCount = 0',
    `$global:FmbAliveQueries = ${aliveQueries}`,
    'function Get-CimInstance {',
    '    [CmdletBinding()]',
    '    param([string]$ClassName, [Parameter(ValueFromRemainingArguments = $true)]$Rest)',
    '    $global:FmbQueryCount++',
    '    if ($global:FmbQueryCount -gt $global:FmbAliveQueries) { return }',
    `    [pscustomobject]@{ Name = 'node.exe'; ProcessId = 4242; CommandLine = '${FAKE_CMDLINE}' }`,
    '}',
    'function Stop-Process {',
    '    [CmdletBinding()]',
    '    param($Id, [switch]$Force)',
    '}',
    'function Invoke-WebRequest {',
    '    [CmdletBinding()]',
    '    param($Uri, $Method, [switch]$UseBasicParsing, $TimeoutSec)',
    "    throw 'no local daemon in this test sandbox'",
    '}',
    'function Start-Sleep {',
    '    [CmdletBinding()]',
    '    param($Milliseconds, $Seconds)',
    '}',
    `& '${quotedScript}'`,
    "Write-Output ('FMB_EXIT:' + $LASTEXITCODE)",
  ].join('\n');
}

function runStop(aliveQueries) {
  const home = mkdtempSync(join(tmpdir(), 'fmb-w13-s14-ego-stop-'));
  try {
    const res = spawnSync(
      'pwsh',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', buildCommand(aliveQueries)],
      {
        encoding: 'utf8',
        timeout: 40_000,
        env: { ...process.env, HOME: home, USERPROFILE: home },
      },
    );
    return {
      status: res.status,
      stdout: String(res.stdout ?? '').replace(/\u0000/g, ''),
      stderr: String(res.stderr ?? '').replace(/\u0000/g, ''),
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test(
  'ego-stop.ps1：程序在最後一次寬限期間結束時不得誤報 EGO_STOP_FAILED',
  { skip: hasPwsh ? false : 'pwsh not available' },
  () => {
    // 假程序活過「終止階段 1 次 + 驗證前 3 次」查詢，第 4 次驗證查詢前才消失。
    const res = runStop(4);
    assert.doesNotMatch(
      res.stdout,
      /EGO_STOP_FAILED/,
      `寬限期內已停好的 stop 被誤報成失敗\nstdout=${res.stdout}\nstderr=${res.stderr}`,
    );
    assert.match(res.stdout, /EGO_STOPPED/);
    assert.ok(
      res.status === 0 || /FMB_EXIT:0/.test(res.stdout),
      `預期成功結束，實際 exit=${res.status}\nstdout=${res.stdout}\nstderr=${res.stderr}`,
    );
  },
);

test(
  'ego-stop.ps1：程序真的殺不掉時仍須 EGO_STOP_FAILED 且以非 0 結束',
  { skip: hasPwsh ? false : 'pwsh not available' },
  () => {
    const res = runStop(1000);
    assert.match(res.stdout, /EGO_STOP_FAILED/);
    assert.ok(
      res.status === 1 || /FMB_EXIT:1/.test(res.stdout),
      `預期 exit 1，實際 exit=${res.status}\nstdout=${res.stdout}\nstderr=${res.stderr}`,
    );
  },
);

test(
  'ego-stop.ps1：完全沒有符合的程序時回報 EGO_STOPPED 且成功結束',
  { skip: hasPwsh ? false : 'pwsh not available' },
  () => {
    const res = runStop(0);
    assert.match(res.stdout, /EGO_STOPPED/);
    assert.doesNotMatch(res.stdout, /EGO_STOP_FAILED/);
    assert.ok(
      res.status === 0 || /FMB_EXIT:0/.test(res.stdout),
      `預期 exit 0，實際 exit=${res.status}\nstdout=${res.stdout}\nstderr=${res.stderr}`,
    );
  },
);

// 不依賴 pwsh 的結構檢查：驗證迴圈裡的寬限睡眠必須有條件，否則「最後一次睡眠」永遠
// 不會被觀察到，判定就會用到過期快照（即上述 off-by-one）。
test('ego-stop.ps1：驗證迴圈最後一次查詢之後不得再無條件睡眠', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  const start = src.indexOf('for ($Verify');
  assert.notEqual(start, -1, '找不到 $Verify 驗證迴圈');
  const end = src.indexOf('if ($Remaining.Count -gt 0)', start);
  assert.notEqual(end, -1, '找不到成敗判定分支');
  const block = src.slice(start, end);

  const sleepLines = block.split(/\r?\n/).filter((line) => line.includes('Start-Sleep'));
  assert.ok(sleepLines.length > 0, '驗證迴圈應保留有限、有界的寬限睡眠');
  for (const line of sleepLines) {
    const at = line.indexOf('Start-Sleep');
    assert.ok(
      line.slice(0, at).includes('if ('),
      `寬限睡眠必須有條件，否則最後一次睡眠不會被觀察到：${line.trim()}`,
    );
  }
});
