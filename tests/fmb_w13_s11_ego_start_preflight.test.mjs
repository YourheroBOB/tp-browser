// tests/fmb_w13_s11_ego_start_preflight.test.mjs
// scripts/ego-start.ps1 的回歸測試（純靜態：只讀 repo 內的 .ps1 並比對片段與順序；
// 不執行 PowerShell、不連線任何服務、不讀寫 repo 以外的路徑、不需要任何憑證）。
//
// 被釘住的行為契約：
//   1. 啟動 daemon 前必須先確認 ego-browserd.js 真的存在；不存在要寫 stderr 並 exit 1，
//      而且訊息要指出實際解析到的路徑（否則使用者只看到 12 秒後的 EGO_NOT_READY）。
//   2. 這項檢查必須排在「既有服務已健康 → EGO_READY」的快速通關之後，
//      且排在 flush-and-close / Stop-Process 之前：壞掉的安裝不得拆掉健康的堆疊。
//   3. Win32_Process.Create 的回傳碼不得被丟棄（daemon 啟動失敗必須立刻可見）。
//   4. 既有契約（回歸保護）：瀏覽器二元檔 / 參數衝突的驗證也在殺程序之前。
//   5. 檔案本身不得殘留合併衝突標記（本檔會被 shell/PowerShell 直接解讀）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../scripts/ego-start.ps1', import.meta.url));
const src = readFileSync(scriptPath, 'utf8');

function idx(needle) {
  const i = src.indexOf(needle);
  assert.notEqual(i, -1, `ego-start.ps1 缺少預期片段：${needle}`);
  return i;
}

test('ego-start.ps1 沒有殘留的合併衝突標記（否則整個腳本無法解析）', () => {
  assert.doesNotMatch(src, /^={7,}\s*$/m, '發現孤立的 ======= 合併標記');
  assert.doesNotMatch(src, /^<{7}[ <]/m, '發現 <<<<<<< 合併標記');
  assert.doesNotMatch(src, /^>{7}[ >]/m, '發現 >>>>>>> 合併標記');
});

test('daemon 入口檔在啟動前必須驗證存在，失敗要寫 stderr 並以非零碼結束', () => {
  const check = idx('Test-Path -LiteralPath $DaemonJs -PathType Leaf');
  const message = idx('ERROR: ego-browserd.js not found at');
  assert.ok(message > check, '錯誤訊息必須緊接在存在性檢查之後');

  const block = src.slice(check, message + 400);
  assert.match(block, /\[Console\]::Error\.WriteLine/, '必須寫到 stderr，不能靜默結束');
  assert.match(block, /exit 1/, '檢查失敗必須以非零碼結束');
  assert.match(block, /\$DaemonJs/, '錯誤訊息必須指出實際解析到的路徑，才可據以修復');
});

test('存在性檢查必須排在健康快速通關之後、且在殺程序之前', () => {
  const fastPath = idx('if (-not $Restart) {');
  const daemonCheck = idx('Test-Path -LiteralPath $DaemonJs -PathType Leaf');
  const flush = idx('/flush-and-close');
  const kill = idx('Stop-Process -Id $_.ProcessId -Force');

  assert.ok(daemonCheck > fastPath, '已健康的服務必須能直接 EGO_READY，不因缺檔而失敗');
  assert.ok(daemonCheck < flush, '缺檔時不得先送出 flush-and-close（會把登入態洗掉）');
  assert.ok(daemonCheck < kill, '缺檔時不得先殺掉執行中的 daemon / 瀏覽器');
});

test('WMI 啟動 daemon 的回傳碼不得被 Out-Null 丟掉', () => {
  const call = idx('Invoke-CimMethod -ClassName Win32_Process -MethodName Create');
  const lineStart = src.lastIndexOf('\n', call) + 1;
  const line = src.slice(lineStart, src.indexOf('\n', call));
  assert.match(line, /^\s*\$\w+\s*=\s*Invoke-CimMethod/, `Create 的回傳值必須被保留：${line.trim()}`);
  assert.doesNotMatch(line, /Out-Null/, '不可用 Out-Null 吞掉 Create 的回傳值');

  const window = src.slice(call, call + 1200);
  assert.match(window, /\$DaemonCmdLine/, '第一個 Create 呼叫必須是 daemon');
  assert.match(window, /\$null -ne \$DaemonLaunch/, '缺少回傳物件時必須視為未知，不可誤判失敗');
  assert.match(window, /ReturnValue -ne 0/, '必須檢查 ReturnValue');
  assert.match(window, /exit 1/, 'Create 明確失敗時必須以非零碼結束');
});

test('瀏覽器驗證必須在 flush-and-close 與 Stop-Process 之前（不得先拆掉活著的 profile）', () => {
  const tpBin = idx('TP_BROWSER_BIN is set to');
  const conflict = idx('-Edge and -Chrome must not be combined');
  const flush = idx('/flush-and-close');
  const kill = idx('Stop-Process -Id $_.ProcessId -Force');

  assert.ok(tpBin < flush && tpBin < kill, 'TP_BROWSER_BIN 驗證必須在 teardown 之前');
  assert.ok(conflict < flush && conflict < kill, '-Edge/-Chrome 衝突必須在 teardown 之前');
});

test('CDP 只綁 127.0.0.1，遠端除錯埠由 $ChromePort 決定', () => {
  assert.ok(src.includes('--remote-debugging-address=127.0.0.1'), '必須明確綁 loopback');
  assert.ok(src.includes('--remote-debugging-port=$ChromePort'), '除錯埠必須跟隨 $ChromePort');
  assert.doesNotMatch(src, /--remote-debugging-address=0\.0\.0\.0/, '不得綁 0.0.0.0');
});

test('alt-port 會成對切換 daemon 與 Chrome 埠位（9772/9773 與 9774/9775）', () => {
  assert.match(src, /\$DaemonPort = if \(\$UseAlt\) \{ 9774 \} else \{ 9772 \}/);
  assert.match(src, /\$ChromePort = if \(\$UseAlt\) \{ 9775 \} else \{ 9773 \}/);
});

test('profile 的 Chrome Singleton 鎖一定會被列舉清理，且路徑鎖定 $ProfileDir', () => {
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    assert.ok(src.includes(`"${name}"`), `缺少清理 ${name}`);
  }
  assert.match(src, /Join-Path \$ProfileDir \$_/, '清理路徑必須鎖定 $ProfileDir，不得外溢');
});
