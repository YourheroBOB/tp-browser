# 03 · CLI 與啟動／停止腳本審查（`bin/*.js`、`scripts/*`）

這一層是 Agent 與使用者唯一的操作介面。它的問題通常不會讓程式「壞掉」，而是讓**等待時間不可預期**（卡住、無限阻塞）或**默默做錯事**（誤殺程序、登入態沒存到）。

---

## L-01 `bin/tp-browser.js` 與 `bin/ego-browser.js` 逐字重複、版本字串不一致 · **P1**

- **位置**：`bin/tp-browser.js`、`bin/ego-browser.js`（兩檔內容幾乎完全相同，約 230 行）；`version` 輸出 `TooPower Browser (tp-browser) 0.3.1`，但 `package.json` 為 `"version": "0.3.0"`。
- **影響**：
  1. 任何修法都要改兩份，實務上必然漂移（目前已經出現版本不一致）。
  2. `tp-browser doctor`／`version` 是排查第一步，版本對不上會直接誤導使用者與 Agent。
- **建議修法**：`bin/ego-browser.js` 改為極簡轉發（`await import('./tp-browser.js')` 或反之），版本改為 `JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version`。注意：`resolveScript()` 以 `import.meta.url` 推導 repo 根目錄，轉發時要保留正確的相對位置。
- **驗證方式**：`node bin/tp-browser.js version` 與 `node bin/ego-browser.js version` 輸出一致且等於 `package.json` 版本；`node bin/ego-browser.js doctor` 在無 daemon 情况下仍正常印出修復指引、退出碼符合預期。

---

## L-02 `runNodeJs()` 以 `process.exit()` 硬退出，可能截斷 stdout · **P1**

- **位置**：`bin/*.js` · `runNodeJs()` 結尾 `process.exit(exitCode);`（註解自承「SSE event stream 讓 event loop 不退出」）。
- **影響**：Agent 的單 turn 批次腳本可能輸出大量結果。`process.exit()` **不等待 stdout 排空**；在 Windows 管線與長輸出下，最後一段輸出可能被丟棄 —— 表現為「Agent 拿到的內容少了一截」，且無錯誤訊息，極難診斷。
- **建議修法**：
  - 在 `lib/sdk.js` 提供 `close()`（AbortController 中止 SSE、`clearInterval` 並 `unref` 所有 timer），CLI 改為 `process.exitCode = code; await sdk.close?.();` 讓 event loop 自然結束。
  - 短期保險：`await new Promise((r) => process.stdout.write('', r))` 之後再 `process.exit()`（若仍必須硬退出）。
- **驗證方式**：對本機 `tests/serve.mjs` 跑一支輸出 5 MB 的腳本並以 `| wc -c` 比對位元組數，重複 20 次；現況會偶發短少，修法後應 100% 相符。

---

## L-03 `rpcCmd()` 的 fetch 無逾時，可永久掛住 · **P1**

- **位置**：`bin/*.js` · `rpcCmd()`：`await fetch(`${daemonBase(port)}/rpc`, {...})` 未帶 `signal`（對照同檔 `health()` 有 `AbortSignal.timeout(2500)`）。
- **影響**：daemon 若接受連線但卡住（例如正卡在一個 30 秒的 CDP 指令、或 event loop 被 S-01 的同步寫檔阻塞），`tp-browser spaces`／`status` 會**無限期等待**，Agent 的 turn 直接卡死且無法回報。
- **建議修法**：加 `signal: AbortSignal.timeout(30000)`；依 `res.status` 區分 401（token 不符 → 提示重新 `tp-start`）與 5xx（daemon 內部錯誤 → 建議看 `daemon.log`），並把 `error.code`/`error.name` 一併印出（見 T-06）。
- **驗證方式**：以假 HTTP 伺服器（`node:http`，只 accept 不回應）指向 `daemon.json` 的 port，斷言 30 秒內結束並印出可讀錯誤；`AbortSignal.timeout` 可用 `TP_RPC_TIMEOUT_MS` 調小以縮短測試時間。

---

## L-04 `spawnSync` 無 `timeout`，啟動器可無限阻塞 CLI · **P1**

- **位置**：`bin/*.js` · `runLauncher()` 的 `spawnSync('powershell.exe', psArgs, { stdio })` 與 `spawnSync('/bin/sh', shArgs, { stdio })`。
- **影響**：啟動器本身含固定 sleep 與最多 10~12 秒的輪詢，已是數秒級；若 PowerShell/schtasks 卡住（Session 0、UAC、`schtasks` hang、被防毒攔截），CLI **完全沒有輸出地永久阻塞**（`quietStdout` 模式只保留 stderr，而啟動器此時也不一定輸出）。
- **建議修法**：`spawnSync(..., { timeout: 60000, killSignal: 'SIGKILL' })`；逾時時印出「啟動逾時，請執行 `tp-browser doctor`」；並在呼叫前先 `console.error('[tp-browser] starting browser...')` 讓 Agent 知道正在等待（可觀測性，見 O-05）。
- **驗證方式**：以 `TP_LAUNCHER_SLEEP` 之類的測試用環境變數（或暫時把啟動器腳本替換為 `sleep 120` 的假腳本，透過覆寫 `TP_START_SCRIPT`）驗證 60 秒後 CLI 退出且錯誤訊息正確。

---

## L-05 停止流程依 cmdline 掃殺，且 Windows 端未先 flush · **P0**

- **位置**：
  - `scripts/tp-start.sh`：`pkill -f "ego-browserd.js"`、`pkill -f "tp-browserd.js"`、`pkill -f "$PROFILE_DIR"`。
  - `scripts/tp-stop.sh`：先 curl `/flush-and-close`（兩個 port），`sleep 1.0` 後 `pkill -f ...`。
  - `scripts/ego-stop.ps1`：以 `Get-CimInstance Win32_Process` 比對 `*ego-browserd.js*` 或 `*ego-linux*profile-agent*` 直接 `Stop-Process -Force`，**沒有先呼叫 `/flush-and-close`**。
- **影響**：
  1. **登入態遺失**：Windows 端直接 `-Force` 終止 Chrome，Cookie/Storage 可能尚未落盤，使用者下次要重新登入（直接打擊產品最核心的「Cookie 主權」賣點）。
  2. **誤殺**：任何 cmdline 含 `profile-agent` 路徑的程序都會被殺（使用者自己開的編輯器、備份/同步工具、`grep`、甚至另一個 agent 的 profile-init）。
  3. **破壞雙軌並存**：`pkill -f "ego-browserd.js"` 會殺掉 **alt-port 的第二個 daemon**（`:9774`），讓 Windows/WSL2 雙軌機制失效。
  4. `tp-stop.sh` 執行後**無驗證**是否真的停止，一律印 `TP_STOPPED`；`ego-stop.ps1` 的 pattern 也不含 `chromium.exe` 等變體。
- **建議修法**：
  - 啟動時寫 pidfile（`$DATA_DIR/run/daemon-<port>.pid`、`chrome-<port>.pid`），停止時**只**依 pidfile 操作，並在操作前驗證 `ps -p <pid> -o command=` 含預期關鍵字（防止 pid 重用）。
  - 統一流程：`/flush-and-close` → `SIGTERM` → 等最多 3 秒 → 仍存活才 `SIGKILL`，最後以 `kill -0` 驗證並印出實際結果（成功/已不在/失敗）。
  - Windows 端比照辦理：先 `Invoke-RestMethod /flush-and-close`，再對 pidfile 內的 pid `Stop-Process`。
  - 保留一個 `--force-all` 明確選項給「pidfile 遺失」的救援情境，並在輸出中大聲提示。
- **驗證方式**：在本機開兩個實例（`9772/9773` 與 `--alt-port` 的 `9774/9775`），對其一執行 stop，斷言另一個 `/health` 仍為 `{"ok":true,"chrome":true}`；另在登入狀態下（以本機測試頁設定 cookie）執行 stop/start，斷言 cookie 仍存在（**cookie 值一律使用 `FAKE_VALUE_FOR_TEST`**）。

---

## L-06 啟動競態：無鎖，兩個 Agent 可能同時拉起兩個 daemon · **P2**

- **位置**：`bin/*.js` · `ensureRunning()`（health 失敗即 `runLauncher('start')`）；`scripts/tp-start.sh`、`scripts/ego-start.ps1` 無鎖檔。
- **影響**：兩個 Agent 同時執行 `tp-browser nodejs` → 兩邊都判定未啟動 → 各拉一份 daemon → 其中一份 `EADDRINUSE` 崩潰（daemon 端行為未取得，待確認），CLI 之後只重讀 health，可能連到非預期實例或短暫失敗。Windows 端更嚴重：兩個 `ego-start.ps1` 會互相殺掉對方的程序。
- **建議修法**：以原子鎖 `openSync(lockPath, 'wx')`（或 `mkdirSync`）建立 `$DATA_DIR/run/start.lock`，內容寫入 pid+時間戳；取鎖失敗時**不另起**，改為輪詢 health 最多 15 秒等待既有啟動完成；鎖檔超過 120 秒且有 pid 不存在時視為 stale 並清除。daemon 端遇到 `EADDRINUSE` 應先探測該 port 是否已有健康實例，是則靜默退出 0。
- **驗證方式**：以 `bash -c 'tp-start & tp-start & wait'` 同時觸發 5 次，斷言最終只有一個 daemon 在跑、health 正常、且沒有程序被留下；重複 20 輪。

---

## L-07 啟動時固定 `sleep` 再開 Chrome，headed 模式可能留下錯誤分頁 · **P2**

- **位置**：`scripts/tp-start.sh`（`spawn_detached ... daemon` 後 `sleep 0.3`）與 `scripts/ego-start.ps1`（`Win32_Process.Create` daemon 後 `Start-Sleep -Milliseconds 400`）。
- **影響**：headed 模式啟動時 Chrome 的第一個 URL 是 `http://127.0.0.1:$DAEMON_PORT/newtab`。若 daemon 尚未完成監聽（冷啟動、磁碟慢、防毒掃描），Chrome 會留下 `chrome-error://chromewebdata` 分頁，使用者一開就看到錯誤頁；後續 Agent 可能把該頁當成 `p1`。
- **建議修法**：把固定 sleep 改為輪詢 daemon 的 `/health`（**不要求 `chrome:true`**）最多 3 秒（每次 100 ms，指數微退避），逾時才繼續（並記 warn）。
- **驗證方式**：在 CPU 負載下（例如 `--cpu-load` 或同時跑 build）連續啟動 20 次 headed，統計出現錯誤分頁的次數（現況 > 0，修法後應為 0）。

---

## L-08 日誌檔只 append 不輪替 · **P2**

- **位置**：`scripts/tp-start.sh` 的 `spawn_detached`（`openSync(process.argv[1], "a")` → `$LOGS_DIR/daemon.log`、`chrome.log`）；`scripts/ego-start.ps1` 的日誌處理（未見明確重導，待確認）。
- **影響**：常駐數月 + Chrome verbose 輸出 + 反覆重啟 → 單一 log 檔可達數百 MB；`tail`／上傳回報都變困難，且在磁碟小的機器上可能佔滿空間導致 state 檔寫入失敗（連鎖到 S-02/S-03）。
- **建議修法**：啟動時若檔案 > 10 MB 就 `mv` 成 `.log.1`（只保留一份）；daemon 內另以 `TP_LOG_MAX_LINES` 做輸出抽樣（見 O-01）。文件補一段 logrotate 範例。
- **驗證方式**：以 11 MB 假 log 觸發啟動，斷言產生 `.log.1` 且新檔為空；連續 5 次後目錄仍只有 2 個檔。

---

## L-09 `ego-start.ps1` 全域靜音錯誤 + 輪詢內高成本 CIM 查詢 · **P2**

- **位置**：`scripts/ego-start.ps1`：頂部 `$ErrorActionPreference = "SilentlyContinue"`，多處 `catch {}`；第 8 段輪詢迴圈（24 次 × 500 ms）每次 `Start-Sleep` 後都 `Get-CimInstance Win32_Process`（在健康檢查成功的那次）。
- **影響**：
  1. 失敗時使用者只看到 `EGO_NOT_READY`，**完全沒有原因**（找不到瀏覽器？port 被佔？schtasks 失敗？）→ doctor 也無法給出針對性建議。
  2. `Get-CimInstance Win32_Process` 在 Windows 上通常 100~300 ms（程序多時更久），把 12 秒的等待再放大。
- **建議修法**：`$ErrorActionPreference = "Stop"` 或至少在每個 `catch` 內輸出 `Write-Output "WARN: <動作> failed: $($_.Exception.Message)"`；把 `Get-CimInstance` 移到迴圈外只查一次（或改用 `Get-Process -Name $TargetExeNameBase` 過濾）；輸出改為單行可解析格式（見 O-05）。
- **驗證方式**：故意把 `TP_BROWSER_BIN` 指向不存在路徑，斷言輸出含明確原因而非僅 `EGO_NOT_READY`；量測啟動總耗時（CIM 移出迴圈後應少 1 秒以上）。

---

## L-10 Session 0 突圍使用固定 schtasks 名稱，併發會互踩 · **P2**

- **位置**：`scripts/ego-start.ps1`：`$TaskName = "TooPowerBrowserHeaded"`、`$GuiPs1 = ...\scripts\launch-headed-gui.ps1`、`/Create ... /F` 後 `/Run`，最後 `/Delete /F`。
- **影響**：兩個並行呼叫會互相覆寫 task 與 ps1（甚至刪掉對方剛建立、還沒 run 完的 task）；`launch-headed-gui.ps1` 每次重寫，若被同時讀取可能讀到半寫檔 → 視窗開不起來且無錯誤。
- **建議修法**：task 名與腳本名加 GUID/pid（`TooPowerBrowserHeaded-<guid>`、`launch-headed-gui-<pid>.ps1`），結束時只刪自己的；task 刪除前先確認 `/Query` 狀態為 Running/Ready，或保留 24 小時交由下次清理。
- **驗證方式**：同時觸發 3 次 headed 啟動（Session 0 環境），斷言 3 個視窗皆能開啟（或以 `/json/list` 觀察至少一個新分頁），且不留殘餘 task（`schtasks /Query | findstr TooPower` 為空）。

---

## L-11 WSL2 headed 分支覆寫 WSL 自身的 `token`/`daemon.json` · **P3**

- **位置**：`scripts/tp-start.sh` WSL2 headed 分支：`cp -f "$WIN_EGO_DIR/daemon.json" "$DATA_DIR/daemon.json"`、`cp -f "$WIN_EGO_DIR/token" "$DATA_DIR/token"`。
- **影響**：若 WSL 內也有自己的 daemon 在跑（雙軌），其 token 會被 Windows 的值覆蓋 → WSL CLI 立刻 401，且 `daemon.json` 的 port 也可能被改成 Windows 的，導致連到錯的實例。另外 `WIN_USER` 以三層 `dirname` 推導，路徑結構改變就會失效。
- **建議修法**：改存為 `daemon.win.json`／`token.win` 這類獨立檔名，或僅在「WSL 自身 daemon 未在跑」時才複製；`WIN_USER` 改用 `wslpath`/`cmd.exe /c echo %USERNAME%` 取得。
- **驗證方式**：同時啟動 WSL 與 Windows 軌，執行 WSL headed 後斷言 WSL 的 `tp-browser status` 仍正常（未被 401），且 `daemon.json` 的 port 未變。

---

## L-12 `systemd` 單元缺少崩潰迴圈與優雅停止設定 · **P2**

- **位置**：`scripts/ego-linux-browserd.service`、`scripts/ego-linux-chrome.service`。
- **影響**：
  1. 只有 `Restart=on-failure` + `RestartSec=3`，**沒有 `StartLimitBurst`/`StartLimitIntervalSec`** → 若 Chrome 因 profile 損壞而每次啟動即崩，會無限重啟並洗版 journal。
  2. `ExecStart=/usr/bin/env node ...` 依賴 systemd 的極簡 PATH，Node 由 nvm/asdf 安裝時常見 `status=203/EXEC`；錯誤訊息對使用者不友善。
  3. 沒有 `ExecStop`／`TimeoutStopSec`：`systemctl --user stop` 直接送 SIGTERM 給 Chrome，**不會**先呼叫 `/flush-and-close` → 登入態有機會遺失（與 L-05 同源）。
- **建議修法**：加 `StartLimitIntervalSec=60`、`StartLimitBurst=5`；`ExecStart` 改用絕對路徑（或 `Environment=PATH=...`）；加 `ExecStop=/usr/bin/curl -fsS --max-time 5 http://127.0.0.1:9772/flush-and-close`、`TimeoutStopSec=10`、`KillSignal=SIGTERM`。同時把 `RestartSec` 改為 `3`→`5` 並搭配 `Restart=always` 對 chrome 單元（瀏覽器崩潰屬可預期）。
- **驗證方式**：以 `systemctl --user` 在測試機（或容器內 systemd）啟停一次，確認 stop 前有 flush 請求（可在 daemon 端記 log）；把 `node` 移出 PATH 模擬失敗，確認錯誤訊息明確。
