# 06 · 日誌與可觀測性

這個專案的使用者常是「Agent 自己」，卡住時沒有人會去看 `console.error`。**可觀測性的目標很具體：讓 `tp-browser status` 能回答「現在卡在哪個 method、卡多久、最近誰在逾時」。**

---

## O-01 沒有結構化日誌（無時間戳、無等級、無事件名） · **P1**

- **位置**：全專案。`daemon/store.js`、`daemon/cdp.js`、`bin/*.js`、`tools/profile-init.js` 皆為散落的 `console.error('[ego-browserd] ...')` / `console.log(...)`；`scripts/tp-start.sh` 把 daemon 的 stdio 直接 append 到 `$LOGS_DIR/daemon.log`。
- **影響**：`daemon.log` 內無法對齊「哪一次 Agent turn 的哪個步驟出了什麼事」；沒有時間戳時，跨 daemon/Chrome 兩個 log 的因果關係只能猜。事故排查（「昨天那批任務為什麼變慢」）幾乎不可能。
- **建議修法**：新增零依賴 `lib/log.js`：
  ```js
  // 單行、可 grep、可 JSON 解析
  // 2026-01-01T00:00:00.000Z WARN  evt=rpc.timeout method=Page.navigate ms=45000
  export function log(level, evt, fields = {}) { /* 時間戳 + lvl + evt + k=v */ }
  ```
  - 等級由 `TP_LOG_LEVEL`（`debug|info|warn|error`，預設 `info`）控制。
  - **欄位白名單制**：只允許 `method`、`spaceId`、`label`、`ms`、`code`、`count`、`urlHost`（僅 host，不含 path/query）等；**禁止**記錄 params、表單值、cookie、token、頁面內容。預設不記錄任何 URL 的 path/query。
  - `daemon` 與 `bin` 共用，`doctor --verbose` 可切到 `debug`。
- **驗證方式**：單元測試斷言輸出符合 `^\S+ (DEBUG|INFO|WARN|ERROR) evt=\S+`；另以「試圖記錄 `password` 欄位」的測試斷言被白名單擋掉。

---

## O-02 沒有每個 RPC 的耗時與失敗統計 · **P1**

- **位置**：`bin/*.js` 的 `doctor()`／`status` 只讀 `/health` 的 `{ ok, chrome }`；daemon 端統計（**未取得 `ego-browserd.js`**）。
- **影響**：無法回答「今天哪個 method 最慢／最常失敗」。這是效能審查最起碼的資料，缺了就只能靠使用者體感。
- **建議修法**：daemon 內以 `Map<method, { count, errors, p50, p95, max }>` 累計，僅保留最近 200 筆樣本（環形緩衝，零依賴即可算 p50/p95），並擴充 `/health` 回傳：
  ```json
  { "ok": true, "chrome": true,
    "stats": { "rpc": { "Page.navigate": { "count": 42, "errors": 1, "p95": 8120 } } } }
  ```
  `tp-browser doctor` 印出 top 5 慢 method 與錯誤率。
- **驗證方式**：對本機頁面跑 50 次 `goto`，斷言 `stats.rpc['Page.navigate'].count === 50`；注入 5 次逾時，斷言 `errors === 5`。

---

## O-03 沒有 `inflight`：Agent 卡住時外部看不到在做什麼 · **P1**

- **位置**：`/health` 回應（實作待確認）與 `bin/*.js` 的 `status`。
- **影響**：單 turn 批次腳本可能跑數十秒到數分鐘。這段期間使用者/上層 Agent 只能看到 `{"ok":true,"chrome":true}`，完全不知道是「在導航」「在等元素」還是「卡在死鎖」。這是本專案最常被抱怨的體驗之一（無法判斷該等還是該殺）。
- **建議修法**：daemon 維護 `inflight: Map<rpcId, { method, spaceId, label, startedAt }>`，`/health` 回傳前 10（不含參數）：
  ```json
  { "inflight": [ { "method": "Page.navigate", "label": "p1", "ms": 18420 } ] }
  ```
  `tp-browser status` 直接印成人類可讀的一行。另可加 `lastCompleted`（method + 耗時）供事後追查。
- **驗證方式**：以本機延遲路由（5 秒回應）啟動一個 `goto`，在等待期間呼叫 `tp-browser status`，斷言輸出含 `Page.navigate` 且 `ms > 1000`。

---

## O-04 高頻事件錯誤洗版與 `_recv` 靜默丟棄 · **P2**

- **位置**：`daemon/cdp.js` · `_recv()`：`try { msg = JSON.parse(...) } catch { return; }`（靜默丟棄）；handler 例外 `console.error`（無去重）。
- **影響**：解析失敗沒有任何痕跡（若上游送來非 JSON 會完全靜默）；handler 例外在高頻事件下洗版，把真正重要的訊息淹沒。
- **建議修法**：解析失敗計數並在 `debug` 等級記長度（不記內容），連續失敗超過門檻記 warn 一次；handler 例外以 `(method, message)` 60 秒去重 + 抑制計數（見 C-07）。
- **驗證方式**：見 C-07 的驗證；另餵入 100 筆非 JSON 訊息，斷言只產生 1 筆 warn 且計數為 100。

---

## O-05 輸出格式不一致：`TP_READY` vs `EGO_READY`、版本 0.3.1 vs 0.3.0 · **P2**

- **位置**：`scripts/tp-start.sh`（`TP_READY (...)` / `TP_NOT_READY`）、`scripts/ego-start.ps1`（`EGO_READY (...)` / `EGO_NOT_READY`）、`bin/*.js` 的 `version`（`0.3.1`）與 `package.json`（`0.3.0`）。
- **影響**：Agent 與 doctor 需要機器可讀的單一格式；目前要靠字串比對兩種前綴，且版本數字不一致會誤導排查（「你裝的是 0.3.1 嗎？」「不是，repo 是 0.3.0」）。
- **建議修法**：統一輸出**一行 JSON**（保留舊字串於同一行的註解欄位以維持相容）：
  ```json
  {"evt":"ready","port":9772,"chromePort":9773,"os":"Linux","mode":"headless","version":"0.3.0"}
  ```
  版本改為單一來源（讀 `package.json`，見 L-01）。同時 `bin/*.js` 在等待啟動時先向 stderr 印一行 `[tp-browser] starting browser (up to 60s)...`。
- **驗證方式**：`tp-start` 與 `tp-browser start` 的輸出皆可被 `JSON.parse`（取最後一行）；`version` 等於 `package.json`。

---

## O-06 日誌分散三處，重複或遺失 · **P2**

- **位置**：`scripts/tp-start.sh` 的 `spawn_detached`（`stdio: ["ignore", out, out]`）只把 daemon 的 stdout/stderr 導到 `daemon.log`；但 CLI 的 `runLauncher(..., quietStdout=true)` 又把 launcher 的 stdout 丟棄、stderr 繼承。`scripts/ego-start.ps1` 透過 WMI `Win32_Process.Create` 啟動，**完全沒有重導**（輸出到哪裡未知，待確認）。
- **影響**：同一個錯誤可能同時出現在 CLI stderr 與 daemon.log（重複），也可能在 Windows 上完全消失（遺失）。Agent 拿到的錯誤訊息因此不穩定。
- **建議修法**：明確定義兩條通道：(a) **結果通道**（stdout）只放單行 JSON；(b) **日誌通道**（stderr + 檔案）放進度與診斷，並統一加上 `[tp-start]`／`[tp-daemon]` 前綴。Windows 端以 `cmd /c "... 1>>log 2>>&1"` 明確重導。
- **驗證方式**：在測試機制造一次啟動失敗（`TP_BROWSER_BIN` 指向不存在路徑），斷言 CLI stderr 有原因、`daemon.log`/`chrome.log` 也有對應記錄（不再依平台而異）。

---

## 建議的最小可用「可觀測性三件套」

| 能力 | 介面 | 實作成本 |
|---|---|---|
| 現在卡在哪 | `/health` 的 `inflight[]` + `tp-browser status` | 小（一個 Map + 一個欄位） |
| 哪個 method 慢/常錯 | `/health` 的 `stats.rpc` + `doctor` top 5 | 小（環形緩衝 200 筆） |
| 事故現場 | `lib/log.js` 單行結構化日誌 + 檔案輪替（L-08） | 中（需全面替換 console） |
