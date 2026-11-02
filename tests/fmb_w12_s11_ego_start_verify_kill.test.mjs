// tests/fmb_w12_s11_ego_start_verify_kill.test.mjs
//
// 回歸測試：scripts/ego-start.ps1 在清理舊程序後，不能拿「下達終止指令之前的舊快照」
// 來判定 profile 仍被占用。Stop-Process -Force 只是送出終止要求（非同步），重試迴圈
// 最後一次迭代拍到的 $Remaining 仍可能列出「剛被要求結束」的瀏覽器；拿它直接 exit 1，
// 會把一個其實已經殺乾淨的 start 誤報成 EGO_NOT_READY (profile still in use)。
// 同 repo 的 scripts/ego-stop.ps1 已為同一個 bug 加上「重新查詢 + 有界寬限」的修正
// （見其「強制終止是非同步的」註解），ego-start.ps1 缺這一段。
//
// 這些測試只讀 repo 內的 .ps1 原始碼（不 spawn PowerShell、不連線、不讀寫 repo 外的
// 路徑、不需要任何憑證），因此在任何平台上都能穩定執行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(new URL('../scripts/ego-start.ps1', import.meta.url));
const script = readFileSync(SCRIPT_PATH, 'utf8');

const KILL_CALL = 'Stop-Process -Id';
const SWEEP_START = '# Stop-Process only requests termination';
const PROFILE_BUSY = 'EGO_NOT_READY (profile still in use)';
const PROC_QUERY = /Get-EgoProcesses|Get-CimInstance\s+Win32_Process/;

// 切出「清理舊程序 → 判定 profile 是否仍被占用」這一段，並回傳最後一次強制終止之後的文字。
function sweepRegion() {
  const start = script.indexOf(SWEEP_START);
  assert.ok(start >= 0, `找不到清理區塊起點：${SWEEP_START}`);
  const busy = script.indexOf(PROFILE_BUSY);
  assert.ok(busy > start, `找不到 ${PROFILE_BUSY} 失敗分支`);
  const segment = script.slice(start, busy);
  const lastKill = segment.lastIndexOf(KILL_CALL);
  assert.ok(lastKill >= 0, '清理區塊內應至少有一次 Stop-Process -Id 呼叫');
  return { segment, busy, tail: segment.slice(lastKill + KILL_CALL.length) };
}

test('下達最後一次強制終止之後，必須重新查詢程序狀態才判定 profile 是否仍被占用', () => {
  const { tail } = sweepRegion();
  assert.match(
    tail,
    PROC_QUERY,
    'ego-start.ps1 在最後一次 Stop-Process 之後沒有任何程序重新查詢，仍以終止前的舊快照判定失敗：' +
      '剛被要求結束的 chrome.exe 會讓一次其實成功的 start 誤報 EGO_NOT_READY (profile still in use) 並 exit 1',
  );
});

test('重新查詢前必須有一段有界的寬限等待（不得用無界迴圈）', () => {
  const { tail } = sweepRegion();
  assert.match(tail, /Start-Sleep/, '重新查詢前應等待程序真正結束（缺 Start-Sleep）');
  assert.match(
    tail,
    /for \(\$[A-Za-z_]\w* = 0; \$[A-Za-z_]\w* -lt \d+; \$[A-Za-z_]\w*\+\+\)/,
    '寬限等待必須是有限次數的迴圈，不可用無界迴圈卡住啟動流程',
  );
});

test('程序真的殺不掉時，仍必須回報 EGO_NOT_READY 並以非 0 結束', () => {
  const { busy } = sweepRegion();
  const after = script.slice(busy, busy + 200);
  assert.match(after, /exit 1/, '失敗分支不可被刪掉，必須保留 exit 1');
});

test('清理重試次數必須有上限（避免殭屍程序讓啟動無限等待）', () => {
  assert.match(
    script,
    /for \(\$Attempt = 0; \$Attempt -lt \d+; \$Attempt\+\+\)/,
    '清理重試迴圈必須有明確上限',
  );
});

test('只有確認沒有任何 ego 程序存活後，才可刪除 profile 的 Singleton 鎖檔', () => {
  const { busy } = sweepRegion();
  const lockIdx = script.indexOf('@("SingletonLock"');
  assert.ok(lockIdx > busy, 'Singleton 鎖檔必須在 EGO_NOT_READY 失敗分支（含 exit 1）之後才刪除');
});
