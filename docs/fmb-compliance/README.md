# tp-browser 授權與資料合規盤點（fmb-compliance）

> **性質**：合規盤點文件（docs-only）。本目錄**只新增 Markdown 文件**，未修改任何既有程式、設定或 workflow。
> **盤點基準**：本次任務提供的預設分支內容快照；未連線任何正式服務、registry 或瀏覽器。
> **安全邊界**：本文不含任何實際 token、金鑰、密碼、客戶資料、LINE 訊息內文、案件當事人資料；示例一律使用明顯假值（如 `FAKE_VALUE_FOR_TEST`）。既有 repo 文件中出現的作業中繼資料（主機名稱、連線網址等）一律以「類別描述」方式引用，不逐字複製。

## 一頁結論

1. **相依套件授權面積極小，且皆為「叫用、非散布」**：`package.json` 無任何 `dependencies`／`devDependencies`，實際外部軟體（Node.js、Chrome/Edge/Brave/Chromium、git、PowerShell、systemd）皆由終端使用者自備，本專案不散布其二進位檔，因此**目前沒有相互授權（copyleft）相容性衝突**；主要風險是 Apache-2.0 第 4(d) 條 NOTICE 義務的落實，以及 `ego-browser` 相容別名的商標議題。
2. **個資處理密度高於一般工具**：本工具的核心功能就是複製與長期保存瀏覽器登入態（含 HttpOnly Session Cookie、已存密碼資料庫、自動填表資料）、記錄瀏覽軌跡（分頁標題／URL），並讓 Agent 擷取頁面內容——這些在台灣個資法下均屬個人資料（或含個人資料之資料）。
3. **最大單點風險：`tools/profile-init.js` 未經明示同意即複製使用者主瀏覽器的「Login Data／Web Data／Cookies／os_crypt」**，等同把個人日常瀏覽器的完整登入態與表單資料引入 Agent 可完全存取的環境，目的外利用風險極高。
4. **第二大風險：使用模式會把擷取到的頁面內容（可能含案件或第三人個資）送交外部 LLM 服務**，構成目的外利用與跨境傳輸；工具本身不傳，但預設工作流會傳。
5. **保存與刪除機制嚴重不足**：ledger 只增不減（`fmb_feature2/reaper.js` 尚未整合）、日誌無輪替無上限、沒有任何「一鍵清除全部本機資料」指令、沒有銷毀紀錄。
6. **日誌外洩欄位明確可列舉**：完整 URL（含查詢字串中的 token／搜尋詞）、分頁標題（可能含案件主題）、含使用者名稱的本機路徑、`JSON.stringify` 的完整錯誤內容、PowerShell 啟動器直接列印的分頁標題清單。
7. 個資法適用上，**消費者自用可能落入 §51 個人／家庭活動免責**，但**律師執業用途（案件研究、當事人資料處理）不應主張免責**，應依非公務機關標準建置安全維護措施。

## 文件地圖

| 文件 | 內容 |
|---|---|
| [`01-license-inventory.md`](./01-license-inventory.md) | 相依套件／執行環境授權盤點、Apache-2.0 義務、商標與供應鏈風險 |
| [`02-personal-data-map.md`](./02-personal-data-map.md) | 個人資料類別、儲存位置、產生與流向（含對外傳輸點） |
| [`03-retention-and-deletion.md`](./03-retention-and-deletion.md) | 保存機制現況、刪除機制現況、缺口與建議 |
| [`04-log-leak-fields.md`](./04-log-leak-fields.md) | 記錄檔／stdout 中可能外洩的欄位清單與去識別化建議 |
| [`05-pdpa-gap-analysis.md`](./05-pdpa-gap-analysis.md) | 對照台灣個人資料保護法一般要求的缺口矩陣與補強建議 |

## 盤點方法與限制

- 方法：靜態閱讀本輪提供的檔案內容（`package.json`、`LICENSE`、`NOTICE`、`README.md`、`install.sh`／`install.ps1`、`scripts/*`、`tools/profile-init.js`、`daemon/store.js`、`daemon/cdp.js`、`daemon/keys.js`、`fmb_feature2/*`、既有 `docs/fmb-*` 文件等）。
- 限制：`daemon/ego-browserd.js`、`daemon/tp-browserd.js`、`daemon/page-ops.js`、`daemon/inpage.agent.js`、`lib/sdk.js` 的完整內容未在本輪快照中提供，凡涉及這些檔案的結論均標註「**未驗證**」，不做成確定陳述。
- 本輪未執行任何測試、未連線任何服務、未讀寫 repo 以外路徑。

## 與既有文件的關係

- 日誌去識別化的技術規格沿用 [`docs/fmb-observability/sensitive-fields.md`](../fmb-observability/sensitive-fields.md) 的「允許清單」設計。
- 安裝來源未固定版本的供應鏈風險沿用 [`docs/fmb-upgrade/`](../fmb-upgrade/README.md) 的結論。
- 程式碼安全面的未驗證項目沿用 [`docs/fmb-security/CHECKLIST.md`](../fmb-security/CHECKLIST.md)。
