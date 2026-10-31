# 01 — 问题盤點（重複、過長、耦合、命名）

> 證據基準：本輪快照有提供完整內容的檔案。未提供內容的檔案標 **[PENDING]**。
> 風險評級：🔴 高（影響正確性或外部相容）／🟡 中（維護成本與隱性耦合）／🟢 低（純內部整潔）。

## A. 重複程式

### A1. `Store.bindPage` 與 `Store.addPage` 逐字相同 🟢
`daemon/store.js` 中兩個方法的函式體**完全一樣**（同樣的 guard、同樣的 `{ targetId, openedBy, title: '', url: '' }`、同樣的 `persist()`）。兩者並存代表未來任何一方改動都會造成 silently diverge。
**影響**：維護成本；無立即 bug。
**處理**：Batch 1，共用一個私有 `_upsertPage`，兩個公開名稱都保留（外部呼叫端零改動）。

### A2. 停止邏輯在四處重複 🟡
同一組「flush → sleep → pkill 三行 → 清 Singleton」序列出現在：

- `scripts/tp-stop.sh`（本體）
- `scripts/tp-start.sh`（restart 路徑內嵌同樣的 `pkill -f "ego-browserd.js"`、`pkill -f "tp-browserd.js"`、`pkill -f "$PROFILE_DIR"` 與 Singleton 清理）
- `scripts/ego-stop.ps1` 與 `scripts/ego-start.ps1` 第 4 段（WMI process filter 重複）

且 `pkill -f` 的比對 pattern **耦合到檔名**（詳 C4）。
**處理**：Batch 3 抽 `scripts/lib/tp-common.sh`（POSIX）與 PowerShell 端共用函式。

### A3. Chrome 啟動旗標兩份近似清單 🟡
`scripts/tp-start.sh` 的 headed／headless 兩個分支各有一份 ~14 個旗標的清單，差异僅：headless 多 `--headless=new`、`--disable-extensions`、起啟 URL（`about:blank` vs `/newtab`）。`scripts/ego-start.ps1` 又維護第三份（以 `$CommonFlags` 字串組出，但 headed/headless 差異散在 `$GuiMarker`／`$StartUrl`）。
**風險**：三份清單將隨瀏覽器版本演進各自漂移（歷史上 anti-detection 旗標已多次調整）。
**處理**：Batch 4 單源化（shell 端一個 `CHROME_COMMON_FLAGS` 變數）。

### A4. 瀏覽器偵測清單三處各自維護 🟡
Chrome/Edge/Brave/Chromium 的候選路徑清單在 `scripts/tp-start.sh`（macOS+Linux）、`scripts/ego-start.ps1`（Windows）、`tools/profile-init.js`（三平台資料目錄）各寫一份。新增瀏覽器（例如未來的 Arc / Dia）要改三處。
**處理**：Batch 4／Batch 5；保守做法是先不追求跨語言單源（shell/PowerShell/JS 共享設定檔會增加複雜度），至少把「同一檔內」的重複先消掉，並在清單旁加互相指向的註解。

### A5. SQLite sidecar 清理迴圈重複三次 🟢
`tools/profile-init.js` 中 `for (const ext of ['-journal', '-wal', '-shm']) { ... unlinkSync(dst + ext) ... }` 出現三次（Favicons、Login Data/Web Data、Cookies）。
**處理**：Batch 2 抽 `copySqliteFile(src, dst)`。

### A6. 埠位組合散落多檔 🟡
`9772/9773`（預設）與 `9774/9775`（alt）成對出現在：`tp-start.sh`、`tp-stop.sh`、`ego-start.ps1`、`ego-stop.ps1`（間接）、systemd unit（9773）、README、docs。任何一處改動都會造成 daemon／Chrome／CLI 三方對不上。
**處理**：Batch 3／Batch 5；shell 端先在 `tp-common.sh` 定義一次，JS 端集中到 `daemon/config.js`。

### A7. 安裝器兩份各自維護 🟡（跨平台本質，目標降為「清單單源」）
`install.sh` 與 `install.ps1` 的複製清單（bin/daemon/lib/scripts/tools/tests/skills/docs）各自手寫。**已發現的實際不一致**：
- `install.sh` 只 `cp "$SRC/tests/"*.mjs`，**不會**複製 `tests/smoke.ego.js`、`tests/bench/*.js`、`tests/serve.mjs`（serve 是 .mjs 會被複製）——已安裝環境無法重跑 23/23 冒煙。
- `cp "$SRC/docs/"*` 不帶 `-R`，**子目錄不會被複製**；`docs/fmb-observability/README.md` 聲稱「本目錄會隨安裝器整包進位」，與腳本實際行為不符（文件與腳本不一致，應擇一修正——列為決策點，不在重構批次順手改）。
**處理**：Batch 5 把複製清單抽成單一資料驅動結構（例如共用一個 `install-manifest` 文字檔，兩個安裝器讀取）；是否補 `-R` 屬行為變更，需 BOB 決策。

### A8. tp／ego 雙軌 entrypoint **[PENDING]** 🔴
`package.json` 的 `bin` 同時註冊 `tp-browser`/`ego-browser`、`tp-browserd`/`ego-browserd`，即 `bin/` 與 `daemon/` 各有兩對入口檔。**安裝層已證明別名可行**（`install.sh` 用同一個 `tp-cli.sh` symlink 出 `ego-browser`），因此「兩份完整 .js」很可能是純重複——但本輪快照未提供這四個檔內容，無法斷言差異僅在字串。**先決工作**：`diff bin/tp-browser.js bin/ego-browser.js` 與 `diff daemon/tp-browserd.js daemon/ego-browserd.js`，把 diff 結果記進 Batch 6 再動手。

## B. 過長檔案／函式

### B1. `tools/profile-init.js` 🟡
頂層線性腳本（無函式分層），單檔混合至少六個職責：
1. 寫 `Preferences`（書籤列、session restore、profile 名稱）
2. 掃描候選瀏覽器 profile（三平台）
3. 評分選最佳候選（`score = n*1000 + favSz + lsSz`）
4. 同步 Bookmarks／Favicons／Login Data／Web Data／Cookies+`Local State.os_crypt`／Local Storage／IndexedDB

每一段都有獨立的 try/catch 吞錯（多處 `catch {}` 靜默失敗），出問題時無法判斷哪一步失敗。
**處理**：Batch 2 拆成具名函式＋`--dry-run`＋逐步 log；行為（哪些檔被複製、條件判斷）完全不變。

### B2. `scripts/ego-start.ps1` 🟡
單一主流程，內建八個編號段落（埠位判斷／瀏覽器偵測／健康檢查／停止／Node 偵測＋profile init／daemon 啟動／Chrome 啟動含 Session 0 schtasks 逃生口／等待驗證）。任何一段的修改都在同一個命名空間裡互相污染變數（`$UseAlt`、`$BrowserBin`、`$CommonFlags`…）。
**處理**：Batch 4 拆成 `Get-TpPortPair`、`Find-TpBrowser`、`Stop-TpProcesses`、`Start-TpDaemon`、`Start-TpBrowser`、`Wait-TpHealth` 等函式。

### B3. `scripts/tp-start.sh` 🟡
一檔混合：參數解析、WSL2 → Windows 委派、健康檢查快返回、停止舊實例、瀏覽器偵測、`spawn_detached`（內嵌 `node -e`＋動態 `import()` 的 spawn helper）、headed/headless 分支、健康等待迴圈。`spawn_detached` 內嵌的 Node 程式碼用字串傳參（`process.argv[1]`／`argv[2]`），難以測試。
**處理**：Batch 3／Batch 4；`spawn_detached` 抽成獨立小工具 `scripts/lib/spawn-detached.js`（接受 `--log FILE -- cmd...`），shell 端單行呼叫。

### B4. daemon 核心檔 **[PENDING]** 🟡
`daemon/ego-browserd.js`、`daemon/page-ops.js`、`lib/sdk.js` 未提供內容；README 自述全部核心約 2,000 行。`docs/fmb-security/CHECKLIST.md` 的「未驗證」清單顯示這些檔包含 HTTP 路由、`safePath`、RPC 分派等多個職責。**不做臆測**，Batch 7 待完整內容後另立計畫；可先立的方向（依 README／CHECKLIST 的既有描述）：`safePath` 抽獨立模組＋單元測試、HTTP Host/Origin 驗證抽成單一守衛函式。

## C. 耦合過緊

### C1. `Store` 的資料邏輯與檔案 I/O 耦合 🟡
`daemon/store.js` 每個 mutator（`create`／`nextLabel`／`setPage`／`bindPage`／`addPage`／`removePage`／`deleteSpace`）都直接呼叫 `persist()`（整份 JSON 原子寫回）。後果：
- 呼叫端無法批次操作（開 N 個分頁 = N 次全量寫檔）；
- `fmb_feature2/reaper.js` 的 `applyReapPlan` 逐筆套用時，每刪一個空間就全量寫檔一次；
- 無法在測試中用記憶體 store 驗證資料邏輯（除非給 tmp 檔，現有測試正是被迫這樣做）。
**處理**：Batch 1 先只抽 `_atomicWrite`（I/O 細節單源）；「dirty flag + flush」屬行為變更（效能與崩潰視窗改變），列為決策點，不在 Batch 1 順手做。

### C2. 資料目錄路徑硬編碼於所有層 🟡
`~/.local/share/ego-linux` 字串散落於 `tp-start.sh`、`tp-stop.sh`、`ego-start.ps1`、`ego-stop.ps1`、`tools/profile-init.js`（`EGO_LINUX_DATA_DIR` 環境變數僅 profile-init 支援）、`install.sh`／`install.ps1`、systemd unit。改名（見 D2）將是一次高風險全庫手術。
**處理**：Batch 5 先「單源不改名」——JS 端集中到 `daemon/config.js`，shell 端集中在 `tp-common.sh`；是否更名見 D2 決策點。

### C3. `tp-start.sh` 啟動的是 `ego-browserd.js` 🟡
`tp-start.sh` 的 `DAEMON_JS` 偏好 `$APP_DIR/daemon/ego-browserd.js`；systemd unit 的 `ExecStart` 也指向 `ego-browserd.js`；但 `package.json` 的主名是 `tp-browserd`，`tp-stop.sh` 兩個都 pkill。這顯示「tp 產品線實際運行 ego 命名的 daemon」，是 A8 雙軌合併的直接證據，也是合併時**最容易漏改**的接縫。
**處理**：Batch 6 合併前，先在 Batch 3 的 common 檔把 daemon 檔名定義成單一變數。

### C4. 停止腳本以檔名字串比對製程 🟡
`pkill -f "ego-browserd.js"`、`pkill -f "tp-browserd.js"`、`pkill -f "$PROFILE_DIR"` 與 PowerShell 端 `CommandLine -like "*ego-browserd.js*"`。這與 C3 疊加：**改名 = 停止腳本靜默失效**（程序殺不掉、`SingletonLock` 殘留、下次啟動失敗）。更穩的做法是比對 profile 路徑＋記錄 PID 檔（daemon 啟動時寫 `daemon.pid`，停止優先讀 PID）——屬行為增強，列決策點。

### C5. `profile-init.js` 直接讀取使用者真實瀏覽器資料 🔴（重構範圍內的部分）
同步 `Login Data`、`Cookies`＋`Local State.os_crypt`、Local Storage、IndexedDB 意味著該工具與使用者日常瀏覽器 profile 強耦合，且**無 dry-run、無逐項同意、無操作日誌**（多處 `catch {}` 靜默）。重構不改變「是否同步」的產品決策（那需要 BOB 拍板），但 Batch 2 會讓每一步變成可觀測（dry-run 印計畫、實跑印清單），把「做了什麼」從隱性變顯性。**測試絕不使用真實 profile**。

### C6. 腳本輸出字串是隱性外部 API 🟡
`TP_READY (...)`、`EGO_READY (...)`、`TP_INDICATORS: ...`、`TP_STOPPED`、`EGO_STOPPED (terminated N processes)`。STATE.md 顯示有 `toopower_run.py` 等外部工具在這套系統上運作；這些字串極可能被 parse。**本計畫所有批次均不改變這些字串的格式與前綴**；統一與否（D4）是 BOB 決策。

### C7. daemon 模組硬編碼 log 前綴 🟢
`daemon/store.js`：`console.error('[ego-browserd] store load failed...')`；`daemon/cdp.js`：`console.error('[ego-browserd] handler error:', e)`。在名為 `tp-browserd` 的產品裡統一輸出 `[ego-browserd]`，且無法注入（測試想斷言 log 或導向別處都做不到）。與 `docs/fmb-observability/` 的結構化日誌計畫直接相關。
**處理**：Batch 1 保守版——前綴改為模組常數（維持現值，不改輸出）；「可注入 logger」與觀測性整合留給 observability 計畫。

## D. 命名不一致

| # | 項目 | 現況 | 評級 |
|---|---|---|---|
| D1 | tp-* vs ego-* 雙命名 | bin／daemon／scripts／headers／docs 全面雙軌（`x-tp-token`/`x-ego-token`、`ego-start`/`tp-start`…） | 🟡（刻意相容設計，但實作層重複，見 A8） |
| D2 | 資料目錄叫 `ego-linux` | Windows／macOS 也用這個目錄名；環境變數叫 `EGO_LINUX_DATA_DIR` | 🟡（歷史包袱；改名是 breaking change） |
| D3 | 版本號漂移 | `package.json` = 0.3.0；CLI `version` 指令輸出 0.3.1（`docs/fmb-api/README.md` 已記載） | 🟡 |
| D4 | 就緒輸出前綴 | `tp-start.sh` 印 `TP_READY`；`ego-start.ps1` 印 `EGO_READY`；停止分別印 `TP_STOPPED`／`EGO_STOPPED` | 🟡（C6：外部可能依賴） |
| D5 | 環境變數前綴混用 | `TP_BROWSER_BIN`（tp 前綴）vs `EGO_LINUX_DATA_DIR`（ego 前綴） | 🟢 |
| D6 | `Store.nextLabel` 語意 | `create()` 設 `labelSeq=1` 並建立 `p1`；`nextLabel()` **先遞增再回傳**，首次呼叫回傳 `p2`——行為自洽但命名與實作順序反直覺，易被「修正」成 bug | 🟢（加註解與 characterization test 固定） |
| D7 | systemd unit 名稱 | `ego-linux-chrome.service`／`ego-linux-browserd.service` 內執行 ego 路徑，README 卻教 `cp scripts/*.service` 後談 tp 指令 | 🟢 |
| D8 | log 前綴 | 見 C7 | 🟢 |

## 未納入本輪結論的檔案（[PENDING] 清單）

`bin/tp-browser.js`、`bin/ego-browser.js`、`daemon/ego-browserd.js`、`daemon/tp-browserd.js`、`daemon/page-ops.js`、`daemon/inpage.agent.js`、`lib/sdk.js`、`tests/*.test.mjs`、`tests/smoke.ego.js`、`tests/bench/*`、`skills/tp-browser/SKILL.md`、`docs/fmb-security/AUDIT.md`、其餘 `docs/fmb-*` 子文件、`docs/index.html`。取得內容後應先做：`diff` 兩對 entrypoint（A8）、`node --check` 全量、閱讀既有測試以避免重複補測。
