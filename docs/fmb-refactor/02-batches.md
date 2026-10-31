# 02 — 分批執行計畫

> 每批 = 一個可獨立合併、獨立驗證、獨立 revert 的變更單位。
> 通用驗證基線（每批結束都要跑）：
> ```bash
> # 語法（零依賴）
> for f in $(git ls-files '*.js' '*.mjs'); do node --check "$f"; done
> shellcheck scripts/*.sh
> # 單元測試（零網路、零正式服務、暫存只用 tmpdir）
> node --test tests/ fmb_feature2/
> ```
> 需要真實 Chrome 的驗證（僅 Batch 4、6）只在本機執行：`node tests/serve.mjs &` ＋ `tp-browser nodejs < tests/smoke.ego.js`（23/23），連線對象一律是 `127.0.0.1`。

---

## Batch 0 — 測試安全網（characterization tests）

**性質**：只新增測試檔，不改任何產品碼。**風險：極低。**

**目標**：把即將被重構的模組的「現狀行為」釘死，使後續批次能用「測試不動且全綠」證明行為未變。

需先補的測試（全部 `node --test`、只用 `mkdtempSync(tmpdir())`、零網路）：

| 對象 | 要釘住的現狀行為 |
|---|---|
| `daemon/store.js` | ① `bindPage` 與 `addPage` 對相同輸入產生**位元組等價**的 ledger JSON；② `nextLabel` 首次回傳 `p2`、之後 `p3`…（D6 語意）；③ `create()` 產生 `p1: { targetId: null }`；④ `deleteSpace`/`removePage` 後 `persist()` 檔案內容與 `list()` 一致；⑤ 檔案毀損時 `load()` 走 fresh start 並印 log（不 throw）；⑥ rename 失敗 fallback 路徑（以唯讀目錄模擬） |
| `daemon/keys.js` | `keyDescriptor`／`parseChord` 的表格測試（Enter/Space/單字元/F1–F12、`ControlOrMeta+a`、非法 chord throw） |
| `daemon/cdp.js` | 純邏輯部分：`CdpError` 訊息格式；以注入 fake `this.ws`（`{ readyState: 1, send(json) }`）測 `send()` 的 pending/timeout 清理；直接餵字串給 `_recv()` 測 id/sessionId 分派與 handler 例外隔離 |
| `fmb_feature2/` | 已有測試，作為回歸基線直接沿用 |

**注意**：`tests/test_fmb_store.test.mjs` 等既有測試**內容未提供**（[PENDING]）；動手前先閱讀，缺的補、重複的不寫。

**驗證**：`node --test tests/ fmb_feature2/` 全綠；`git diff --stat` 顯示只新增測試檔。

**回滾**：刪測試檔。

---

## Batch 1 — `daemon/store.js` 內部去重（行為不變）

**風險：低。** 前置：Batch 0。

1. `bindPage`／`addPage` 收斂到私有 `_upsertPage`（見 `03-before-after.md` §1）。兩個公開方法名稱與簽名**不變**。
2. `persist()` 的原子寫細節抽成 `_atomicWrite(body)`（tmp→rename、失敗 fallback direct write），`persist()` 只負責序列化與呼叫。
3. log 前綴改為模組常數 `const LOG_TAG = '[ego-browserd]'`——**維持現值**，輸出零變化（C7／D8 的統一留給 observability 計畫）。
4. `nextLabel` 加一段註解說明「先遞增再回傳、首次為 p2」的歷史語意（D6），不改邏輯。

**驗證**：Batch 0 的 store 測試**一字不改**且全綠；`node --check daemon/store.js`。

**風險與緩解**：唯一風險是誤以為兩方法「應該」有差異而順手改語意——禁止；任何語意差異需求走新 issue。

**回滾**：revert 單檔。

---

## Batch 2 — `tools/profile-init.js` 拆分＋`--dry-run`

**風險：低–中。** 前置：先補測試（本批第一步）。

**需先補的測試**：以 `tmp_path` 自建假目錄結構（假 `Bookmarks` JSON、假 `Preferences`、以小 binary 佔位檔假充 SQLite 檔、假 `Local State` JSON），把 `EGO_LINUX_DATA_DIR` 指到 tmp，驗證：候選評分選擇、各同步步驟的觸發條件（「目的較小於來源 0.5 倍才複製」等）、sidecar 清理、IndexedDB 只補缺的 `https_*` origin。**絕不讀真實使用者 profile；所有輸入檔都是測試自建的假資料。**

**步驟**：
1. 頂層線性腳本拆成具名函式：`writeDefaultPreferences()`、`collectCandidates()`、`scoreCandidate()`、`syncBookmarks()`、`syncFavicons()`、`syncLoginAndWebData()`、`syncCookiesAndLocalState()`、`syncLocalStorage()`、`syncIndexedDB()`；共用 helper `copySqliteFile(src, dst)`（見 `03-before-after.md` §2）、既有 `fileSize`/`dirSize`/`countBookmarks` 保留。
2. 每個函式結束回傳 `{ synced: [...], skipped: [...] }`，主流程彙總輸出——**取代靜默 `catch {}`**：吞錯仍吞（行為保持），但至少留下「哪一步、哪個檔」的單行 log。
3. 新增 `--dry-run`：只印計畫不複製、不寫檔（含 Preferences 也不寫）。實跑（無 `--dry-run`）行為與現狀**完全一致**。

**驗證**：新測試全綠；手動在本機以 `EGO_LINUX_DATA_DIR=$(mktemp -d) node tools/profile-init.js --dry-run` 觀察輸出（讀真實瀏覽器目錄是該工具既有行為，dry-run 只讀不寫，屬可接受；**測試碼內則嚴格只用假結構**）。

**風險**：Preferences JSON 的鍵路徑（`bookmark_bar.show_on_all_tabs` 等）在重排時打錯——靠測試＋輸出 diff（新舊版本對同一 tmp 輸入產生的檔案樹 diff 為空）。

**回滾**：revert 單檔。

---

## Batch 3 — 停止／共用 shell 邏輯抽取

**風險：中。** 前置：無（可與 Batch 1 平行）。

**步驟**：
1. 新增 `scripts/lib/tp-common.sh`，集中定義（不改任何值）：
   - 埠位組：`TP_DAEMON_PORT_DEFAULT=9772` 等（A6）；
   - daemon 檔名單源（C3）：`TP_DAEMON_JS_NAMES="ego-browserd.js tp-browserd.js"`；
   - `tp_stop_services()`（flush → sleep → pkill → Singleton 清理，A2）；
   - `tp_wait_health(port, tries)`（health 輪詢迴圈）。
2. `tp-stop.sh` 與 `tp-start.sh` 改為 source 後呼叫。
3. `spawn_detached` 內嵌的 `node -e` 抽成 `scripts/lib/spawn-detached.js`（`node spawn-detached.js --log FILE -- cmd args...`），shell 端單行呼叫（B3）。

**需先補的測試**：`tp_wait_health` 與 `tp_stop_services` 的可測部分——以 Node 起一個本機假 health server（`127.0.0.1` + **高位測試埠**如 39772，參數化傳入，絕不碰 9772/9773 正式埠）以 `node --test` + `spawnSync('sh', ...)` 驗證等待與逾時行為；`shellcheck scripts/*.sh scripts/lib/*.sh`。

**驗證**：輸出字串逐字不變（`TP_STOPPED`、`TP_READY (...)`）；本機實際 `tp-start` / `tp-stop` 一輪（僅本機、僅 loopback）。

**風險**：`set -eu` 與函式內 `|| true` 的互動、macOS `/bin/sh` 與 Linux 差異（`pkill`、`ps` 行為）——靠 shellcheck＋雙平台手測；`scripts/lib/` 目錄需同步進 `install.sh`／`install.ps1` 複製清單（A7），**否則安裝環境會缺檔**（此為本批唯一必要的一行既有檔修改，屬本計畫範圍，於實作批次的 PR 中一併做並明列於 PR 說明）。

**回滾**：revert 腳本三檔＋移除 lib 目錄。

---

## Batch 4 — 啟動腳本拆段＋Chrome flags 單源

**風險：中。** 前置：Batch 3。

**步驟**：
1. `tp-start.sh`：Chrome 旗標單源為 `CHROME_COMMON_FLAGS`，headed/headless 差異顯式化（見 `03-before-after.md` §3）；主流程分段註解對映到 common 函式。
2. `ego-start.ps1`：拆成函式（`Get-TpPortPair`／`Find-TpBrowser`／`Stop-TpProcesses`／`Start-TpDaemon`／`Start-TpBrowser`／`Wait-TpHealth`），`$CommonFlags` 組裝集中在單一處；**Session 0 schtasks 逃生口邏輯獨立函式化並加註解**（該段是目前最難懂、最易回歸的部分）。
3. 輸出字串（`EGO_READY`、`TP_INDICATORS`）**一字不改**（C6／D4）。

**驗證**：
- 「組裝結果」等價驗證：在新舊腳本各加臨時 `printf '%s\n' "$CHROME_COMMON_FLAGS ..."` 輸出（驗證後移除），同一環境下 diff 為空；
- 本機 `tp-start`（headless）→ `tp-headed` → `tp-stop` 全輪；`tp-browser doctor`；
- 23/23 smoke（本機、`tests/serve.mjs`、127.0.0.1）。

**風險**：PowerShell quoting（`"`\"`"` 嵌套）與 `Start-Process -ArgumentList` 的參數邊界——逐段保持原字串、只移動不重寫；`schtasks /IT` 段原樣搬移不改內容。

**回滾**：revert 兩腳本。

---

## Batch 5 — 版本號與常數單源（`daemon/config.js`）

**風險：低。** 前置：無。

**步驟**：
1. 新增 `daemon/config.js`：匯出 `DEFAULTS = { daemonPort: 9772, chromePort: 9773, altDaemonPort: 9774, altChromePort: 9775, dataDirName: 'ego-linux' }` 與 `dataDir()`（尊重既有 `EGO_LINUX_DATA_DIR`，**不新增、不改任何環境變數語意**）。daemon／tools 端改讀此模組。
2. CLI `version` 指令改為讀 `package.json` 的 `version`，消除 0.3.0/0.3.1 漂移（D3）。**[PENDING]**：`bin/*.js` 內容未提供，實作時先確認現有字串來源。
3. 安裝器複製清單單源化（A7）：抽 `install-manifest`（檔案清單），兩個安裝器讀取。`install.sh` 的 `cp tests/*.mjs` 缺 smoke 與 `docs/*` 缺 `-R` 的**行為是否一併修正，列 BOB 決策點，本批不順手改**。
4. 同步更新 `docs/fmb-api/`（版本描述）與 `docs/fmb-observability/inventory.md`（如有受影響）。

**驗證**：`node --check` 全量；`tp-browser version` 輸出與 `package.json` 一致；單元測試 `config.js`（預設值、環境變數覆蓋、路徑組裝）。

**回滾**：revert（config.js 為新增檔，移除即可）。

---

## Batch 6 — tp／ego entrypoint 合併 **[PENDING]**

**風險：高。** 前置：Batch 3（daemon 檔名單源）、Batch 5（常數單源），且**必須先完成前置調查**：

> 前置調查（不改碼）：`diff bin/tp-browser.js bin/ego-browser.js`、`diff daemon/tp-browserd.js daemon/ego-browserd.js`，把差異分類為「純字串／常數差異」vs「行為差異」。若存在行為差異，本批降級為「先合併字串層、行為差異另案」，不得硬合。

**步驟（僅在 diff 顯示純字串差異時）**：
1. 以 `tp-*` 檔為單一實作；`ego-*.js` 改為薄 wrapper（讀自身檔名決定顯示名稱，其餘 re-export／委派）。`package.json` 的 `bin` 對應**路徑不變**。
2. 停止腳本、systemd unit、`tp-start.sh` 的 `DAEMON_JS` 邏輯（C3）透過 Batch 3 的單源變數一次修正。
3. `install.sh`／`install.ps1` 不需改（複製的是整個目錄）。

**驗證**：23/23 smoke **分別以 `tp-browser` 與 `ego-browser` 兩個入口各跑一次**（本機、127.0.0.1）；`tp-start`/`tp-stop`/`tp-headed` 全輪；`tp-browser doctor`。

**風險**：外部 Skill（`skills/tp-browser/SKILL.md`）與使用者腳本對 `ego-*` 路徑的依賴——wrapper 保持檔案存在與行為等價，即不改變任何外部契約；最大隱患是兩份檔其實有未記錄的行為分歧，故前置 diff 是硬門檻。

**回滾**：revert 四個入口檔（wrapper 回復為完整實作）。

---

## Batch 7 — daemon 核心拆分 **[PENDING：需完整原始碼，另立計畫]**

依 `docs/fmb-security/CHECKLIST.md` 的未驗證清單與 README 描述，可預見的方向（**待完整內容確認後才成案**）：
- `safePath` 抽成 `daemon/safe-path.js` 獨立模組，補路徑穿越／symlink／TOCTOU 的單元測試（全部以 `tmp_path` 建構的假樹）；
- HTTP `Host`/`Origin` 驗證抽成單一守衛函式，補跨站請求拒絕的測試（本機假 server、127.0.0.1）；
- `page-ops.js` 依操作族（導航／截圖／下載／上傳／鍵盤）分檔；
- `lib/sdk.js` 的 RPC 分派表化。

---

## 全域風險登記冊

| 風險 | 影響批次 | 緩解 |
|---|---|---|
| 外部工具 parse 腳本輸出字串 | 3–6 | 輸出字串列為凍結契約；任何更動獨立成案＋BOB 核可 |
| `pkill -f` pattern 與改名耦合 | 6 | Batch 3 先單源；PID 檔方案列決策點 |
| 安裝環境缺 `scripts/lib/` | 3 | 安裝器複製清單同步修改並在 PR 明列 |
| Windows quoting／Session 0 特殊路徑回歸 | 4 | 只搬移不重寫；逐字比對組裝結果；雙模式手測 |
| 兩對 entrypoint 有隱性行為分歧 | 6 | 前置 diff 為硬門檻，分歧未分類前不合併 |
| profile-init 觸碰真實使用者資料 | 2 | 測試只用假結構；dry-run 只讀不寫；吞錯改為留 log |
| Node 20（`--experimental-websocket`）相容 | 1–5 | 重構不動 WebSocket 使用方式；升級基線議題歸 `docs/fmb-upgrade/` |
