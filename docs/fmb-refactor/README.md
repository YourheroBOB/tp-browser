# tp-browser 漸進式重構計畫（fmb-refactor）

> **文件狀態**：評估與計畫（docs-only）。本輪**只新增 Markdown 文件**，未修改任何既有程式碼、腳本、設定或 workflow。
> **盤點基準**：本次任務提供的預設分支內容快照。快照**未提供** `bin/tp-browser.js`、`bin/ego-browser.js`、`daemon/ego-browserd.js`、`daemon/tp-browserd.js`、`daemon/page-ops.js`、`daemon/inpage.agent.js`、`lib/sdk.js`、`tests/*.mjs` 的完整內容；涉及這些檔案的結論一律標記 **[PENDING]**，待取得完整內容後補齊，不做臆測。
> **安全邊界**：本文不含任何 token、金鑰、密碼、客戶資料、案件內容或瀏覽器登入資料；範例一律使用 `FAKE_VALUE_FOR_TEST` 這類明顯假值（本文其實不需要任何憑證範例）。

## 一頁結論

1. **可安全先行的是三個小而具體的重複**：`daemon/store.js` 的 `bindPage`／`addPage` 逐字相同、`tools/profile-init.js` 的 SQLite sidecar 清理迴圈重複三次、`scripts/tp-start.sh` 的 headed／headless 兩份 Chrome flag 清單只差兩個旗標。這些可以在行為完全不變的前提下去重。
2. **最大的結構性債是「tp / ego 雙軌」與「常數散落」**：埠位組合（9772/9773、9774/9775）、資料目錄（`~/.local/share/ego-linux`）、瀏覽器偵測清單、停止程序的 pattern，散落在 shell / PowerShell / JS 三種語言的多個檔案裡，且 `tp-start.sh` 實際啟動的是 **`ego-browserd.js`** 而非 `tp-browserd.js`。
3. **停止邏輯以 `pkill -f` 字串比對檔名**，與「檔案叫什麼名字」強耦合：任何改名（例如未來把 ego-* 合併進 tp-*）都會讓停止腳本靜默失效，這是雙軌合併前必須先解的耦合。
4. **有三個檔案明顯過長且職責混合**：`tools/profile-init.js`（頂層線性 ~200 行、六種資料同步混在一起）、`scripts/ego-start.ps1`（單一主流程八個編號段落）、`scripts/tp-start.sh`（WSL2 委派＋健康檢查＋停止＋偵測＋spawn＋等待全在一檔）。
5. **重構順序採「先補安全網、先做純內部去重、再碰腳本層、最後才碰雙軌合併」**：每批都有明確的驗證指令與回滾方式，可獨立驗收、獨立回退。
6. **版本號漂移**（`package.json` 0.3.0 vs CLI `version` 0.3.1）與 **log 前綴硬編碼 `[ego-browserd]`** 屬於命名一致性問題，放在低風險批次處理。
7. **對外可觀測字串（`TP_READY` / `EGO_READY` / `TP_INDICATORS`）與安裝路徑是隱性 API**，外部腳本（如部署記錄中的 `toopower_run.py`）可能依賴它們；本計畫**不改變任何既有輸出字串**，統一與否列為 BOB 決策點。

## 文件地圖

| 文件 | 內容 |
|---|---|
| [`01-findings.md`](./01-findings.md) | 问题盤點：重複程式、過長檔案、耦合過緊、命名不一致，逐項附程式碼證據與風險評級 |
| [`02-batches.md`](./02-batches.md) | 分批執行計畫（Batch 0–7）：每批的目標、需先補的測試、步驟、驗證方式、風險與回滾 |
| [`03-before-after.md`](./03-before-after.md) | 關鍵片段的重構前後對照（含行為保持的驗證方法） |

## 批次總覽

| 批次 | 對象 | 性質 | 風險 | 獨立驗證方式 |
|---|---|---|---|---|
| **Batch 0** | 測試安全網（characterization tests） | 只新增測試 | 極低 | `node --test` 全綠；不改任何產品碼 |
| **Batch 1** | `daemon/store.js` 內部去重 | 純內部、行為不變 | 低 | Batch 0 測試不變綠 |
| **Batch 2** | `tools/profile-init.js` 拆分為函式 | 結構重整＋新增 `--dry-run` | 低–中 | 以 `tmp_path` 假 profile 結構的新測試 |
| **Batch 3** | 停止／共用 shell 邏輯抽取（`scripts/lib/`） | 跨腳本去重 | 中 | `shellcheck` ＋ 以測試埠（非 9772/9773）的假 daemon 驗證 |
| **Batch 4** | `tp-start.sh` / `ego-start.ps1` 拆段、Chrome flags 單源 | 腳本分層 | 中 | 輸出字串逐字比對（新舊腳本同環境 diff）＋本地冒煙 |
| **Batch 5** | 版本號與常數單源（`daemon/config.js`） | 命名一致性 | 低 | `node --check` 全量＋單元測試＋ docs 同步 |
| **Batch 6** | tp／ego entrypoint 合併 | **[PENDING]** 需先取得並 diff 兩對檔案 | 高 | 23/23 smoke（`tests/smoke.ego.js`，僅本機、僅 127.0.0.1） |
| **Batch 7** | daemon 大檔拆分（page-ops／sdk／browserd） | **[PENDING]** 需完整原始碼 | 高 | 另立批次計畫 |

## 全域原則

1. **零 npm 相依不變**：所有重構只使用 Node.js 內建與 POSIX sh／PowerShell；不得為了重構引入套件。
2. **行為保持（behavior-preserving）優先**：Batch 1–5 的每一批都不改變任何對外可觀測行為（stdout 字串、檔案路徑、埠位、退出碼）；需要改行為的（例如統一 `TP_READY`/`EGO_READY`）一律抽成決策點，不由重構順手改掉。
3. **先補測試再動程式**：任何批次的第一步都是把「現狀行為」用測試釘住（characterization test），重構後測試不動且全綠。
4. **每批一個 PR、可獨立回滾**：批次之間沒有硬依賴（除了明確標注的前置），任一批失敗可直接 revert 該批。
5. **不碰 `.github/workflows`、secrets、remote、分支**；不連線正式服務；測試只用 `mkdtempSync(tmpdir())`／`tmp_path` 與 `127.0.0.1` 高位測試埠。
6. **敏感資料不進測試 fixture**：profile-init 的測試用自建假檔案（假 JSON、假 SQLite 佔位檔），絕不讀取或複製真實使用者瀏覽器 profile。
