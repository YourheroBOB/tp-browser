# 05 · 逾時、重試與錯誤恢復

本檔案處理跨層的行為一致性：**同一個故障在不同層要用同一組數字與同一套語意處理**，否則會出現「上層已放棄、下層還在等」與「重試造成重複副作用」。

---

## T-01 逾時值分散且無單一來源 · **P1**

- **位置（已確認）**：`daemon/cdp.js`（15000 / 30000）、`bin/*.js`（`AbortSignal.timeout(2500)` 於 `health()`；`rpcCmd()` 無）、`scripts/tp-start.sh`（`curl --max-time 1~3`、`sleep 0.3/0.6/1.0`）、`scripts/ego-start.ps1`（`-TimeoutSec 1~3`、`Start-Sleep -Milliseconds 400/500/800/1000`）。
- **影響**：要調整任何一個逾時都得 grep 五、六個檔案；各層數字不對齊時，錯誤訊息會指向錯的層（例：CLI 5 秒放棄，但底層其實 30 秒才失敗，使用者看到的是「逾時」但日誌沒有任何記錄）。
- **建議修法**：新增 `lib/timeouts.js`：

  | 名稱 | 預設 | 用途 |
  |---|---|---|
  | `TP_CDP_CONNECT_MS` | 15000 | WebSocket 建立 |
  | `TP_CDP_MS` | 30000 | 一般 CDP 指令 |
  | `TP_NAV_MS` | 45000 | `Page.navigate` 等長操作 |
  | `TP_RPC_MS` | 30000 | CLI → daemon HTTP |
  | `TP_HEALTH_MS` | 2500 | 健康檢查 |
  | `TP_FLUSH_MS` | 5000 | `/flush-and-close` |

  全部可由環境變數覆寫，並在 `tp-browser doctor` 印出實際生效值。
- **驗證方式**：`TP_CDP_MS=50 node -e "import('./daemon/cdp.js')..."`（或單元測試）斷言生效；`grep -rn "30000\|2500" bin/ daemon/ lib/` 只應命中 `lib/timeouts.js` 的預設表。

---

## T-02 沒有重試分類：讀取類與副作用類混在一起 · **P1**

- **位置**：`daemon/cdp.js`（無重試）、`bin/*.js`（`ensureRunning()` 只重試啟動，不重試 RPC）、`lib/sdk.js`（**未取得內容，待確認**）。
- **影響**：目前兩種困擾同時存在：
  1. 可安全重試的**讀取**（`Target.getTargets`、`Runtime.evaluate` 的純讀取、`Page.captureScreenshot`）在連線瞬斷時直接失敗，Agent 只能整個 turn 重跑，浪費大量 token。
  2. 若未來有人「為了穩定」在 SDK 層對所有 RPC 加重試，**點擊/輸入會被重複執行**（重複送訊息、重複下單、重複送出表單）——這是遠比逾時更嚴重的錯誤。
- **建議修法**：在 RPC 定義上標註兩個旗標 `idempotent` 與 `retryable`；只對 `{ idempotent: true, retryable: true }` 做指數退避重試（3 次，200/600/1800 ms + jitter，總計 ≤ 3 s）；其餘一律回傳明確錯誤碼 `E_NOT_RETRYABLE` 並附「請先確認頁面狀態再重試」的訊息。`goto`/`click`/`fill`/`press` 一律不自動重試。
- **驗證方式**：單元測試以假 `rpc` 對 `evaluate` 注入兩次 `E_CDP_TIMEOUT`，斷言第三次成功且共呼叫 3 次；對 `click` 注入一次逾時，斷言**只呼叫 1 次**且錯誤碼為 `E_NOT_RETRYABLE`。

---

## T-03 Chrome／daemon 斷線後的重連路徑未定義 · **P1（待驗證）**

- **位置**：`daemon/cdp.js` 提供 `onClose()`，但重連責任在 `daemon/ego-browserd.js`（**未取得內容**）。`bin/*.js` 的 `doctor()` 文案提到「daemon is up but Chromium not attached; it retries every 3s once chrome answers」，暗示 daemon 有 attach 重試。
- **影響**：若 Chrome 崩潰後 daemon 內既有的 `Cdp` 物件 `closed === true` 而沒有重建邏輯，之後所有 RPC 都會立刻回 `CDP connection closed`，使用者必須 `tp-stop` + `tp-start`（失去所有 TaskSpace 綁定）。反之若有重建，需確認 `store.js` 的 `targetId` 重綁定與「已消失的 target」清理是否正確（`store.js` 註解聲稱會 drop，但 `load()`/prune 邏輯未見）。
- **建議修法**：daemon 內集中一個 `ensureCdp()`：偵測 `closed` 或心跳失敗 → 新建 `Cdp` → 重新 `Target.getTargets` → 依 `store` 的 `targetId` 重新綁定（找不到的標記為 `lost` 並保留 label，讓 Agent 可以重新 `goto`）。並在 `/health` 回報 `cdp: { connected, reconnects, lastError }`。
- **驗證方式**：測試中 `kill` 掉 Chrome 程序，等待 10 秒後執行 `tp-start`（不重啟 daemon），斷言 `/health` 回到 `chrome:true` 且 `cdp.reconnects >= 1`；原本的 space 標籤仍存在、狀態標為 `lost` 而非整個消失。

---

## T-04 導航逾時語意不明，慢站直接讓整個 turn 失敗 · **P2**

- **位置**：`skills/tp-browser/SKILL.md` 的範例與 `bin/*.js` 的說明都預設 `{ waitUntil: "load", timeout: 30000 }`；實際實作在 `daemon/page-ops.js`（**未取得內容**）。
- **影響**：長頁面/追蹤腳本多的站台，`load` 事件常超過 30 秒；Agent 一旦逾時就整個腳本失敗，白費前面所有步驟（單 turn 批次腳本的缺點被放大）。
- **建議修法**：SDK 提供 `goto(url, { waitUntil, timeout, throwOnTimeout: false })`，逾時時回傳 `{ timedOut: true, readyState }` 讓腳本可繼續（後續用條件等待），並在 SKILL 文件給「慢站建議：`waitUntil:'domcontentloaded'` + 自行等條件」的範例。
- **驗證方式**：在本機 `tests/serve.mjs` 加一個延遲送出的路由（例如 5 秒才回應），以 `timeout: 1000` 驗證 `timedOut: true` 且不拋錯，`timeout: 1000, throwOnTimeout: true` 則拋出帶 `code: 'E_NAV_TIMEOUT'` 的錯誤。

---

## T-05 `once()` 在連線已關閉時仍等滿 timeout · **P2**

- **位置**：`daemon/cdp.js` · `once()` 只註冊 `onEvent` 與 `setTimeout`，沒有監聽 `onClose`。
- **影響**：等待某個 CDP 事件（例如 `Page.loadEventFired`）時若連線中斷，會空等到 30 秒才失敗，而不是立刻失敗。
- **建議修法**：`once()` 內同時註冊 `cdp.onClose(...)`，close 時 `clearTimeout` 並 reject `E_CDP_CLOSED`（記得在成功/逾時路徑 `off()` 兩個註冊）。
- **驗證方式**：假 WS 在 `once()` 等待期間觸發 `onclose`，斷言 100 ms 內 reject 且錯誤碼為 `E_CDP_CLOSED`、事件 handler 已被移除。

---

## T-06 錯誤資訊跨層衰減 · **P2**

- **位置**：`daemon/cdp.js` 的 `CdpError`（保留 `cdpError`）→ `bin/*.js` 的 `rpcCmd()`：`throw new Error(`${j.error?.name}: ${j.error?.message}`)` → `main().catch` 只印 `name: message`。
- **影響**：CDP 的 `code`（例如 `-32000`）與 `method` 在 CLI 端消失，使用者/Agent 只看到 `CdpError: Runtime.evaluate: Cannot find context with specified id`，無法判斷是頁面已導航還是 target 已關閉，也不知道下一步該做什麼。
- **建議修法**：錯誤序列化時帶 `code`、`method`、`sessionId`（**不含 params**）；CLI 印成 `[E_CDP_ERROR code=-32000 method=Runtime.evaluate] message`；`doctor --verbose` 才印完整物件。並在 SDK 對常見 CDP 錯誤碼提供「建議下一步」對照表。
- **驗證方式**：假 HTTP 伺服器回傳 `{ ok:false, error:{ name:'CdpError', message:'x', code:-32000, method:'Runtime.evaluate' } }`，斷言 CLI 輸出含 code 與 method。

---

## T-07（待驗證假設）`lib/sdk.js` 的 SSE 佇列與重連 · **P1（待確認）**

- **位置**：`lib/sdk.js`（**本次未取得內容**）；`bin/*.js` 以 `createClient({ port, token })` 取得 `{ rpc, waitPush }`。
- **需確認的四點**：
  1. `waitPush` 是否有**上限**：若 daemon 推送速度 > 腳本消費速度（例如 `Runtime.consoleAPICalled` 高頻），佇列是否無界成長（在單 turn 腳本裡很容易被忽略，因為腳本一結束行程就退出；但常駐用法會爆）。
  2. SSE 斷線（daemon 重啟）是否有**重連 + 退避**，重連期間 `waitPush` 的承諾是否會被永久懸掛（hang）。
  3. `fetch` 串流是否有 `AbortSignal`，CLI 結束時是否釋放。
  4. `rpc()` 是否共用 keep-alive（`undici` Agent）或每呼叫一條新連線（後者在小 RPC 高頻時會多出可觀延遲）。
- **建議修法（待確認後調整）**：佇列上限 + 丟棄策略（記 warn 與計數）、重連退避（500 ms → 5 s，上限）、重連期間 `waitPush` 明確 reject `E_SSE_DISCONNECTED`、提供 `close()`。
- **驗證方式**：以本機假 SSE 伺服器推送 100,000 筆事件但不消費，斷言佇列上限生效；中途關閉連線，斷言 5 秒內 reject 而非永掛。

---

## T-08（待驗證假設）`daemon/page-ops.js` 與 `daemon/inpage.agent.js` 的熱路徑 · **P1（待確認）**

- **位置**：`daemon/page-ops.js`、`daemon/inpage.agent.js`（**本次未取得內容**）。已知它在 `daemon/page-ops.js` 內做 `Network.setUserAgentOverride` 與 `Page.addScriptToEvaluateOnNewDocument`（依 `STATE.md` 描述）。
- **需確認的四點**：
  1. `snapshot()` 是否每次都走完整 DOM 走訪（`querySelectorAll('*')`）並在頁面極大時產生 MB 級字串；是否有 `only_within_viewport` 等既有選項的實際效能。
  2. `evaluate()` 的回傳序列化是否可能在大型物件上遞迴爆掉或產生巨字串（配合 C-08）。
  3. `Page.addScriptToEvaluateOnNewDocument` 注入的腳本大小與每次新文件的成本。
  4. `setInputFiles` / `screenshot` 的路徑檢查（`safePath`）是否每次 `realpathSync` 造成額外 I/O（可接受，但要量測）。
- **建議修法（暫定）**：`snapshot()` 加上元素數與輸出大小的上限、預設只取可見區域、快取 selector 對照表；`evaluate` 結果超過門檻截斷並回報 `truncated`。
- **驗證方式**：以本機 `tests/bench/` 的 10 頁（`tests/serve.mjs` 起在本機）量測 `snapshot` 的字元數與耗時，建立基線表後比較修改前後。
