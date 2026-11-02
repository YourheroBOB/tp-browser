// tests/ego_start_headed_window_not_reused.test.mjs
//
// 回歸測試（PowerShell 啟動器）：無頭的 `ego-start` 不得沿用已開著的有頭 GUI 視窗。
//
// 重現（修好前）：
//   1) ego-headed  -> 同一 profile 出現可見的 Chrome/Edge 視窗
//   2) ego-start   -> 只要 /health 正常且沒帶旗標，就直接印 EGO_READY 並 exit 0，
//                     可見視窗繼續存活、繼續搶焦點，agent 其實在 GUI 瀏覽器裡跑。
// 但 STATE.md 記載「ego-headed → ego-start 即切回背景無頭模式」，原始碼自己的註解
// 也寫「preserve existing interactive headed desktop browser if -Headed and not
// -Restart」——只有 -Headed 才該保留 GUI 視窗。修好後：無頭請求會先確認「沒有跑著的
// 有頭視窗」，有就 fall through 走重啟流程。
//
// CI 沒有 Windows/PowerShell，因此本測試對 scripts/ego-start.ps1 做結構性斷言
// （repo 內其他 .ps1 測試同此法）：不連線、不執行、不讀寫 repo 外路徑。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../scripts/ego-start.ps1', import.meta.url));
const raw = readFileSync(scriptPath, 'utf8');
const flat = raw.replace(/\s+/g, ' ');

function sliceBetween(startMarker, endMarker) {
  const start = raw.indexOf(startMarker);
  const end = raw.indexOf(endMarker);
  assert.ok(start >= 0, `找不到區段起點：${startMarker}`);
  assert.ok(end > start, `找不到區段終點：${endMarker}`);
  return raw.slice(start, end).replace(/\s+/g, ' ');
}

const healthyRegion = sliceBetween('# 3. Check if already healthy', '# Resolve the daemon ports');

test('有頭視窗偵測集中在 Get-HeadedBrowserProc（--tp-interactive-gui=1 且非 --headless）', () => {
  const start = raw.indexOf('function Get-HeadedBrowserProc');
  assert.ok(start >= 0, '缺少 Get-HeadedBrowserProc helper');
  const body = raw.slice(start, raw.indexOf('\n}', start)).replace(/\s+/g, ' ');
  assert.match(body, /--tp-interactive-gui=1/);
  assert.match(body, / -notlike "\*--headless\*"/);
  assert.match(body, /SessionId -ge 1/);
  assert.ok(
    flat.indexOf('function Get-HeadedBrowserProc') < flat.indexOf('Get-HeadedBrowserProc -ExeName'),
    'helper 必須定義在第一次呼叫之前（PowerShell 循序執行）',
  );
});

test('無頭 ego-start 只在「沒有有頭視窗」時才直接 EGO_READY', () => {
  assert.ok(
    healthyRegion.includes('$HeadedProc = @(Get-HeadedBrowserProc -ExeName $TargetExeName)'),
    '健康檢查區段必須先取得有頭視窗清單',
  );
  assert.ok(
    healthyRegion.includes('-and $HeadedProc.Count -eq 0'),
    '無頭短線必須加上「沒有有頭視窗」的條件',
  );
  assert.ok(
    !/if \(-not \$Headed -and -not \$Edge -and -not \$Chrome\) \{/.test(healthyRegion),
    '不可再單純用「沒帶旗標」就 EGO_READY（這正是本 bug）',
  );
});

test('-Headed 仍然重用既有的有頭視窗，且輸出 mode=headed', () => {
  assert.ok(healthyRegion.includes('if ($Headed -and $HeadedProc.Count -gt 0)'));
  assert.ok(healthyRegion.includes('mode=headed'));
  assert.ok(
    healthyRegion.indexOf('if ($Headed -and $HeadedProc.Count -gt 0)') <
      healthyRegion.indexOf('-and $HeadedProc.Count -eq 0'),
    '重用有頭視窗的判斷必須在無頭短線之前',
  );
});
