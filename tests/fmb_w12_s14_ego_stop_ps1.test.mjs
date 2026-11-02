// tests/fmb_w12_s14_ego_stop_ps1.test.mjs
//
// scripts/ego-stop.ps1 的回歸測試（純靜態：只讀原始碼、不啟動 WMI／不殺任何程序）。
// 鎖定三個真的會造成錯誤結果的行為：
//   1. 判定競態：驗證迴圈最後一輪「先睡、睡完不再查」，若程序在寬限期內結束，
//      仍會拿睡前快照誤報 EGO_STOP_FAILED（exit 1）。判定前必須再查一次。
//   2. 計數錯誤：重試迴圈殺掉的程序沒被計入 $Stopped，輸出數字與實際不符。
//   3. 比對失效：profile 路徑若用 -like 比對，路徑含 "[" / "]" 時（萬用字元字集）
//      會靜默不匹配，導致 stop 假成功；且不得用過寬的 "*profile-agent*" 誤殺
//      使用者自己的瀏覽器（README 承諾不影響日常瀏覽器）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../scripts/ego-stop.ps1', import.meta.url));
const src = readFileSync(scriptPath, 'utf8');

test('ego-stop.ps1：資料目錄支援 EGO_LINUX_DATA_DIR 覆寫，HOME 缺省時退回 USERPROFILE', () => {
  assert.match(src, /\$env:EGO_LINUX_DATA_DIR/);
  assert.match(src, /\$env:USERPROFILE/);
  assert.match(src, /\$DataDir\s*=\s*if\s*\(/);
});

test('ego-stop.ps1：flush-and-close 連接埠可由 TP_DAEMON_PORT／EGO_DAEMON_PORT 覆寫且值域受檢', () => {
  assert.match(src, /\$env:TP_DAEMON_PORT/);
  assert.match(src, /\$env:EGO_DAEMON_PORT/);
  assert.match(src, /\$EP -ge 1 -and \$EP -le 65535/);
});

test('ego-stop.ps1：profile 路徑由 $DataDir 推導，且用 OrdinalIgnoreCase 子字串比對（避免 -like 的 [ ] 萬用字元陷阱）', () => {
  assert.match(src, /\$ProfileDir = Join-Path \$DataDir "profile-agent"/);
  assert.match(src, /IndexOf\(\$ProfileDir, \[System\.StringComparison\]::OrdinalIgnoreCase\)/);
  // 不得把 profile 路徑丟進 -like（路徑含 [ ] 會比對失敗）。
  assert.doesNotMatch(src, /-like\s+"\*\$ProfileDir\*"/);
  // 也不得用過寬的 '*profile-agent*'（會誤殺使用者自己的瀏覽器）。
  assert.doesNotMatch(src, /-like\s+"\*profile-agent\*"/);
});

test('ego-stop.ps1：程序名稱涵蓋 chromium.exe，daemon 比對保留 ego-browserd.js 與 tp-browserd.js', () => {
  assert.match(src, /chromium/);
  assert.match(src, /-like "\*ego-browserd\.js\*"/);
  assert.match(src, /-like "\*tp-browserd\.js\*"/);
});

test('ego-stop.ps1：終止的 PID 以 HashSet 去重，重試迴圈每輪都更新 $Stopped', () => {
  assert.match(src, /\[System\.Collections\.Generic\.HashSet\[int\]\]::new\(\)/);
  // 迴圈內：加入 PID 後重算 $Stopped，然後才 sleep。
  assert.match(
    src,
    /\[void\]\$TerminatedPids\.Add\(\$Proc\.ProcessId\)\s*\}\s*\$Stopped = \$TerminatedPids\.Count\s*Start-Sleep -Milliseconds 300/,
  );
});

test('ego-stop.ps1：驗證寬限期的最後一次睡眠後，判定前必須再查一次即時狀態', () => {
  const verifyIdx = src.indexOf('for ($Verify = 0; $Verify -lt 3; $Verify++)');
  const failIdx = src.indexOf('Write-Output "EGO_STOP_FAILED');
  assert.ok(verifyIdx >= 0, '缺少有界的驗證迴圈');
  assert.ok(failIdx > verifyIdx, '判定輸出必須在驗證迴圈之後');

  const between = src.slice(verifyIdx, failIdx);
  assert.match(
    between,
    /if \(\$Remaining\.Count -gt 0\) \{\s*\$Remaining = @\(Get-CimInstance Win32_Process/,
    '驗證迴圈結束後、判定失敗前，缺少一次即時重新查詢（會用舊快照誤報失敗）',
  );
  assert.match(src, /exit 1/);
});
