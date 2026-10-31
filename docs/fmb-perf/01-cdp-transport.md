# 01 · CDP 傳輸層審查（`daemon/cdp.js`）

`daemon/cdp.js` 是所有頁面操作的單一出口：它把 HTTP/SSE 進來的 RPC 轉成 CDP 指令，因此**它的逾時語意、pending 管理與連線存活判斷，直接決定 Agent 每一步的延遲與失敗模式**。

---

## C-01 `send()` 逾時只 reject，不取消、不留痕跡 · **P1**

- **位置**：`daemon/cdp.js` · `send()` 內的 `const timer = setTimeout(() => { this.pending.delete(id); reject(...) }, timeout)`。
- **影響**：
  1. CDP 指令本身**不會被取消**（CDP 無取消機制），回應稍後到達時 `_recv()` 因 `if (!p) return;` **靜默丟棄**，外部只看到「timed out after 30000ms」，無從判斷是「Chrome 忙」「頁面無限迴圈」還是「連線半死」。
  2. 沒有任何一處記錄**哪個 method 逾時了幾次**，導致 P1 級效能問題（例如 `Page.navigate` 常態 28 秒）無法被發現。
- **建議修法**：
  - reject 的 Error 加上 `code`（`E_CDP_TIMEOUT`）、`method`、`elapsedMs`：
    ```js
    const err = new Error(`${method} timed out after ${timeout}ms`);
    err.code = 'E_CDP_TIMEOUT'; err.method = method; err.elapsedMs = timeout;
    reject(err);
    ```
  - 逾時時以 `warn` 等級記一行結構化日誌（見 [06-observability.md](./06-observability.md)），欄位只放 `method`、`sessionId` 是否有值、`timeout`，**不放 params 內容**（可能含輸入值）。
  - 保留一個短期 `recentlyTimedOut` Map（method → 次數，60 秒窗口），讓 `/health` 能顯示「最近有哪些指令在逾時」。
- **驗證方式**：以注入式假 WebSocket（見 V-01）送出指令但永不回應，斷言 reject 物件含 `code === 'E_CDP_TIMEOUT'`、且假 logger 收到 1 筆 warn；再把延遲回應送進來，斷言不會產生未處理的 rejection。

---

## C-02 `this.sessions` 無界累積且無讀取者 · **P1**

- **位置**：`daemon/cdp.js` · `_recv()` 的 `if (msg.sessionId) this.sessions.add(msg.sessionId);`。
- **影響**：每次 attach 一個 target（每個新分頁、每個 OOPIF）都會產生新 sessionId，而 `sessions` 只增不減。長時間常駐（數天）+ Agent 反覆開關分頁 → Set 無界成長；`sessions` 在檔案中**沒有任何讀取點**，屬死資料。這是典型的緩慢記憶體洩漏，且難以從外部察覺。
- **建議修法**：
  - 若確實無人使用 → 直接移除該欄位（最小改動）。
  - 若未來要用 → 改為 `Map<sessionId, {targetId, createdAt}>`，在 `Target.detachedFromTarget` / `Target.targetDestroyed` 事件中刪除，並設上限（例如 512）超過即以 LRU 淘汰。
- **驗證方式**：V-01 的假 WS 連餵 10,000 個不同 `sessionId` 的 `Runtime.consoleAPICalled` 事件，斷言 `sessions.size` 有上限；或跑 24 小時常駐 soak，比較 `process.memoryUsage().heapUsed` 斜率。

---

## C-03 無心跳／存活偵測，半開連線只能等逾時 · **P1**

- **位置**：`daemon/cdp.js` · `connect()` 只設 `onopen/onerror/onclose/onmessage`，沒有任何 keepalive；`send()` 的前置檢查只有 `this.closed || readyState !== 1`。
- **影響**：筆記型電腦休眠喚醒、VPN/網路切換、Chrome 主程序 hang 住時，TCP 可能處於半開狀態而 `readyState` 仍是 `1`。此時每個 RPC 都會**各自等滿 30 秒**才失敗，Agent 表現為「每一步都莫名卡 30 秒」，且 `onClose` 不觸發 → 上層無從重連。
- **建議修法**：
  - 連線成功後啟動 `setInterval`（10~15 秒）送 `Browser.getVersion`（`timeout: 3000`），連續 2 次失敗即 `this.close()`，讓 `onClose` 走正常恢復路徑。
  - 心跳 timer 必須 `.unref()`，否則會額外釘住 CLI 的 event loop（目前 CLI 是靠 `process.exit()` 硬退出，見 L-02，正是這個徵狀）。
  - 心跳結果順便可回報 `browserVersion`，讓 `/health` 有更準確的存活資訊。
- **驗證方式**：故障注入 —— 對 daemon 與 Chrome 之間的連線做「假半開」（在測試中以假 WS 停止回應但不 close），斷言 30 秒內觸發 `onClose` 且後續 `send()` 立即以 `E_CDP_CLOSED` 失敗（而非等 30 秒）。

---

## C-04 `connect()` 錯誤路徑狀態不一致 · **P2**

- **位置**：`daemon/cdp.js` · `ws.onerror = () => { clearTimeout(timer); reject(...) }`。
- **影響**：`onerror` 只 reject，未 `close()`、未清 `pending`、未把 `this.closed` 設為 true、也未觸發 `closeHandlers`。若瀏覽器端之後沒有送出 close frame，`this.ws` 為 `null` 但 `this.closed === false`，後續 `send()` 會回 `'CDP connection closed'`（訊息誤導，實際是「從未連上」）。上層的 `onClose` 恢復邏輯也不會被觸發。
- **建議修法**：抽出 `_teardown(reason)`：`closed = true` → 清 pending（逐筆 reject 帶 `reason`）→ 觸發 `closeHandlers` → `ws.close()`。`onerror` 與 `onclose` 都走它（具 idempotent 保護），並把 `connect` 失敗的 Error 加上 `code: 'E_CDP_CONNECT'`。
- **驗證方式**：假 WS 在 `onopen` 前觸發 `onerror`，斷言 `closed === true`、`pending.size === 0`、`closeHandlers` 觸發 1 次、第二次 `_teardown` 不重複觸發。

---

## C-05 `ws.send()` 同步拋出時 pending 與 timer 洩漏 · **P2**

- **位置**：`daemon/cdp.js` · `send()`：先 `this.pending.set(id, { ..., timer })` 再 `this.ws.send(...)`，兩者之間無 try/catch。
- **影響**：`readyState` 檢查與 `send()` 之間若狀態改變（競態），`ws.send` 會同步拋出；在 Promise executor 內拋出雖會 reject，但 `pending` 條目與 `timer` 都留著 → 每個失敗殘留一個最多 30 秒的 timer，常駐 daemon 會被無效喚醒拖慢，CLI 進程也會多活 30 秒。
- **建議修法**：
  ```js
  try {
    this.ws.send(JSON.stringify(msg));
  } catch (e) {
    clearTimeout(timer);
    this.pending.delete(id);
    reject(Object.assign(new Error(`${method} send failed: ${e.message}`), { code: 'E_CDP_SEND' }));
  }
  ```
- **驗證方式**：假 WS 的 `send` 直接 throw，斷言 `pending.size === 0`、測試結束後 `process._getActiveHandles()` 沒有殘留 timer（或以 `t.after` 檢查）。

---

## C-06 逾時值硬編碼且分散，無分 method 設定 · **P2**

- **位置**：`daemon/cdp.js` · `connect(timeoutMs = 15000)`、`send(..., { timeout = 30000 })`、`once(..., { timeout = 30000 })`；上層 `bin/*.js` 另有 2500 ms 的健康檢查。
- **影響**：調整逾時必須 grep 多處，且各層數字互相打架（上層 5 秒放棄、下層 30 秒才失敗 → 錯誤訊息指向錯誤的層）。不同 CDP method 的合理逾時差異很大：`Page.navigate` 需要長逾時、`Input.dispatchMouseEvent` 應該短逾時快速失敗。
- **建議修法**：新增 `lib/timeouts.js`，集中一張表 + 環境變數覆寫（例如 `TP_CDP_TIMEOUT_MS`、`TP_CDP_CONNECT_MS`、`TP_NAV_TIMEOUT_MS`、`TP_RPC_TIMEOUT_MS`、`TP_HEALTH_TIMEOUT_MS`），`cdp.js` 與 `bin/*.js` 一律引用；預設值寫進文件。詳見 [05-timeouts-retries-recovery.md](./05-timeouts-retries-recovery.md) T-01。
- **驗證方式**：設定 `TP_CDP_TIMEOUT_MS=50`，對假 WS 發一條不回應的指令，斷言約 50 ms 即 reject；並檢查 `grep -rn "30000" daemon/ bin/` 只剩 `lib/timeouts.js` 一處。

---

## C-07 高頻事件的 handler 掃描與錯誤洗版 · **P3**

- **位置**：`daemon/cdp.js` · `_recv()` 內 `for (const fn of this.handlers) { try { fn(...) } catch (e) { console.error('[ego-browserd] handler error:', e); } }`。
- **影響**：`handlers` 為 Set，每次事件線性掃描；handler 數量通常很小，暫不構成瓶頸。但**錯誤只印一次 console.error 且無 method/sessionId**，若高頻事件（`Runtime.consoleAPICalled`、`Network.*`）的 handler 持續出錯，會把日誌洗掉並掩蓋真正的問題。
- **建議修法**：錯誤訊息加上 `method`；對相同 `(method, 錯誤訊息)` 做 60 秒去重並附上被抑制次數；handler 註冊數超過門檻（例如 32）時記一行 warn 提示洩漏可能。
- **驗證方式**：假 WS 連餵 1,000 筆同 method 事件、handler 每次 throw，斷言日誌只輸出 1 筆（+ 抑制計數 999）。

---

## C-08 大型 payload 無背壓與大小上限 · **P2**

- **位置**：`daemon/cdp.js` · `_recv()` 對每個訊息同步 `JSON.parse`；`send()` 對回傳值無大小限制。
- **影響**：`Page.captureScreenshot` 的回傳是 base64（1440×900 PNG 可達數 MB，JPEG 小一個數量級），`Runtime.evaluate` 若回傳整頁 `innerText` 或大物件也可能是 MB 級。這些都在同一個執行緒同步解析，單一 20~30 MB 訊息會造成百毫秒級停頓，期間所有其他 RPC 一併排隊（對 Agent 表現為「突然卡一下」）。
- **建議修法**：
  - 截圖預設改 `format: 'jpeg'` + `quality`（並在 SDK 文件說明可切回 PNG）。
  - `evaluate` 的回傳在上層（`page-ops.js`，本次未取得內容）明確截斷，並回傳 `{ truncated: true, totalChars }` 讓 Agent 知道。
  - `_recv()` 對 `raw` 長度超過門檻（例如 8 MB）記 warn（只記長度，**不記內容**）。
- **驗證方式**：在 `tests/serve.mjs` 的本機頁面塞一個 5 MB 的回傳物件，量測 `evaluate` RTT 與其他並行 RPC 的延遲；導入大小上限後比較 p95。
