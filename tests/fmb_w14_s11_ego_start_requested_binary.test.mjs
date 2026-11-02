// tests/fmb_w14_s11_ego_start_requested_binary.test.mjs
// 回歸測試：scripts/ego-start.ps1 的「已健康就快速返回」分支必須確認目前跑在
// profile-agent 上的瀏覽器，就是這次選定的那個執行檔（TP_BROWSER_BIN / -Edge /
// -Chrome / 自動偵測）。原始版本只看 daemon /health 與 CDP User-Agent 是否含
// "Windows"，因此使用者改用 TP_BROWSER_BIN 指向另一個瀏覽器時，仍會被舊瀏覽器
// 誤報成 EGO_READY，導致新指定的瀏覽器根本沒有被啟動。
//
// 這裡是純靜態檢查（只讀檔、不啟動 PowerShell、不連線任何服務、不需要 Windows），
// 因為 .ps1 的啟動流程會真的殺程序與開瀏覽器，不可能在測試中執行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../scripts/ego-start.ps1', import.meta.url), 'utf8');

const readyStart = source.indexOf('# 3. Check if already healthy');
const readyEnd = source.indexOf('# Resolve the daemon ports');
const readyBlock = source.slice(readyStart, readyEnd);

test('ego-start.ps1 仍保有可被檢驗的快速返回區塊（切片不為空）', () => {
  assert.ok(readyStart >= 0, '找不到第 3 步「已健康就返回」的註解');
  assert.ok(readyEnd > readyStart, '找不到第 3 步之後的沖刷埠位註解');
  assert.ok(readyBlock.length > 0);
});

test('選定的瀏覽器路徑會被正規化成可與 Win32_Process.ExecutablePath 比較的形式', () => {
  assert.match(source, /\$TargetBrowserPath\s*=\s*\[System\.IO\.Path\]::GetFullPath\(\$BrowserBin\)/);
});

test('無頭模式的快速返回必須先確認執行中的瀏覽器就是選定的執行檔', () => {
  assert.match(readyBlock, /\$HealthyBrowserProc\s*=\s*@\(Get-CimInstance Win32_Process/);
  assert.match(readyBlock, /\$_\s*\.ExecutablePath\s*-ieq\s*\$TargetBrowserPath/);
  // 快速返回只有在找到「同一支執行檔」的行程時才成立。
  assert.match(
    readyBlock,
    /if \(-not \$Headed -and -not \$Edge -and -not \$Chrome -and \$HealthyBrowserProc\.Count -gt 0\)/
  );
});

test('有頭模式保留既有視窗時，同樣要求執行檔路徑相符', () => {
  const headedStart = readyBlock.indexOf('$HeadedProc = @(');
  const headedEnd = readyBlock.indexOf('if ($HeadedProc.Count -gt 0)');
  assert.ok(headedStart >= 0, '找不到有頭模式的行程偵測');
  assert.ok(headedEnd > headedStart, '找不到有頭模式的就緒判斷');

  const headedBlock = readyBlock.slice(headedStart, headedEnd);
  assert.match(headedBlock, /\$_\s*\.ExecutablePath\s*-ieq\s*\$TargetBrowserPath/);
});
