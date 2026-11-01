# tp-browser 效能與可靠性審查（fmb-perf）

> **文件狀態**：docs-only。本目錄只新增 Markdown，未修改任何既有檔案、程式碼、安裝腳本、workflow、git remote 或 secrets。  
> **基準**：本次提供的預設分支內容快照；未連線任何正式服務、registry、瀏覽器或遠端 daemon。  
> **安全邊界**：不含任何實際 token、金鑰、密碼、客戶個資、LINE 訊息內文或案件當事人資料；需要示例值只使用 `FAKE_VALUE_FOR_TEST`。

## 文件地圖

| 文件 | 內容 |
|---|---|
| `performance-reliability-audit.md` | 主報告：效能瓶頸、資源洩漏、併發／競態、逾時與重試、錯誤恢復、日誌可觀測性；每項含位置、影響、建議修法、驗證方式、優先級 |

## 優先級定義

| 等級 | 意義 |
|---|---|
| **P0** | 立即處理：可能資料遺失、敏感資料外流或服務不可恢復 |
| **P1** | 下一輪：明確效能損失、穩定性風險或運維成本 |
| **P2** | 短期：可觀測性、安裝／服務生命週期、錯誤恢復補強 |
| **P3** | 觀察或文件補強 |

## 審查範圍

已審查：`daemon/store.js`、`daemon/cdp.js`、`daemon/keys.js`、`scripts/tp-start.sh`、`scripts/tp-stop.sh`、`scripts/ego-stop.ps1`、`scripts/ego-linux-*.service`、`install.sh`、`install.ps1`、`package.json`、`fmb_feature2/*`、相關 docs。

未實質審查（快照未提供完整內容）：`daemon/ego-browserd.js`、`daemon/tp-browserd.js`、`daemon/page-ops.js`、`daemon/inpage.agent.js`、`lib/sdk.js`、`tools/profile-init.js`、`bin/*`、`scripts/ego-start.ps1`、`tests/*` 完整內容。

## 驗證原則

1. 不連線正式服務。
2. 只用 `127.0.0.1` 本機測試伺服器或 repo 內 `tests/serve.mjs`。
3. 暫存檔只用 `mkdtempSync(tmpdir())`／`tempfile` 類型隔離目錄。
4. 需要認證示例只用 `FAKE_VALUE_FOR_TEST`。
5. 日誌與指標驗證必須包含脱敏測試，不得記錄 URL 全文、title、頁面內容、Cookie、token 或案件資料。
