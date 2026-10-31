# 現況盤點：日誌、指標、錯誤回報

> 依據 repo 內既有程式碼靜態閱讀整理；「已檢視」不代表通過動態驗證。

## A. 日誌（現有）

| # | 來源 | 內容與形式 | 去向 | 問題 |
|---|---|---|---|---|
| A1 | `daemon/store.js` | `console.error('[ego-browserd] store load failed, starting fresh:', e.message)` | stderr → `logs/daemon.log` | 無時間戳／層級／instance；只涵蓋 load 失敗，persist 失敗完全靜默 |
| A2 | `daemon/cdp.js` | `console.error('[ego-browserd] handler error:', e)`（CDP event handler 例外） | stderr → `logs/daemon.log` | handler 收到的事件 params **可能夾帶頁面內容**，需在完整程式碼確認（列為待辦） |
| A3 | `tools/profile-init.js` | `console.log('Synced N bookmarks from: <絕對路徑>')` 等 | stdout | **已存在資訊洩漏**：會印出其他瀏覽器 profile 的絕對路徑（使用者脈絡資訊） |
| A4 | `scripts/tp-start.sh` | `spawn_detached` 以 append 模式開 `logs/daemon.log`、`logs/chrome.log`；echo `TP_READY` / `TP_NOT_READY` / `TP_INDICATORS` | 終端 + log 檔 | 無輪替（append-only），長駐只增不減 |
| A5 | `scripts/tp-stop.sh` / `scripts/ego-stop.ps1` | echo `TP_STOPPED` / `EGO_STOPPED (terminated N processes)` | 終端 | 只有計數，無結構 |
| A6 | `install.ps1` / `install.sh` | `Write-Output` / `echo` 安裝進度 | 終端 | 安裝流程無持久記錄 |
| A7 | `fmb_feature2/README.md`（建議、未整合） | `console.error('[reaper] ' + JSON.stringify(stats))` | 尚未存在 | 格式良好（JSON stats），可作為結構化日誌的起點範例 |

## B. 指標（現有）

- **無**。沒有 `/metrics`、沒有計數器、沒有延遲統計。
- 唯一的「度量」是 `/health` 的 `{"ok":true,"chrome":true}`（當下布林值，無歷史、無速率）。
- `tests/bench/*` 提供一次性 A/B benchmark 基礎設施，屬驗收用途，非持續遙測。

## C. 錯誤回報（現有）

- **無**。沒有 Sentry／OTLP／檔案型 error store；錯誤只散见於 console 與 log 檔。
- CLI 層（`bin/tp-browser.js`）錯誤只印 stderr + exit code（參考 `fmb_feature2/cli.js` 的模式：usage → exit 2）。
- CDP 錯誤包成 `CdpError`（`method` + `message`）後 reject；**是否被記錄取決於各呼叫端**，沒有統一政策。

## D. 健康檢查（現有）

- `GET /health`（daemon `127.0.0.1:9772`／alt `9774`）→ `{"ok":true,"chrome":true}`。
- `scripts/tp-start.sh` 輪詢 `/health`（grep `"chrome":true`，最多 10 秒）決定 `TP_READY` / `TP_NOT_READY`。
- 未檢查的依賴項：store 可寫性、token 存在性、ledger 大小、Chrome 端 `/json/list` 可達性。

## E. 缺口清單（Gaps）

| # | 缺口 | 影響 |
|---|---|---|
| G1 | 日誌非結構化：無 `ts`／`level`／`component`／`version`／`instance`／`trace_id` | 無法機器查詢、無法跨程序關聯、多实例時無法歸因 |
| G2 | 無日誌輪替 | 背景常駐一週／一月後 log 無限成長，且 `persist` 成本已被 reaper 文件指出同型問題 |
| G3 | 無紅機制（redaction） | A3 已洩漏絕對路徑；頁面內容、URL query、Cookie、Token 均有實質洩漏風險（本工具使用者為法律專業人士，頁面常含案件資料） |
| G4 | 無指標 | 無法回答「過去 24h batch 失敗率」「CDP p95」「ledger 成長速度」「reaper 是否有動」 |
| G5 | 無關聯 ID | CLI → daemon → CDP → page 一次操作無法串成單一請求鏈 |
| G6 | 無 SLO／告警／儀表板 | 被動運維：只能事後翻 log |
| G7 | 多实例歧義 | `9772`/`9774` 雙軌並存；`STATE.md` 另見 `18802`/`18800` 歷史埠號；日誌缺少 port/version 欄位時無法分辨是哪一個 instance |
| G8 | 版本雙軌（`tp-*` 與 `ego-*` 別名） | 行為差異難以歸因，遙測需要 `version` + `binary` 欄位 |

## F. 資料流：現況 vs 目標

```text
現況：
  app ──console.*──► stdout/stderr ──append──► logs/daemon.log, logs/chrome.log ──►（沒有任何下游）

目標（Phase 1–3，本文件設計，尚未實作）：
  app ─► JSONL logger（allowlist + denylist + regex 紅機制 + 長度截斷）
       ├──► logs/*.jsonl（輪替）
       └──► counters/histograms/gauges ─► GET /metrics（loopback + token）
                 ├──► Prometheus / Grafana（選用）
                 └──► alerts.jsonl（P1/P2/P3，本地優先）
```

## G. 待確認（需完整程式碼或隔離環境）

- [ ] `daemon/ego-browserd.js`、`daemon/tp-browserd.js` 的 HTTP 層實際打了哪些日誌、錯誤回應內容是否夾帶輸入。
- [ ] `daemon/cdp.js` 的 `handler error` 路徑：event params 是否可能含頁面內容（A2）。
- [ ] `lib/sdk.js` 是否把頁面 `console` 輸出轉發到 daemon 日誌（若會，屬高風險洩漏路徑）。
- [ ] `daemon/page-ops.js` 截圖／下載的錯誤訊息是否含絕對路徑。
