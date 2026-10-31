# tp-browser 路線圖（ROADMAP）

> **文件狀態**：依價值排序的下一步 10 項提案。本文僅規劃，未修改任何程式碼。  
> **排序原則**：(1) 修補「文件宣稱但程式不存在」的信譽缺口；(2) 低成本高回報的既有資產收尾；(3) 供應鏈與品質地基；(4) 中長期能力擴充。  
> **工作量估計**：以熟悉本 codebase（約 2,000 行純 ESM、零相依）的單一工程師為基準，單位人日（pd）。風險分低／中／高。

## 總覽表

| # | 項目 | 價值 | 工作量 | 風險 | 主要風險來源 |
|---|---|---|---|---|---|
| 1 | 補齊 Cookie 匯出／匯入工具（README 已宣稱但 `tools/` 缺檔） | 極高 | 3–5 pd | 中 | 觸碰敏感資料的匯出格式與加密 |
| 2 | 將 `fmb_feature2/reaper.js` 整合進 daemon | 高 | 1–2 pd | 低 | 自動刪除誤傷（已有兩道安全閥） |
| 3 | 統一版本號並改為固定 tag 安裝 | 高 | 0.5–1 pd | 低 | 發佈流程變更需協調 |
| 4 | 上線 Phase 0 CI（lint + `node --test` + gitleaks + npm audit） | 高 | 1 pd | 低 | repo 設定權限（需 BOB 操作） |
| 5 | `Store.load()` 形狀驗證與預設值 merge | 中高 | 0.5 pd | 低 | 需同步改寫既有「現況測試」 |
| 6 | `Store` 新增 `lastUsedAt` 並供 reaper 使用 | 中高 | 1 pd | 低 | schema 變更需向後相容 |
| 7 | 結構化日誌＋紅機制（observability Phase 1） | 中高 | 2–3 pd | 中 | 日誌量大與敏感欄位洩漏防護 |
| 8 | `smoke.ego.js` 去除 `/tmp` 硬編路徑＋跨平台化 | 中 | 0.5 pd | 低 | 改動驗收基準腳本本身 |
| 9 | 瀏覽器支援矩陣正式化（Edge／Brave／macOS 驗收） | 中 | 3–5 pd（多為驗證） | 中 | 瀏覽器版本差異與 anti-bot 行為 |
| 10 | `/metrics` 端點＋基礎儀表板（observability Phase 2） | 中 | 2–4 pd | 中 | 零相依下自製 Prometheus text format 的維護成本 |

## 各項細節

### 1. 補齊 Cookie 匯出／匯入工具（優先序最高）

- **現況**：README「跨機 Cookie 登入態自由遷移」段落引用 `tools/cookies-export.ego.js` 與 `tools/cookies-import.ego.js`，但這兩個檔案不在 repo 中（`tools/` 只有 `profile-init.js`）。這是對使用者的**信譽缺口**。
- **內容**：以 `tp-browser nodejs` 批次腳本形式實作；匯出走 CDP `Storage.getCookies`／`Network.getAllCookies`，寫入 `~/.local/share/ego-linux/cookies.json`（README 已宣稱 `0600` 權限）；匯入走對應的 set 系列。跨機情境依 README 宣稱提供加密（可用 Node 內建 `crypto`，如 AES-256-GCM + 使用者提供的通行語）。
- **風險與緩解**：這是全專案最敏感的操作（HttpOnly session cookies）。必須：預設輸出檔 `0600`、加密為跨機預設、文件一律用假值示例、測試只用 fake cookie 與 `tmpdir()`。
- **驗收**：新增 `tests/` 下的測試（fake cookies、`tmp_path`），並在 README 保留既有指令介面不變。

### 2. 整合 ledger 回收器進 daemon

- **現況**：`fmb_feature2/` 已提供完整、經測試（`node --test fmb_feature2/`）的 `planReap`／`applyReapPlan`，整合位置與程式碼片段都寫在其 README §3.2，只差在 `daemon/` 加一個低頻計時器。
- **內容**：照其建議以保守 policy 起步（`idleSpaceMs: 6h`、`maxSpaces: 500`），先只觀察 `stats` 一週再放寬；維持「live 集合為空 → 完全不動作」安全閥。
- **風險**：低——決定與執行分離的設計已內建乾跑能力；最大風險是與未來 `lastUsedAt`（項目 6）的語意銜接。

### 3. 統一版本號＋固定 tag 安裝

- **現況**：`package.json` `0.3.0` vs CLI `version` `0.3.1`；`install.sh`／`install.ps1` 會 `git clone` **浮動的預設分支**，且安裝流程會先 `rm -rf` 既有 runtime，無可靠回滾。
- **內容**：統一為單一版本號來源；安裝器改抓固定 `vX.Y.Z` tag 並驗證 checksum；runtime 改版本化目錄＋原子切換。細節見 `docs/fmb-ci/05-build-and-release.md` 與 `docs/fmb-upgrade/`。
- **風險**：低，但發佈節奏需 BOB 決策（見末節）。

### 4. Phase 0 CI 上線

- **現況**：`.github/workflows` 未列入 repo 檔案清單（即目前無 CI）；`docs/fmb-ci/` 已給出可直接採用的 workflow 範本。
- **內容**：L1 `node --check` 全量＋L2 `node --test tests/ fmb_feature2/`＋L3 gitleaks＋L4 `npm audit`（零相依 ⇒ trivial pass）。**不新增任何 devDependency**。
- **風險**：低。唯一障礙是建立 workflow 需 repo 寫入權限與分支保護設定，屬 BOB 親自操作範圍。E2E 冒煙（需真實 Chrome）先維持 advisory。

### 5. `Store.load()` 形狀驗證與 merge

- **現況**：`tests/test_fmb_store.test.mjs` 已文件化——載入 `{}` 會讓 `list()`／`create()` 拋 TypeError。
- **內容**：`load()` 改為與預設值 `{ nextSpaceId:1, labelSeq:{}, spaces:{} }` merge 並驗證欄位型別；**同步改寫**該「現況測試」為期望行為。向後相容：既有合法 ledger 不受影響。
- **風險**：低；是項目 2、6 的地基。

### 6. `Store` 新增 `lastUsedAt`

- **現況**：reaper 只能用 `createdAt` 判閒置（保守但會誤收「建立很久但仍在用」的空間）。
- **內容**：在 `setPage`／`bindPage`／`addPage` 等寫入點更新 `lastUsedAt`；reaper 的閒置基準改為 `lastUsedAt ?? createdAt`。schema 屬**加欄位**，舊 ledger 載入後為 `undefined`，回退 `createdAt`，向後相容。
- **風險**：低；需擴充 `fmb_feature2/reaper.test.js`。

### 7. 結構化日誌＋紅機制（Phase 1）

- **現況**：僅無時間戳、無層級的 `console.*`，重定向到 `logs/daemon.log`／`chrome.log`；無任何敏感欄位防護。
- **內容**：依 `docs/fmb-observability/events-and-fields.md` 與 `sensitive-fields.md` 實作——允許清單欄位、JSON lines、本地優先（不外傳）、零相依。
- **風險**：中——主要是「不小心把頁面 URL／title（可能含案件線索）寫進日誌」的隱私風險，因此紅機制必須與日誌同批上線，不可先上日誌後補防護。

### 8. 冒煙腳本跨平台化

- **現況**：`tests/smoke.ego.js` 硬編 `/tmp/ego-linux-smoke.png` 與 `/tmp/ego-linux-smoke-dl.txt`，且依賴 POSIX `/tmp` 與 `ps ax`（`tp-start.sh` 亦然）。
- **內容**：改為 env 或參數傳入輸出目錄（預設 `os.tmpdir()`），讓 Windows 原生環境可跑同一套冒煙；STAT E.md 宣稱的「三平台」因此才有單一可重現的驗收腳本。
- **風險**：低——但它是驗收基準，改動後需在至少一台 Windows＋一台 Linux 各跑一次 23/23。

### 9. 瀏覽器支援矩陣正式化

- **現況**：STATE.md 有 Chrome 150–155 的實機證據；Edge／Brave 僅有探測程式碼，macOS 有路徑但缺可重現驗收報告。
- **內容**：為 Chrome／Chromium（正式）與 Edge／Brave／macOS（best effort）各建一張「版本 × 任務」驗收表，全部用 `tests/serve.mjs` 本機頁 + 假資料，不碰正式服務。
- **風險**：中——Chromium 系分支的 anti-bot／Client Hints 行為差異可能需要 `page-ops.js` 的 UA 偽裝邏輯各別調整。

### 10. `/metrics` 端點＋基礎儀表板（Phase 2）

- **現況**：`/health` 只回一個布林；無任何指標。
- **內容**：依 `docs/fmb-observability/metrics-and-slo.md` 與 `dashboards.md`，在 daemon 加 `/metrics`（Prometheus text format，純字串輸出，零相依），先揭露空間數、分頁數、RPC 延遲／錯誤率等**非內容型**指標。
- **風險**：中——`/metrics` 也在 loopback 上且需 token；需注意指標不得含 URL／title（依 `sensitive-fields.md`）。

## 明確排除（本輪不做）

- 不新增任何 npm runtime/dev dependency（違反零相依賣點；若未來必須，另案審查）。
- 不動 `.github/workflows`、git remote、secrets（任務規則；且 workflow 建立屬 BOB 權限）。
- 不連線正式服務做驗證；所有測試設計以 `tests/serve.mjs`＋`tmpdir()` 為限。

## 需要 BOB 決策的事

1. 項目 1 的跨機加密：預設加密（通行語制）還是明文 JSON＋警告？（本文建議：**預設加密**）。
2. 項目 3 的發佈節奏：何時凍結 0.3.x → 打第一個 `vX.Y.Z` tag？
3. 項目 4 的 required checks／分支保護：需 BOB 親自設定。
4. 項目 2 的回收 policy 上線值（本文建議 6h/500 先觀察一週）。
5. 項目 9 的 macOS 是否列入正式支援承諾（涉及 README 宣稱）。
