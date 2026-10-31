# 02 — STRIDE 威脅目錄

## 1. 評分方法

- **可能性（L）**：低 / 中 / 高。以「本機單使用者」前提 `P1` 為基準；若前提失效，依 `README.md` 第 5 節重算。
- **影響（I）**：低 / 中 / 高 / 極高。以「一次性、無痕、可轉移的憑證外洩」為極高（`A1`/`A2`/`A3` 等級）。
- **風險等級**：`P0`（本輪應修補，或至少加上偵測）／`P1`（下一輪）／`P2`（排入待辦）。
- 定性而不定量的理由：缺乏真實事件頻率資料，給出 CVSS 式分數會製造虛假精確度；此處分級只用於**排序**，對應到 `04-mitigation-roadmap.md`。
- 每條附「驗證方法」，讓後續審查者可以逐條結案（結案後請在 `04` 標記）。

> 以下 `C1`–`C6` 為既有控制代號，定義見 `README.md` 第 3 節，本檔不重述其原理。

## 2. S — Spoofing（身分偽冒）

| ID | 威脅情境 | L | I | 風險 | 既有緩解 | 缺口 | 證據 |
|---|---|---|---|---|---|---|---|
| `S-01` | **冒牌 daemon**：CLI 只憑 `GET /health` 回應內容判斷 daemon 是否健康；若 `127.0.0.1:9772` 被其他行程佔用並回傳 `{"ok":true,"chrome":true}`，CLI 會把 `A1` token 以 `x-tp-token` 送到該行程，並信任它回傳的所有頁面內容 | 中 | 極高 | **P0** | 無 | 無 daemon 身分驗證、無 instance 標識、埠號驗證過寬 | `[CODE]` `bin/tp-browser.js`：`readPort()` 只在 `port === 9774` 時回傳 9774，其餘一律回退 9772；`ensureRunning()` 只看 `/health` JSON |
| `S-02` | **冒牌 CDP 端點**：daemon 從 `http://127.0.0.1:9773/json/version` 取得 `webSocketDebuggerUrl` 後即建立連線；任何能佔用該埠的行程可中間人控制所有頁面操作與 cookie | 低 | 極高 | P1 | `C1` | 同上，CDP 無認證也無憑證綁定 | `[DOC]`（`bin/*.js` 有此端點讀取邏輯；daemon 端未提供） |
| `S-03` | **WSL2 埠混淆**：Windows 啟動器以「`/json/version` 的 `User-Agent` 是否含 `Linux`」判斷 9773 是否被 WSL Chrome 佔用；判斷錯誤時 Windows daemon 會掛到 WSL 的瀏覽器（反之亦然），造成跨環境操作與資料錯置 | 中 | 中 | P1 | 埠位避讓邏輯 | 以 UA 字串判斷身分本質上就是 spoofable | `[CODE]` `scripts/ego-start.ps1`；`scripts/tp-start.sh` 的 `TP_BROWSER_BIN` 分支 |
| `S-04` | **代理被釣魚**：頁面設計成登入表單，誘導代理 `fill()` 帳密或轉貼 OTP；代理無法區分真站與假站，且反偵測旗標讓頁面更像真站 | 中 | 高 | P1 | 無 | 無「憑證網域白名單」，無「填寫敏感欄位需人類確認」機制 | `[CODE]`（`p.fill` 存在）+ `[DOC]` |
| `S-05` | **Skill 檔偽冒**：`install.sh` 會把 `SKILL.md` 複製到四個 agent 工具目錄；任何能影響安裝來源或該目錄者，可在未來每個代理 session 冒充專案指示 | 低 | 高 | P1 | 無 | 無簽章、無版本戳記、無完整性檢查 | `[CODE]` `install.sh`／`install.ps1` |

**`S-01` 驗證方法**（不需真憑證）

```bash
# 1) 觀察目前 daemon.json 的埠，若為非 9772/9774，CLI 會回退 9772
cat ~/.local/share/ego-linux/daemon.json
# 2) 在測試環境以假 listener 佔用 9772（僅測試機），回 {"ok":true,"chrome":true}
#    再執行 tp-browser spaces，觀察假 listener 是否收到 x-tp-token 標頭（值應為 FAKE_VALUE_FOR_TEST）
```

## 3. T — Tampering（篡改）

| ID | 威脅情境 | L | I | 風險 | 既有緩解 | 缺口 | 證據 |
|---|---|---|---|---|---|---|---|
| `T-01` | **權限收斂靠啟動腳本而非 daemon**：`tp-start.sh`/`ego-start.ps1` 才會 `chmod 700`/`icacls`；若使用者照 `tp-browser doctor` 的修復提示直接 `node daemon/ego-browserd.js`，則 `DATA_DIR` 可能為 `0755`、`token` 與 `daemon.json` 為 `0644` | 高 | 高 | **P0** | `C6` | daemon 啟動時不自我收斂權限 | `[CODE]` `scripts/tp-start.sh`（`chmod 700 "$DATA_DIR"`、`chmod 600 token daemon.json` 都在 launcher）；`bin/tp-browser.js` 的 `doctor()` 建議直接跑 daemon |
| `T-02` | **`store.json` 未設定 `0600`**：`daemon/store.js` 以 `writeFileSync` + `rename` 落地，未指定 mode；內容含頁面 URL/標題（可能為案件、客戶、醫療、金融資訊）。同機者可讀可改，改 `targetId` 可讓代理操作到錯誤頁面 | 中 | 中 | P1 | 依賴 `DATA_DIR` 目錄權限 | 檔案自身無 mode；無完整性檢查 | `[CODE]` `daemon/store.js` `persist()` |
| `T-03` | **路徑逃逸邊角**：`safePath` 對「尚不存在」的目標無法 `realpath`；典型縫隙是檢查父目錄後才建立檔案（TOCTOU），或寫入時未用 `O_NOFOLLOW` | 中 | 高 | P1 | `C4` | 需以程式碼覆核實作細節 | `[HYP]` |
| `T-04` | **下載目錄不受控**：Chrome 下載由瀏覽器寫檔，daemon 的 `safePath` 管不到；若未以 CDP `Browser.setDownloadBehavior` 固定目錄，下載物落點取決於 profile 設定 | 中 | 中 | P1 | 未知 | 需覆核是否已設 | `[HYP]` |
| `T-05` | **提示注入 → 本機檔案改寫**：頁面文字進入 LLM 上下文後，代理可能被誘導產生「下一段腳本」去改寫本機檔案、安裝持久化、或把 token/cookie 外傳。與 `E-02` 同源 | 高 | 極高 | **P0** | 無 | 無輸出圍籬、無工具權限分層、無敏感路徑拒絕清單 | `[CODE]`（`runNodeJs()` 直接 `import()` 任意程式碼） |
| `T-06` | **安裝供應鏈**：`install.sh` 支援 `curl ... | bash`，內含 `git clone --depth 1`（未 pin commit/tag），無 checksum、無簽章；安裝時 `rm -rf` 並覆蓋 `APP_DIR` 子目錄 | 低–中 | 極高 | P1 | 無 | 無完整性驗證 | `[CODE]` |
| `T-07` | **CLI 重複檔漂移**：`bin/tp-browser.js` 與 `bin/ego-browser.js` 內容完全相同地各自存在；安全修補若只改一份，另一份即為舊漏洞 | 高（長期必然） | 中 | P1 | 無 | 應為 symlink 或共用模組 | `[CODE]` 兩檔逐行相同 |
| `T-08` | **profile-init 覆蓋競態**：同步採「來源檔案比目標大就覆蓋」等啟發式；`Cookies` 小於 64 KB 即被覆蓋、`Local Storage` 小於 1.5 MB 即被覆蓋，可能在 agent profile 有較新登入態時反而回退 | 中 | 中 | P2 | 以大小啟發式避免覆蓋 | 無版本/時間戳比較、無備份 | `[CODE]` `tools/profile-init.js` |
| `T-09` | **資料目錄不一致**：`profile-init.js` 支援 `EGO_LINUX_DATA_DIR`，但 `bin/*.js` 把 `DATA_DIR` 硬編為 `~/.local/share/ego-linux`；設定該變數者會初始化 A 目錄卻操作 B 目錄 | 低–中 | 中 | P2 | 無 | 同一環境變數未被 CLI 尊重 | `[CODE]` |
| `T-10` | **證據可被覆寫**：截圖以相對路徑寫入、同名即覆蓋且無 append-only 記錄；事後無法證明檔案未被替換 | 中 | 高 | P1 | 無 | 無雜湊清單、無時戳、無寫入即簽章 | `[CODE]`（`p.screenshot({path})` 語意）+ `[DOC]` |
| `T-11` | **文件引用的工具檔不存在**：`README.md` 與 `SKILL.md` 指示 `tp-browser nodejs < tools/cookies-export.ego.js`，但 repo 內 `tools/` 只有 `profile-init.js`。代理照做時會從**當前工作目錄**解析該路徑，若 CWD 為下載資料夾或被 clone 的第三方專案，等於執行攻擊者提供的程式碼 | 中 | 高 | P1 | CLI 設計上拒收 argv 檔案路徑 | 文件仍引導以 shell 重導向讀檔 | `[CODE]`（`tools/` 檔案清單；`runNodeJs` 只從 `-e`/stdin 取碼） |

## 4. R — Repudiation（不可否認性）

| ID | 威脅情境 | L | I | 風險 | 既有緩解 | 缺口 | 證據 |
|---|---|---|---|---|---|---|---|
| `R-01` | **無操作稽核**：無「何人／何時／對哪個 `targetId`／導航到何 URL／執行了什麼 RPC」的紀錄；事故發生時無法區分是人類、代理、還是被注入的代理所為 | 高 | 中 | P1 | `logs/daemon.log` 存在（內容未驗證） | 無結構化稽核、無雜湊鏈、無保留政策 | `[HYP]`（需覆核日誌內容與是否含 token／查詢字串） |
| `R-02` | **證據能力爭議**：擷取的頁面文字／截圖缺少時間戳、來源 URL、瀏覽器版本、內容雜湊；在訴訟或調查情境中難以主張「與當時頁面一致」 | 高 | 高 | P1 | 無 | 無 evidence 模式 | `[CODE]`（功能不存在） |
| `R-03` | **啟停無紀錄**：`tp-stop.sh`／`ego-stop.ps1` 以 `pkill -f`、`Stop-Process` 強制終止，僅印出計數，未記錄終止原因與目標 | 高 | 低 | P2 | 輸出 `TP_STOPPED`／`EGO_STOPPED (terminated N)` | 無終止原因、無 pid 對照 | `[CODE]` |
| `R-04` | **取捨：腳本不落地 vs 可回溯**：代理腳本只存在暫存檔並於結束時刪除（利於保密），但事故後無從重建當時執行了什麼 | 高 | 中 | P2 | 刪除暫存 | 建議改存「雜湊 + 摘要」而非全文 | `[CODE]` |

## 5. I — Information Disclosure（資訊洩漏）

| ID | 威脅情境 | L | I | 風險 | 既有緩解 | 缺口 | 證據 |
|---|---|---|---|---|---|---|---|
| `I-01` | **CDP 埠無認證且跨使用者可達**：`127.0.0.1:9773` 對同機所有 OS 使用者開放；`GET /json/list` 取得頁面清單、再以 WebSocket 呼叫 `Network.getAllCookies` 即可帶走 `A2` 全部登入態，**完全不需要 `A1` token** | 中 | 極高 | **P0** | `C1`（只擋網路） | loopback 不是 per-user 隔離；無 unix socket / pipe 選項 | `[CODE]` 啟動旗標；`[DOC]` CDP 無認證 |
| `I-02` | **單一永久明文 bearer**：token 無 TTL、無輪替、無撤銷、無「綁定 daemon 實例」；一旦落入備份、雲端同步的家目錄、容器映像或日誌，即永久全權 | 中 | 極高 | P1 | `C3`（只保護比對時的時序） | 無生命週期管理 | `[CODE]`/`[DOC]` |
| `I-03` | **憑證集中化（本模型影響最大的一項設計選擇）**：`tools/profile-init.js` 預設把母瀏覽器的 `Login Data`、`Login Data For Account`、`Web Data` 複製進 agent profile，並複製 `Local State` 的 `os_crypt`（解密金鑰）。結果是「原本要攻擊兩個地方，現在只要攻擊一個目錄」 | 高 | 高 | **P0/P1** | `C6`（檔案權限） | 無 opt-in、無提示、無「僅複製 Bookmarks」模式 | `[CODE]` |
| `I-04` | **token 進入 URL**：若 SSE 以 `EventSource` 實作且把 token 放在查詢字串，token 會出現在日誌、瀏覽器歷史、程序中 | 中 | 高 | P1 | `C3` | `lib/sdk.js` 未提供，需覆核 | `[HYP]` |
| `I-05` | **頁面內容外送第三方 LLM**：`p.text()`／`evaluate` 的結果直接進 stdout → 進 LLM 上下文；使用者可能未意識到頁面上的第三人個資、對話內容、案件資料已被送到模型供應商 | 高 | 高 | P1 | 無 | 無紅旗提示、無欄位遮罩、無本地模型選項說明 | `[CODE]`（資料流） |
| `I-06` | **日誌含敏感內容**：`logs/daemon.log`／`chrome.log` 可能記錄完整 URL（含查詢字串）與錯誤內文；`Get-CimInstance` 掃描結果可能含 profile 路徑 | 中 | 中 | P2 | 目錄權限 | 無日誌分級、無遮蔽 | `[HYP]` |
| `I-07` | **暫存腳本殘留**：`finally` 會刪除，但 `SIGKILL`／斷電不會；`$TMPDIR/tp-run-*/script.mjs` 內含提示與擷取內容 | 低–中 | 中 | P2 | `0700`/`0600` | 無啟動時清掃 | `[CODE]` |
| `I-08` | **工作區落在雲端同步資料夾**：若使用者在 `~/OneDrive`、`~/Dropbox` 下執行，截圖與下載物會自動上雲 | 中 | 中 | P2 | 無 | 無路徑警告 | `[HYP]` |
| `I-09` | **跨 OS 共用 token**：`tp-start.sh` 在 WSL 的 `--headed` 分支會把 Windows 端的 `token` 與 `daemon.json` 複製到 WSL 家目錄（並 `chmod 600`），使同一 bearer 在兩個環境、多個檔案落地 | 中 | 中 | P2 | `chmod 600` | 無獨立憑證、無輪替 | `[CODE]` |
| `I-10` | **cookie 明文落地與跨機搬移**：匯出/匯入流程會產生檔案（`0600`）但內容為明文 session；檔案被複製到另一台機器即等於帳號被複製 | 中 | 高 | P1 | `0600` | 無加密、無有效期提示、無「用完即刪」 | `[DOC]` |

**`I-01` 驗證方法**（僅在自有測試機執行；只輸出狀態碼與欄位數，不輸出內容）

```bash
# 期待：連線被拒（若成功，代表同機任何使用者/行程皆可接管瀏覽器）
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 2 http://127.0.0.1:9773/json/version
# 若上一步回 200，再用另一個 OS 帳號重試，即可證明跨使用者可達
```

## 6. D — Denial of Service（阻斷服務）

| ID | 威脅情境 | L | I | 風險 | 既有緩解 | 缺口 | 證據 |
|---|---|---|---|---|---|---|---|
| `D-01` | **無 token 的狀態變更端點**：`scripts/tp-start.sh`、`scripts/tp-stop.sh` 以 `curl -fsS "http://127.0.0.1:9772/flush-and-close"`（無標頭、預設 GET）呼叫；這暗示該端點**不需認證**。任何本機行程可隨時 flush／關閉代理瀏覽器，中斷長時間任務與證據蒐集 | 高（本機）/ 低–中（網頁） | 中 | **P0** | `C2`（Host/Origin） | 端點本身無 token；`C2` 對「本機行程」無效；網頁面受混合內容與 Private Network Access 部分限制，但 `http` 來源頁面或 DNS rebinding 仍可能觸發 | `[CODE]` 腳本呼叫方式 |
| `D-02` | **`/health` 無認證**：洩漏「代理瀏覽器是否運行、是否掛上 Chrome」，可作為攻擊前置偵察 | 高 | 低 | P2 | 無 | 可改為需 token 或僅回 `{ok}` | `[CODE]` 腳本無 token 呼叫 |
| `D-03` | **`/newtab` 被濫用**：啟動器以 `http://127.0.0.1:9772/newtab` 作為起始頁（無 token）；若該端點可建立分頁並接受 URL 參數，本機行程或 `http` 頁面可灌分頁／開啟任意頁面 | 中 | 低–中 | P2 | `C2` | 需覆核是否需 token、是否接受外部 URL 參數 | `[HYP]` |
| `D-04` | **無資源上限**：代理腳本可在頁面內執行任意迴圈（`SKILL.md` 範例即為多次 scroll loop + `innerText` 100k），daemon 無 CPU/記憶體/時間配額 | 中 | 中 | P2 | 無 | 無 per-call timeout 之外的上限 | `[CODE]`（`evaluate` 無配額概念） |
| `D-05` | **`pkill -f` 過寬**：以子字串比對命令列終止行程；若使用者的其他 node/chrome 命令列含相同字串（例如在同一 profile 路徑上跑測試），會被一併終止 | 低 | 中 | P2 | 限定了 profile 路徑字串 | 應改用 pidfile／`daemon.json` 的 pid | `[CODE]` |
| `D-06` | **埠位判定失敗**：`readPort()` 對非 9774 一律回 9772；若 `daemon.json` 損毀或 `--alt-port` 之外的埠被使用，CLI 會連錯埠並反覆觸發啟動器 | 中 | 低 | P2 | 啟動器會重試 | 無明確錯誤訊息 | `[CODE]` |

## 7. E — Elevation of Privilege（權限提升）

| ID | 威脅情境 | L | I | 風險 | 既有緩解 | 缺口 | 證據 |
|---|---|---|---|---|---|---|---|
| `E-01` | **root 自動關閉沙箱**：`tp-start.sh` 在 `id -u == 0` 時自動加 `--no-sandbox`。惡意網頁的渲染程序逃逸即等同 **root**（容器、CI、雲端開發機常見以 root 執行） | 中（容器/CI 高） | 極高 | **P0** | 無 | 應改為「拒絕以 root 執行」或要求明確的 `TP_ALLOW_ROOT=1` | `[CODE]` `scripts/tp-start.sh` |
| `E-02` | **代理程式碼執行＝本機全權**：`tp-browser nodejs` 把 stdin 內容寫成 `script.mjs` 後 `import()`，未啟用任何 Node 權限模型；代理從「能操作瀏覽器」升級為「能讀 `A1`/`A2`/`A3`、能連外、能改檔」。與 `T-05` 合併即為本專案最高風險鏈 | 高 | 極高 | **P0** | 暫存檔 `0600`、結束即刪 | 無 `--experimental-permission`、無敏感路徑拒絕清單 | `[CODE]` `bin/tp-browser.js` `runNodeJs()` |
| `E-03` | **Session 0 → Session 1 執行橋接**：`ego-start.ps1` 在 `SessionId -eq 0`（SSH）時，把啟動命令寫成 `launch-headed-gui.ps1` 並以 `schtasks /Create ... /IT` 在使用者互動桌面執行。這是刻意的功能，但同時是「以非互動 session 在使用者桌面執行程式」的原語；該 `.ps1` 檔殘留於磁碟且無完整性檢查 | 低 | 高 | P1 | 執行後刪除排程工作（檔案未刪） | 檔案殘留、`$ErrorActionPreference="SilentlyContinue"` 使失敗無聲 | `[CODE]` |
| `E-04` | **安裝即取得代理行為控制權**：安裝腳本寫入四個 agent 工具的 skills 目錄，並在 `/usr/local/bin` 可寫時建立全域 symlink。影響面從「一個 CLI」升級為「這台機器上所有 LLM 代理的預設行為」 | 中 | 高 | P1 | 無 | 無明確同意、無範圍限制、無簽章 | `[CODE]` `install.sh`／`install.ps1` |
| `E-05` | **命令列拼接注入（已評估為低）**：`ego-start.ps1` 以字串插值組 `Win32_Process.Create` 的 `CommandLine`（含 `TP_BROWSER_BIN`）。由於 Windows 檔名不可含 `"`，且 `Test-Path` 先行檢查，實務上難以突破引號；Linux 端以 argv 傳遞（`spawn_detached`），無 shell 解析 | 極低 | 中 | P2 | `Test-Path` 檢查 | 仍建議改用參數陣列，避免未來改動引入風險 | `[CODE]`（此為分析結論，非已確認漏洞） |
| `E-06` | **瀏覽器渲染程序 RCE**：任何 Chrome 0-day 或惡意擴充即取得使用者權限；`--disable-extensions`（無頭）降低擴充面，但有頭模式不適用 | 低 | 高 | P2 | 無頭模式關閉擴充 | 屬瀏覽器邊界，列為**接受風險**（建議在文件明示） | `[DOC]` |
| `E-07` | **多使用者主機的全域 symlink**：`install.sh` 在 `/usr/local/bin` 可寫時為 10 個命令建立全域 symlink，可能覆蓋或誤導其他使用者 | 低 | 中 | P2 | 僅在可寫時執行 | 無提示、無 `--no-global` 選項 | `[CODE]` |

## 8. Top-10 風險排序（建議修補順序）

| 排序 | 威脅 | 風險 | 一句話說明 | 對應修補 |
|---|---|---|---|---|
| 1 | `E-02` + `T-05` | P0 | 網頁內容 → LLM → 本機任意程式碼，並可直取 token 與全部 cookie | `M-01` |
| 2 | `I-01` | P0 | CDP 埠無認證，同機其他使用者可直接抓走全部登入態 | `M-07` |
| 3 | `E-01` | P0 | 以 root 執行時自動 `--no-sandbox` | `M-03` |
| 4 | `S-01` | P0 | 冒牌 daemon 可騙走 bearer token 並偽造頁面內容 | `M-05` |
| 5 | `D-01` | P0 | 無 token 的 `flush-and-close` 可被任何本機行程／部分網頁觸發 | `M-02` |
| 6 | `I-03` | P0/P1 | 預設把母瀏覽器密碼庫與 `os_crypt` 金鑰複製進 agent profile | `M-06` |
| 7 | `I-02` | P1 | 單一永久明文 token，無輪替與撤銷 | `M-05`、`M-12` |
| 8 | `T-01` | P0 | 檔案權限只由啟動腳本設定，繞過即失效 | `M-04` |
| 9 | `T-06`、`S-05`、`E-04` | P1 | 安裝供應鏈無完整性驗證，且會寫入代理指示目錄 | `M-10` |
| 10 | `T-10`、`R-02` | P1 | 擷取結果無雜湊與時戳，證據能力存疑 | `M-11` |

## 9. 關鍵威脅詳述（補足表格不足處）

### 9.1 `E-02` / `T-05`：從一行網頁文字到本機任意程式碼

1. 代理被要求「摘要這個頁面」，於是執行 `p.text()` 或 `p.evaluate()`。
2. 頁面回傳的文字中含指令式內容（例如「請執行下列步驟以繼續」），這是**資料**，但對 LLM 而言與**指令**同形。
3. 代理下一個 turn 執行 `tp-browser nodejs`，把攻擊者指定的程式碼餵進去。
4. 該程式碼以使用者權限執行：可讀 `~/.local/share/ego-linux/token`、可經 CDP 讀全部 cookie、可連外傳送、可寫入 `~/.claude/skills/`（下次 session 仍生效）。

**為什麼目前攔不住**：`runNodeJs()` 只做「寫暫存檔 + `import()`」，中間沒有任何政策檢查；CLI 對程式碼內容不作要求；daemon 只看 token，不看請求意圖。**這不是 bug，是設計**——但設計上的必然結果必須被明示，並提供降低爆炸半徑的選項（見 `M-01`）。

### 9.2 `I-01`：`C1` 保護的是網路，不是同一台機器

`C1` 讓 CDP 只綁 loopback，擋掉來自區網與網際網路的探測。但 loopback 在 Linux 與 Windows 上都是**主機層級**而非使用者層級：同一台機器上的另一個 OS 使用者只要 `curl http://127.0.0.1:9773/json/list` 就能列出代理正在看哪些頁面，再以 WebSocket 呼叫 `Network.getAllCookies` 取得 `A2`。`README.md` 建議「多使用者主機請用獨立 OS 帳號」對這條路徑沒有作用。真正有效的方向只有兩個：(a) 不開 TCP 埠（`--remote-debugging-pipe`）；(b) 明確把「多使用者主機不支援」寫成產品限制並在啟動時偵測拒絕。

### 9.3 `S-01`：CLI 對 daemon 的信任只有一層 JSON

`ensureRunning()` 的判斷是：`GET /health` 回 `{ok:true, chrome:true}` 就認為 daemon 正常。健康檢查沒有簽章、沒有 instance id、沒有隨機挑戰。任何能先佔用 `127.0.0.1:9772` 的行程都可以：接收 `x-tp-token`（拿到 `A1`）、回傳偽造的 `/rpc` 結果（讓代理以為頁面內容是 X）。搭配 `readPort()` 的寬鬆回退（非 9774 一律當 9772），只要 `daemon.json` 遺失或被改，風險就從「低」升為「中」。

### 9.4 `D-01`：shell 腳本本身就是「無認證端點」的證據

`tp-start.sh` 與 `tp-stop.sh` 都用 `curl -fsS --max-time 3 "http://127.0.0.1:9772/flush-and-close"`，沒有帶任何標頭。這代表該端點在設計上不驗 token。因為 `curl` 未指定 `-X POST`，預設是 **GET**，因此任何本機行程、任何 `http://` 來源頁面、或經 DNS rebinding 的頁面都可能觸發它。後果不只是 DoS：`flush-and-close` 會把 cookie 落地後關閉瀏覽器，**在蒐證進行中觸發即可能造成狀態遺失**。

### 9.5 `I-03`：便利性與爆炸半徑的取捨

`profile-init.js` 的目標是「無痛沿用既有登入態」，因此複製 Cookies、Local Storage、IndexedDB 是合理的。但它同時複製了 `Login Data`（已存密碼資料庫）、`Login Data For Account`、`Web Data`，以及 `Local State` 中的 `os_crypt` 金鑰。這使得 `profile-agent/` 成為**母瀏覽器憑證的完整鏡像**：任何能讀該目錄的行程，不必破解 DPAPI/keychain 即可對母瀏覽器的密碼庫做離線解密（同一使用者權限下）。原本「agent profile 被看光」的影響是「已登入的網站」，現在變成「所有存過密碼的網站」。這一項應由專案所有者決定是否保留（見 `04` 的決策點 D-2）。
