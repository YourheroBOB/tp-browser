# tp-browser 語言版本、相依套件與執行環境升級計畫

> **文件狀態**：評估與提案。本文僅記錄升級計畫，尚未修改程式、相依套件或執行環境。  
> **盤點基準**：本次任務提供的預設分支內容快照；未連線即時 repository、套件 registries、瀏覽器服務或任何正式服務。  
> **安全邊界**：本文不含實際憑證、Token、金鑰、密碼、客戶資料、案件資料或瀏覽器登入內容。

## 一頁結論

1. **npm 直接與傳遞相依套件皆為 0**：`package.json` 沒有 `dependencies`、`devDependencies`、`optionalDependencies` 或 `peerDependencies`，因此目前沒有一般 npm 套件可執行版本升級。
2. **主要升級對象不是 npm 套件，而是原生執行環境**：Node.js、Chromium/Chrome/Edge/Brave、PowerShell、systemd、shell 工具與 OS 套件。
3. **Node.js 支援契約不一致**：`package.json` 宣告 `node >=22`，README 仍描述 Node.js 20 加實驗旗標的相容路徑，而部分部署記錄仍含 Node.js 20。
4. **Node.js 22 應作最低正式基線**：建議以 Node.js 22 為最低支援、Node.js 24 為優先驗證目標、較新的 Node.js major 先進入 canary；不應在沒有遷移通知的情況下繼續把 Node.js 20 列為正式支援環境。
5. **瀏覽器與 OS 支援矩陣尚未制度化**：目前已有 Chrome/Chromium 150–155 的歷史記錄，但 Edge、Brave、macOS 與各 OS 最新 major 缺乏完整、可重現的驗收證據。
6. **安裝與回滾機制是主要供應鏈風險**：遠端安裝器目前可抓取預設分支，且安裝流程會先移除既有 runtime；兩者都不足以提供可重現升級與可靠回滾。
7. **建議分階段執行**：先統一支援契約與測試基準，再處理可重現安裝、瀏覽器相容性、Node.js 新 major，最後才考慮提高最低 Node.js 版本。

## 文件地圖

| 文件 | 內容 |
|---|---|
| [`01-inventory.md`](./01-inventory.md) | 語言、版本宣告、套件與原生相依、執行平台、歷史環境矩陣及盤點落差 |
| [`02-risk-register.md`](./02-risk-register.md) | 過時項目、供應鏈風險、相容性風險、風險分級與緩解方式 |
| [`03-phased-upgrade-plan.md`](./03-phased-upgrade-plan.md) | 分階段升級計畫；每階段均列出變更、相容性風險、驗證、進場與回滾條件 |
| [`04-validation-and-rollback-runbook.md`](./04-validation-and-rollback-runbook.md) | 測試矩陣、隔離測試方式、升級驗收與回滾演練程序 |

## 本次範圍

### 包含

- 盤點 JavaScript、Node.js、shell、PowerShell、systemd 與瀏覽器執行環境。
- 盤點 npm 與非 npm 相依套件。
- 評估過時支援宣告、安裝來源、版本漂移、瀏覽器/Profile 遷移與原生 CDP 實作的風險。
- 規劃分階段變更、驗證門檻及回滾方式。
- 提供不依賴正式服務的測試與演練方法。

### 不包含

- 不實際升級 Node.js、npm、瀏覽器、OS 套件或任何 dependency。
- 不修改 `package.json`、既有程式、安裝器、systemd 設定或 `.github/workflows`。
- 不新增 npm runtime dependency。
- 不連線或測試任何正式服務。
- 不讀寫 repo 以外的真實使用者資料；需要暫存資料時只能使用 `tmp_path`／`tempfile` 建立的隔離目錄。
- 不提交或輸出真實認證值；測試若需要認證值，只能使用 `FAKE_VALUE_FOR_TEST` 這類明顯假值。

## 建議升級原則

1. **維持零 npm runtime dependency**：這是目前最大的供應鏈優勢，不應為了方便而任意加入套件。
2. **正式支援與最佳努力分開**：Chrome/Chromium 優先完成正式驗證；Edge、Brave 與 macOS 在證據齊全前標示為 best effort。
3. **每個階段都要有可回復點**：程式、安裝 artifact、瀏覽器版本與 Profile 資料分開回滾，避免只還原程式卻留下不相容的資料格式。
4. **不做隱式自動升級**：安裝器應安裝明確版本；新版本先 staging，再由維運流程切換。
5. **不以「測試通過」取代安全評估**：Node.js、OS 與瀏覽器漏洞需另依各自供應商公告持續修補。
6. **優先使用本機 loopback 測試**：所有功能性與故障測試使用本機測試伺服器、假資料與暫存目錄。

## 本次採用的保守決策

| 項目 | 本次保守預設 | 狀態 |
|---|---|---|
| 最低 Node.js | `>=22` | 建議，需 BOB 覆核 |
| 優先 Node.js 升級目標 | Node.js 24 | 建議，需 BOB 覆核 |
| 較新 Node.js major | Node.js 26 先 canary，不作最低基線 | 建議 |
| Node.js 20 | 視為舊世代相容路徑，不再列為正式支援 | 建議，需公告與遷移期 |
| 瀏覽器優先順序 | Chrome/Chromium 先行；Edge/Brave 另建正式驗證矩陣 | 建議 |
| macOS | 保留功能宣稱前，先完成隔離驗收 | 建議 |
| 安裝來源 | 固定 release tag 與不可變 commit，並驗證 checksum | 建議 |
| runtime 部署 | 版本化目錄、原子切換、保留前一版 | 建議 |
| npm dependency | 維持 0；若未來新增，必須另案審查與鎖版 | 建議 |

完整決策與待 BOB 覆核事項見 [`03-phased-upgrade-plan.md`](./03-phased-upgrade-plan.md) 末節。
