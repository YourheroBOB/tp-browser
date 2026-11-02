# 04 — 記錄檔與輸出中可能外洩的欄位

> 技術性的「禁止欄位清單＋紅機制規格」請見 [`docs/fmb-observability/sensitive-fields.md`](../fmb-observability/sensitive-fields.md)；本文從合規盤點角度，列舉**現有實作中確實會出現**的欄位與其外洩後果。

## 1. `logs/daemon.log`（daemon 的 `console.*` 重定向）

| 欄位 | 來源（已見於本輪快照） | 外洩後果 |
|---|---|---|
| 完整 URL（含查詢字串） | ledger 與導航流程會記 `url`（`store.js` schema）；錯誤訊息常含 URL | 查詢字串可能含 `token`、`session`、`code` 等參數與搜尋詞（搜尋詞＝網路活動個資）；亦可能含可識別案件的網址 |
| 分頁標題 `title` | `store.js` 每個 page 記 `title`；title 常為對話主題／文件名 | 可能直接揭露案件名稱、當事人姓名或對話內容摘要 |
| 完整錯誤物件 `JSON.stringify(data)` | `daemon/cdp.js` `CdpError`：`super(`${method}: ${data?.message ?? JSON.stringify(data)}`)` | CDP error params 可能含頁面網址、request URL、表單內容等未經過濾的原始資料 |
| 本機絕對路徑 | 各類錯誤訊息 | 路徑含 OS 使用者名稱；亦揭示機器組織結構 |
| store 載入失敗時印整個例外 | `store.js` `console.error('[ego-browserd] store load failed...', e.message)` | 訊息本身可能含檔案路徑與解析中斷處內容 |
| handler 例外 | `cdp.js` 直接 `console.error(..., e)`（整個 Error 物件） | Error 可能攜帶底層 CDP 原始 payload |

## 2. `logs/chrome.log`

- Chromium 的 stderr 會印導航錯誤、渲染錯誤，通常**含完整 URL**；在登入流程（2FA／Cloudflare 頁）中，這些 URL 常含一次性參數。
- headless 模式下的 crash dump 指標與 profile 路徑（含使用者名稱）。

## 3. 啟動／停止腳本的 stdout（會進 shell 歷史與 CI log）

| 位置 | 欄位 |
|---|---|
| `scripts/ego-start.ps1` 成功訊息 | `Active Tabs: $($tabs -join ' ; ')` —— **直接列印所有分頁標題**；若使用者剛登入案件相關頁面，標題即外洩 |
| `tp-start.sh`／`ego-start.ps1` | profile 絕對路徑（含使用者名稱）、瀏覽器名稱、port、pid、session id（中繼資料，低敏感） |
| `install.sh`／`install.ps1` | 安裝路徑、使用者名稱、PATH 修改 |

## 4. agent 工作流輸出（`tp-browser nodejs` 的 stdout）

- `page.snapshot()`／`evaluate` 的結果由 Agent 腳本自由 `console.log`；**此為設計功能，無法在工具層強制**，但文件層面應揭示：這些輸出會進入 LLM 供應商的請求內容與交談紀錄（見 `02-personal-data-map.md` 第 3 節）。

## 5. repo 內文件（若轉公開或擴大授權）

- `STATE.md` 與 `docs/TP_WIN_AB_ACCEPTANCE_REPORT_1151018.md` 記錄內部主機名稱、Node／Chrome 版本、以及工作階段連結（本文件不複製其內容）。這些屬組織作業中繼資料，個資敏感度低，但：
  1. 連結若為可分享的工作階段網址，取得連結者可能讀取該對話內容——建議公開前逐項審視；
  2. 主機清單＝內部資產盤點，轉公開前應最小化。
- benchmark JSON（`docs/tp_win_ab_benchmark_results_1151018.json`）未在本輪快照提供內容，標**未驗證**，建議同上審視。

## 6. 建議的去識別化規則（最小可行，供實作另案）

1. **URL 記錄一律截斷查詢字串**：只記 scheme＋host＋path；必要時對 host 做允許清單。
2. **title 只記長度或前 N 字元的雜湊**，不記原文。
3. `CdpError` 不要 `JSON.stringify(data)` 整包輸出；只記 `data.message` 的長度或固定碼。
4. `ego-start.ps1` 移除 `Active Tabs` 列印（或只印分頁**數量**）。
5. 路徑輸出統一做 `~`／`%USERPROFILE%` 替換。
6. 日誌加上輪替與上限（見 `03-retention-and-deletion.md` 缺口 #2）。

以上 1–5 屬既有檔案修改，本輪**不實作**，僅列為後續 PR 清單。
