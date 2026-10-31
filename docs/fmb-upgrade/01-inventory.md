# 語言版本、相依套件與執行環境盤點

> 基準：本文件只反映本次提供的 repository 內容快照。歷史測試記錄不等於目前仍可重現的支援承諾。

## 1. 語言與格式盤點

| 類別 | 技術／格式 | 宣告或實際用法 | 盤點結果 |
|---|---|---|---|
| 主要程式語言 | JavaScript | `package.json` 使用 `"type": "module"`，所有 `.js` 均以 ESM 執行 | 沒有 transpiler、Babel、TypeScript 或獨立的 ECMAScript target；實際語法下限由 Node.js parser 決定 |
| Node.js 應用程式 | Node.js | `package.json` 宣告 `"node": ">=22"` | 正式最低版本應以 Node.js 22 為基準；README 與歷史環境仍有 Node.js 20 落差 |
| CLI | Node.js ESM | `bin/tp-browser.js`、`bin/ego-browser.js` | 兩個入口內容近似，版本字串各自硬編碼 |
| 測試 | Node.js built-in test runner | `.js`、`.mjs` 測試檔使用 `node:test` | 沒有外部 test framework；`package.json` 尚未定義 `scripts.test` |
| POSIX 啟動／停止 | `/bin/sh` | `install.sh`、`scripts/tp-start.sh`、`scripts/tp-stop.sh` | 使用 `set -eu` 與 POSIX shell 慣例；未宣告最低 shell 規格 |
| Windows 啟動／停止 | PowerShell | `install.ps1`、`scripts/ego-start.ps1`、`scripts/ego-stop.ps1` | 使用 CIM/WMI、Task Scheduler、ACL 與 Windows Script Host；未宣告最低 PowerShell 版本 |
| Linux 常駐設定 | systemd user unit | `scripts/ego-linux-*.service` | 直接執行 `/usr/bin/env node`，沒有 Node.js 版本檢查，也沒有實驗 WebSocket flag |
| Windows 啟動輔助 | VBScript | 由 PowerShell 產生 `tp-browser-autostart.vbs` | 依賴 Windows Script Host；不是獨立版本控管的原始碼 |
| 測試頁面 | HTML | `tests/testpage.html` | 僅供本機瀏覽器測試 |
| 設定／資料 | JSON | package manifest、daemon metadata、TaskSpace ledger | 沒有明確 schema version 或 migration version |

### 1.1 有效語言基線

專案沒有 `ecmaVersion`、`.nvmrc`、Volta、mise 或其他語言版本檔。若維持 Node.js 22 最低版本，現代 JavaScript 語法由 Node.js 22 本身約束，不再需要另設 Babel／TypeScript transpilation 目標。

目前主要現代語法／API 包括：

- ESM `import`、dynamic `import()`。
- optional chaining、nullish coalescing及 spread syntax。
- `node:` module prefix。
- `fetch`、`AbortSignal.timeout`。
- Node.js global `WebSocket`。
- `fs.cpSync`、`fs.mkdtempSync`、atomic rename pattern。
- `node:test`、`node:assert/strict`。
- `process.exit()` 與 platform-specific process handling。

## 2. Node.js 版本與內建 API

### 2.1 宣告與實際使用

| 來源 | 宣告／行為 | 評估 |
|---|---|---|
| `package.json` | `engines.node >= 22` | 應作為正式最低版本；`engines` 本身只會由套件管理器提示，不能取代 runtime guard |
| README 快速開始 | Node.js `>=22`，或 Node.js 20 加 `--experimental-websocket` | 與 manifest 不一致，且 Node.js 20 已屬舊世代，應移除或明確降級為 legacy compatibility |
| `install.sh` 產生的 CLI／daemon wrapper | 一律加入 `--experimental-websocket` | Node.js 22+ 已不需要此旗標；未來移除前必須先確認 Node.js 22/24/新 major 都可正常啟動 |
| `install.ps1` 產生的 wrapper | 一律加入 `--experimental-websocket` | 同上；Windows Node.js 22+ 應使用一般 `node` 啟動 |
| systemd unit | `/usr/bin/env node ...`，沒有旗標 | 與 README 的 Node.js 20 fallback 不一致；Node.js 20 直接執行時可能沒有全域 `WebSocket` |
| `daemon/cdp.js` | 直接使用 global `WebSocket` | 是 Node.js 20/22 行為差異的關鍵點 |

### 2.2 主要內建 API 與最低能力

| API／模組 | 最低 Node.js 22 已涵蓋的能力 | 升級時需重測的行為 |
|---|---|---|
| global `WebSocket` | 原生 CDP WebSocket client | 連線、錯誤事件、close、timeout、session routing、pending request 清理 |
| global `fetch` | daemon／CLI loopback HTTP 與 SSE | timeout、body parsing、connection reuse、daemon 重啟後重連 |
| `AbortSignal.timeout` | health check 與本機 HTTP timeout | timeout 不應造成未處理 rejection |
| `node:fs` | ledger、Profile 初始化、CLI 暫存 script | atomic rename、權限、跨平台 path、Windows UNC／drive letter |
| `node:child_process` | 啟動 launcher、背景 browser process | detached process、stdout/stderr、signal／exit code |
| `node:test` | 單元與整合測試 | Node major 間 test discovery、timeout 與 assertion 行為 |
| `node:url` | `pathToFileURL` dynamic import | Windows drive letter、spaces、BOM 與 URL escaping |

### 2.3 Node.js 26 的定位

repository 的歷史記錄曾出現 Node.js 26，但較新的 major 不應直接取代 Node.js 22 的廣泛相容基線。建議將 Node.js 26 視為 canary：

- 先做 WebSocket/CDP、daemon restart、SSE、installer 與瀏覽器整合測試。
- 確認 Node.js 26 的生命週期與組織支援政策後，再決定是否成為一般部署目標。
- 即使可部署，也不應立即把 `engines.node` 提高到 `>=26`。

## 3. npm 與非 npm 相依盤點

### 3.1 npm manifest

| 類別 | 數量／狀態 | 說明 |
|---|---:|---|
| `dependencies` | 0 | 沒有直接 runtime npm dependency |
| `devDependencies` | 0 | 沒有第三方 test、lint 或 build tool |
| `optionalDependencies` | 0 | 無 |
| `peerDependencies` | 0 | 無 |
| lockfile | 未見 | 目前零依賴下不會造成 npm tree 漂移；一旦新增工具即應立即採 lockfile |
| `packageManager` | 未宣告 | 套件管理器版本不可重現 |
| npm `scripts` | 未宣告 | `npm test` 等標準入口目前不可依賴 |
| `node_modules` | runtime 不需要 | 程式直接使用 Node.js 與瀏覽器提供的能力 |

**重要限制**：零 npm dependency 不等於零漏洞。Node.js 本身、OS 函式庫、瀏覽器 binary、安裝時使用的 Git 與遠端下載來源仍是供應鏈的一部分。

### 3.2 Node.js 與瀏覽器原生相依

| 相依 | 類型 | 最低／版本狀態 | 風險與管理方式 |
|---|---|---|---|
| Node.js | 語言 runtime + 內建 API | manifest 為 `>=22` | 必須用顯式 runtime guard；追蹤 Node.js 安全公告與 LTS 生命週期 |
| Chromium/Chrome/Edge/Brave | 瀏覽器 runtime + CDP 對端 | 僅有歷史 Chrome/Chromium 150–155 記錄 | 應定義 qualified major 範圍並進行本機 smoke test |
| CDP protocol | 瀏覽器與 daemon 的介面契約 | 無版本協商欄位 | 以 method-level contract test 保護 session、target、network 等行為 |
| POSIX shell | OS runtime | 未宣告最低版本 | 安裝與啟動腳本應維持 POSIX 相容，避免只在單一 shell 可執行 |
| PowerShell / Windows Script Host | OS runtime | 未宣告最低版本 | 明確測試支援的 Windows build 與 PowerShell 版本 |
| systemd | Linux 選用服務整合 | 未宣告最低版本 | 驗證 user unit 的 `PATH`、Node.js 選擇、restart 與 stop 行為 |
| `curl` | POSIX health／stop 工具 | 未宣告最低版本 | 僅連 `127.0.0.1`；需納入 installer image inventory |
| `git` | 遠端安裝器取得程式碼 | 未固定版本 | 遠端安裝應改為固定 release artifact／commit |
| OS shared libraries | 間接 runtime | 隨 OS 更新 | 依 OS 供應商公告修補，不可用 npm audit 代替 |

### 3.3 程式與瀏覽器之間的資料邊界

- daemon 與 CLI 以 loopback HTTP/SSE 通訊。
- CLI／daemon 透過 loopback CDP WebSocket 控制瀏覽器。
- TaskSpace ledger 與瀏覽器 Profile 存放在使用者資料目錄，不在 repository。
- `tools/profile-init.js` 可能複製既有瀏覽器的書籤、favicon、登入資料與網站儲存資料；這些資料不得進入測試輸出、文件或 CI artifact。
- Profile 格式可能隨 Chrome/Chromium major 改變，是瀏覽器升級時比 JavaScript API 更重要的相容性邊界。

## 4. 執行入口與程序拓撲

### 4.1 npm bins

`package.json` 宣告四個命令：

| 命令 | 檔案 | 角色 |
|---|---|---|
| `tp-browser` | `bin/tp-browser.js` | 主要 CLI |
| `tp-browserd` | `daemon/tp-browserd.js` | daemon 命令入口 |
| `ego-browser` | `bin/ego-browser.js` | 相容 CLI alias |
| `ego-browserd` | `daemon/ego-browserd.js` | daemon 命令入口／相容入口 |

兩個 CLI 檔案目前各自硬編碼顯示版本 `0.3.1`，但 package manifest 為 `0.3.0`。這是正式升級前應消除的 release metadata 漂移。

### 4.2 POSIX／macOS 執行路徑

1. `install.sh` 複製 runtime 至使用者資料目錄。
2. `scripts/tp-start.sh` 啟動 daemon，再啟動 Chromium-family browser。
3. daemon 連接本機 CDP port；CLI 透過本機 HTTP/SSE 呼叫 daemon。
4. `scripts/tp-stop.sh` 透過本機 endpoint 與 process pattern 停止程序。

風險重點：

- `tp-start.sh` 與 `tp-stop.sh` 使用 `pkill -f` 比對程式或 Profile path，匹配範圍可能比單一 release 所需更寬。
- systemd service 與互動式 launcher 的 Node.js 啟動參數不一致。
- macOS 沒有專用 launchd unit，且目前沒有同等完整的历史實機證據。

### 4.3 Windows 執行路徑

1. `install.ps1` 複製 runtime、建立 wrappers、調整使用者 PATH，並建立啟動項目。
2. `scripts/ego-start.ps1` 透過 CIM/WMI 啟動 daemon 與 Chrome/Edge/Brave。
3. 有頭模式在互動式 session 使用 `Start-Process`；session 0 情況使用 Task Scheduler `/IT`。
4. `scripts/ego-stop.ps1` 以 process name 與 command line 條件停止程序。

風險重點：

- PowerShell 版本、Windows build、CIM 權限與 Task Scheduler 行為都會影響安裝／啟動。
- 目前主要記錄為 Windows 11，尚不能視為所有 Windows 版本均已驗證。
- `install.ps1` 會先移除既有資料目錄中的部分 runtime，失敗時可能留下半套版本。

### 4.4 WSL2 執行路徑

- 有頭模式可委派給 Windows PowerShell 與 Windows browser。
- 無頭模式走 POSIX daemon／browser。
- Windows 與 WSL2 可使用不同 port pair，並行存在。
- 升級時必須驗證兩套 runtime 不會誤停、誤用彼此的 Profile 或 process pattern。

### 4.5 本機連接埠

| 類型 | 預設 | 替代 |
|---|---:|---:|
| daemon HTTP | `127.0.0.1:9772` | `127.0.0.1:9774` |
| browser CDP | `127.0.0.1:9773` | `127.0.0.1:9775` |

測試應只使用 loopback，不得把 daemon 或 CDP 綁定到外部介面。

## 5. repository 已記錄的歷史環境矩陣

下表只摘錄 `STATE.md` 中的版本資訊，不含主機名稱、帳號、路徑或使用者資料，也不能視為本次已重新驗證。

| OS／執行模式 | 已記錄 Node.js | 已記錄瀏覽器 | 證據限制 |
|---|---|---|---|
| Windows 11 | 24.19.x、24.20.x | Chrome 155 | 歷史驗收記錄；未涵蓋所有 Windows build |
| Ubuntu 24.04 | 24.18.x、24.21.x | Chrome／Chromium 150–155 區間 | 歷史記錄 |
| Debian 13 | 20.19.2、26.7.0 | Chromium 151–154 區間 | Node.js 20 已不符合 manifest；Node.js 26 需 canary |
| WSL2 Ubuntu 24.04 | 24.21.x | Chrome 155 | 需額外驗證與 Windows 並行情境 |
| macOS | 未見等價矩陣 | 未見等價矩陣 | 不能由 README 的平台宣稱推定正式支援 |

## 6. 已確認的盤點落差

| 編號 | 落差 | 影響 |
|---|---|---|
| D-01 | `package.json` 要求 Node.js 22+，README 與歷史環境仍提及 Node.js 20 | 使用者可能安裝在不受支援 runtime；systemd 與 wrapper 行為不一致 |
| D-02 | Node.js 22+ 不需要 `--experimental-websocket`，但兩個 installer wrapper 仍使用 | 未來 Node.js major 若移除 flag，可能造成全面啟動失敗 |
| D-03 | manifest 為 `0.3.0`，兩個 CLI 顯示 `0.3.1` | 無法可靠判定已部署版本，妨礙升級與回滾 |
| D-04 | README 宣稱 Edge、Brave、macOS 等支援，但沒有完整矩陣證據 | 支援邊界模糊 |
| D-05 | 沒有 package scripts、lockfile 與可見 CI workflow | 測試入口與自動化驗證不可重現 |
| D-06 | 遠端 installer 抓取預設分支 | 相同安裝指令在不同時間可能取得不同程式碼 |
| D-07 | installer 先移除舊 runtime，再複製新 runtime | 失敗時缺少可靠的前一版 runtime |
| D-08 | Windows 與 POSIX 的 runtime、Profile、process lifecycle 不完全對稱 | 跨平台回滾與故障排除容易採不同假設 |
