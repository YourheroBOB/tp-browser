# tp-browser 效能與可靠性審查報告

> **文件狀態**：提案與改善報告。只新增文件，未修改任何既有檔案。  
> **基準**：本次提供的 repo 內容快照。  
> **安全邊界**：不含任何實際 token、金鑰、密碼、客戶個資、LINE 訊息內文或案件當事人資料。

## 一頁結論

1. 最明確效能瓶頸：`daemon/store.js` 每次變更整份 JSON 同步寫回，且 ledger 無自動回收。
2. 最明確資源洩漏：`daemon/cdp.js` WebSocket 關閉時未清除 pending request 的 timer；`once()` 未在斷線退訂。
3. 最明確競態：`Store` 無跨程序鎖，多 daemon 同寫一份 ledger 會互相覆寫。
4. 最明確錯誤恢復缺口：`Store.load()` 不驗證形狀；`persist()` 在 rename 失敗時退回直接寫入，破壞原子性。
5. 最明確可觀測性缺口：只有 `console.*`，無時間戳、層級、關聯 ID、metrics、SLO、輪轉；上線結構化日誌前必須先上脱敏。
6. 啟停流程過度依賴固定 `sleep` 與全域 `pkill`，慢環境或大型 profile 容易誤判或誤殺。
7. 安裝流程先刪後複製，非原子；`install.sh` 未遞迴複製 `docs/` 子目錄。

## 總覽表

| ID | 類別 | 位置 | 優先級 | 一句話 |
|---|---|---|---|---|
| P-01 | 效能 | `daemon/store.js` `persist()` | P1 | 每次變更整份 JSON 同步寫回 |
| P-02 | 效能／資源 | `daemon/store.js` + `fmb_feature2/reaper.js` 未整合 | P1 | ledger 只增不減，`labelSeq` 也殘留 |
| P-03 | 併發 | `daemon/store.js` 全域單檔 | P1 | 多 daemon 寫同檔互相覆寫 |
| P-04 | 錯誤恢復 | `daemon/store.js` `load()` | P0 | 不驗證形狀；壞檔直接 fresh，可能靜態遺失 |
| P-05 | 錯誤恢復 | `daemon/store.js` `persist()` | P0 | rename 失敗退回直接寫入，破壞原子性並留暫存檔 |
| P-06 | 錯誤恢復 | `daemon/store.js` `setPage()/removePage()/deleteSpace()` | P2 | 部分失敗靜默、`labelSeq` 未同步清理 |
| R-01 | 資源洩漏 | `daemon/cdp.js` `connect()/send()/once()` | P1 | close 時未 `clearTimeout`，once 未退訂 |
| R-02 | 逾時／併發 | `daemon/cdp.js` `send()` | P1 | 固定 30s 逾時、無背壓、無安全重試 |
| R-03 | 錯誤恢復 | `daemon/cdp.js` 無 reconnect | P1 | CDP 斷線後沒有補救與目標重掛 |
| R-04 | 可觀測性 | `daemon/cdp.js` `_recv()` | P2 | JSON 解析失敗靜默丟棄 |
| S-01 | 逾時 | `scripts/tp-start.sh` | P1 | 固定輪詢 10 秒、固定 sleep，慢環境誤判 NOT_READY |
| S-02 | 錯誤恢復 | `scripts/tp-start.sh` profile-init | P2 | 同步執行、失敗被 `|| true` 吞掉 |
| S-03 | 錯誤恢復 | `scripts/tp-start.sh` `spawn_detached()` | P2 | 子程序 spawn／exit 錯誤沒有回傳 |
| S-04 | 錯誤恢復 | `scripts/tp-stop.sh` | P1 | flush 一次、固定 sleep、全域 `pkill` |
| S-05 | 錯誤恢復 | `scripts/ego-stop.ps1` | P1 | 沒有 flush-and-close、錯誤被靜默吞掉 |
| S-06 | 可靠性 | `scripts/ego-linux-*.service` | P2 | 缺少 stop timeout、重試上限、啟動順序保護 |
| I-01 | 錯誤恢復 | `install.sh`、`install.ps1` | P1 | 先刪後複製，非原子安裝，失敗難回滾 |
| I-02 | 可靠性 | `install.ps1` | P2 | 暫存 clone 未用 finally 清理，啟動後未等待健康 |
| I-03 | 可靠性 | `install.sh` docs 複製 | P2 | `cp "$SRC/docs/"*` 未加 `-R`，子目錄不會進位 |
| O-01 | 可觀測性 | `daemon/*` 目前只有 `console.*` | P1 | 無結構、無層級、無關聯 ID、無輪轉 |
| O-02 | 可觀測性 | daemon 無 `/metrics` | P1 | 無法量化延遲、積壓、ledger 大小 |
| O-03 | 安全／可觀測性 | 日誌脱敏尚未制度化 | P0 | 若先上結構化日誌可能記錄 URL／title／案件線索 |

---

## A. 效能瓶頸

### P-01 Store 每次變更都整份同步持久化

- **位置**：`daemon/store.js` → `create()`、`nextLabel()`、`setPage()`、`bindPage()`、`addPage()`、`removePage()`、`deleteSpace()` 都呼叫 `persist()`
- **影響**：
  - ledger 變大後，每次開分頁、更新 title/url、刪分頁都會序列化整份 JSON。
  - 單一 Agent 任務可能觸發多次 `setPage`，造成磁碟 I/O 尖峰與 RPC 尾延遲上升。
  - 沒有 fsync；rename 雖原子，但崩潰時可能遺失尚未落盤資料。
- **建議修法**：
  1. 區分「結構變更」與「內容更新」：`create/deleteSpace/bindPage/addPage/removePage` 維持立即 persist；`setPage/nextLabel` 採短延遲批次（建議 100–250ms）或上限 1s 強制 flush。
  2. persist 前計算 JSON 大小，超過門檻時只記 metrics，不記內容。
  3. 增加 `tp_store_persist_duration_ms`、`tp_store_ledger_bytes`。
  4. 需要更強持久性時再評估 fsync；預設不要每次 fsync，避免慢碟放大延遲。
- **驗證方式**：
  - 在 `mkdtempSync(tmpdir())` 造 50／500／5000 個 space，量測 `create/setPage` p50/p95。
  - 新增 `node --test`：批次期間多次 `setPage()` 只產生一次實際寫檔。
  - 模擬 `renameSync` 失敗，確認不留 `.tmp` 且舊 ledger 仍可用。
- **優先級**：P1

### P-02 Ledger 無自動回收，`labelSeq` 也會殘留

- **位置**：`daemon/store.js`（無清理路徑）；`fmb_feature2/reaper.js`（已完成未整合）
- **影響**：
  - 背景常駐一週後，`space.list` 回傳大量已失效 target，Agent 與人類看到幽靈分頁。
  - ledger JSON 與 `labelSeq` 只增不減，直接放大 P-01 的寫入成本。
- **建議修法**：
  1. 依 `docs/fmb/ROADMAP.md`，將 `fmb_feature2/reaper.js` 以低頻計時器整合進 daemon。
  2. 初始保守 policy：`idleSpaceMs: 6h`、`maxSpaces: 500`；live target 集合為空時完全不動作。
  3. 先只輸出 `stats` 一週，確認沒有誤收再放寬。
  4. `deleteSpace()` 應同步清理 `data.labelSeq[id]`。
- **驗證方式**：
  - 既有 `node --test fmb_feature2/` 維持通過。
  - 新增整合測試：live 集合為空時 ledger 不變；dead space 被回收；存活 space 不被回收。
  - 用 fake `/json/list` 或 fake `Target.getTargets` 驅動，不連線正式服務。
- **優先級**：P1

---

## B. 資源洩漏

### R-01 CDP pending request timer 未在關閉時清除

- **位置**：`daemon/cdp.js` → `connect()` 的 `ws.onclose`、`send()` 的 `pending` Map、`once()`
- **影響**：
  - WebSocket 關閉時，pending request 被 reject，但對應 `setTimeout` 沒有 `clearTimeout`。
  - Chrome 重啟或 daemon 重連後可能堆積 timeout timer，延遲釋放 closure。
  - `once()` 沒有訂閱 `onClose`，CDP 斷線時要等到 timeout 才 reject。
- **建議修法**：
  1. `ws.onclose` 與 `close()` 遍歷 `pending`：先 `clearTimeout(p.timer)` 再 reject。
  2. `send()` timeout 回呼先 `clearTimeout` 再刪除 pending。
  3. `once()` 註冊 `cdp.onClose(() => { clearTimeout(timer); off(); reject(...) })`。
  4. 補 `destroy()` 語意，清空 `handlers`、`closeHandlers`、`sessions`、`pending`。
- **驗證方式**：
  - `node --test` 以 fake WebSocket 觸發 close，斷言 pending promise 立即 reject。
  - 以可注入假 timer 或 mock 斷言 `clearTimeout` 被呼叫。
  - 長時間壓測後檢查 active handles／timer 數是否回落。
- **優先級**：P1

---

## C. 併發／競態

### P-03 Store 沒有跨程序鎖

- **位置**：`daemon/store.js` 單一 JSON 檔；`install.sh`／`scripts/*` 允許同時存在 alt-port 或雙軌部署
- **影響**：
  - 兩個 daemon 同時 `load()` 後各自 `persist()`，會互相覆寫整份 ledger。
  - 結果可能是 space 消失、頁面 targetId 回到舊值、`nextSpaceId` 倒退後重複發號。
- **建議修法**：
  1. 保守方案：一個 `DATA_DIR` 只允許一個 daemon 寫入 Store。
  2. daemon 啟動時以原子方式取得 lock（例如 `openSync(lockfile, 'wx')` 或 `mkdirSync(lockdir)`），寫入 PID。
  3. lock 存在時：PID 不存在視為 stale，記錄後清除；PID 存在且屬於其他 tp-browserd 則拒絕啟動並回明確錯誤。
  4. 若未來必須多 daemon 共用 ledger，再設計 reload + merge + revision，不在無鎖下直接寫。
- **驗證方式**：
  - `node --test` 在同一 `mkdtempSync(tmpdir())` 啟動兩個 lock 持有者，第二個必須失敗。
  - 模擬 stale lock（PID 不存在），確認可安全恢復。
  - 兩 process 同時 `create()`，最終 ledger 不得遺失任一 space。
- **優先級**：P1

---

## D. 逾時、重試與錯誤恢復

### P-04 `Store.load()` 不驗證形狀，壞檔直接 fresh

- **位置**：`daemon/store.js` → `load()`
- **影響**：
  - 內容是 `{}`、`{"spaces": null}`、`{"spaces": []}` 時，`list()/create()` 可能拋 TypeError。
  - JSON 壞掉時直接 fresh，若只是部分損毀，可能永久失去 ledger。
  - 沒有備份、quarantine、schema 版本。
- **建議修法**：
  1. `load()` 改 normalize：預設 `{ nextSpaceId: 1, labelSeq: {}, spaces: {} }`。
  2. 驗證 `spaces`、`labelSeq` 必須是 plain object；`nextSpaceId` 缺漏或非法時用 `max(space id) + 1` 推導。
  3. 解析失敗時保留原檔為 `.corrupt.<timestamp>`，放同一 `DATA_DIR`，不複製到日誌。
  4. 只記錄 `errorName`、`fileSize`，不記錄內容；寫入時加 `schemaVersion`。
- **驗證方式**：
  - `node --test` 覆蓋 `{}`、壞 JSON、`spaces: []`、`labelSeq: null`、`nextSpaceId: 'x'`。
  - 斷言 `load()` 後 `list()` 不拋錯，`create()` 可持續。
  - 壞檔案例斷言原檔保留且新 ledger 可用。
- **優先級**：P0

### P-05 `persist()` 的 fallback 破壞原子寫入

- **位置**：`daemon/store.js` → `persist()`
- **影響**：
  - `renameSync` 失敗時直接 `writeFileSync(this.file, body)`，若中途崩潰會留半份 JSON。
  - rename 失敗時不清理 `${file}.${pid}.tmp`，重試後可能堆暫存檔。
- **建議修法**：
  1. 預設只用 `tmp -> rename` 原子寫入。
  2. rename 失敗時清理自己的 `.tmp`，丟出錯誤讓上層知道，不靜默寫正式檔。
  3. 可對 rename 做有限重試（例如 3 次，10ms/50ms/100ms），但不改寫正式檔。
  4. 若未來要 fsync，採「先 rename 再 fsync 檔案」，避免每次寫入都做昂貴 fsync。
- **驗證方式**：
  - mock `renameSync` 拋錯，斷言正式檔內容不變、`.tmp` 被清掉、錯誤可被捕捉。
  - 崩潰模擬：寫入中途殺 process，重啟後舊 ledger 仍可 `load()`。
- **優先級**：P0

### P-06 部分 Store 操作靜默失敗

- **位置**：`daemon/store.js` → `setPage()`、`removePage()`、`deleteSpace()`
- **影響**：
  - `setPage()` 找不到 space/label 時直接 return，呼叫端會以為已更新。
  - `deleteSpace()` 不刪 `labelSeq[id]`，長期殘留。
- **建議修法**：
  1. `setPage()` 找不到對象時拋錯或至少回傳 `false`。
  2. `deleteSpace()` 同步 `delete this.data.labelSeq[id]`。
  3. mutate 方法統一回傳結果或拋錯，不要混用。
- **驗證方式**：
  - 斷言 `setPage('unknown', 'p1', {})` 不會靜默成功。
  - `deleteSpace()` 後斷言 `labelSeq` 無殘留鍵。
- **優先級**：P2

### R-02 CDP `send()` 固定逾時、無背壓、無安全重試

- **位置**：`daemon/cdp.js` → `send()` 預設 `timeout = 30000`
- **影響**：
  - 複雜頁面或大量平行指令下，CDP 可能塞車，固定 30s 全部逾時。
  - 沒有最大 in-flight 上限，批次腳本可能壓倒瀏覽器。
  - 沒有區分冪等與非冪等操作，自動重試可能重複導覽或按鍵。
- **建議修法**：
  1. 增加 config：`connectTimeoutMs` 預設 15000；`sendTimeoutMs` 預設 30000 且可依 method 覆寫；`maxInFlight` 預設 8。
  2. 超過 `maxInFlight` 進 queue；queue 超過上限（例如 100）直接 fail-fast。
  3. 只對安全查詢重試，例如 `Target.getTargets`、`Browser.getVersion`、`Page.getFrameTree`。
  4. `Page.navigate`、`Runtime.evaluate`、`Input.dispatchKeyEvent`、`Target.createTarget`、`Target.closeTarget` 不自動重試。
  5. 重試用 exponential backoff + jitter：100ms、200ms、400ms，最多 3 次。
- **驗證方式**：
  - fake CDP server 延遲回應，斷言 p95 與 queue 長度符合預期。
  - mock 安全方法第一次逾時，斷言重試；mock `Page.navigate` 逾時，斷言不重試。
- **優先級**：P1

### R-03 CDP 斷線後沒有 reconnect／target 重掛

- **位置**：`daemon/cdp.js` 無 reconnect；`daemon/store.js` 只存 `targetId`
- **影響**：
  - Chrome 重啟或崩潰後，daemon 若沒有重連機制，所有 CDP 操作持續失敗。
  - ledger 中 `targetId` 全部失效，`space.list` 變成幽靈清單。
- **建議修法**：
  1. daemon 層實作有限 reconnect：最多 5 次，指數退避 + jitter。
  2. reconnect 成功後以 `Target.getTargets` 重取 live targets，通知 store／reaper 清理 dead target。
  3. 不自動重送失敗的 `Runtime.evaluate`。
  4. 重連期間 `/health` 回 `chrome:false`，不假裝健康。
- **驗證方式**：
  - 本機 fake CDP server：接受連線後主動關閉，再重啟監聽。
  - 斷言重連次數上限、期間請求快速失敗、恢復後 `Target.getTargets` 正常。
- **優先級**：P1

### R-04 CDP 收到無法解析的訊息時靜默丟棄

- **位置**：`daemon/cdp.js` → `_recv()`
- **影響**：
  - JSON 解析失敗直接 `return`，沒有計數與日誌，問題難以定位。
  - Chrome 送半包或協定異常時，看起來像指令沒回應。
- **建議修法**：
  1. 增加 `tp_cdp_parse_errors_total`。
  2. 只記錄 `messageType`、`size`、`errorName`，不記錄原始內容。
  3. 連續解析失敗超過門檻時主動關閉連線並觸發重連。
- **驗證方式**：
  - fake CDP server 送非法 JSON，斷言 counter 增加且不 crash。
  - 連續壞訊息，斷言觸發關閉與重連。
- **優先級**：P2

### S-01 `tp-start.sh` 固定輪詢與固定 sleep

- **位置**：`scripts/tp-start.sh` → `sleep 0.3`、`sleep 1.0`、`sleep 0.6`、20 次 `sleep 0.5`
- **影響**：
  - 慢速磁碟、大型 profile、Cold Chrome 可能超過 10 秒，直接 `TP_NOT_READY`。
  - 固定 sleep 造成過早 kill 或無必要等待。
- **建議修法**：
  1. 增加 `TP_START_TIMEOUT_MS` 預設 30000；`TP_DAEMON_START_DELAY_MS` 預設 300；`TP_STOP_GRACE_MS` 預設 3000–5000。
  2. 輪詢改指數退避：250ms → 500ms → 1s → 2s，到 timeout 為止。
  3. 分階段健康檢查：先 daemon `/health`，再等 `chrome:true`。
  4. 各階段記 `durationMs`。
- **驗證方式**：
  - `sh -n scripts/tp-start.sh`、`shellcheck scripts/tp-start.sh`。
  - 以 fake slow health server 與假 binary 測試 timeout 與失敗路徑，確認不會無限等待。
- **優先級**：P1

### S-02 profile-init 同步執行、失敗被吞

- **位置**：`scripts/tp-start.sh` → `node "$PROFILE_INIT_JS" 2>/dev/null || true`
- **影響**：
  - profile 很大時初始化可能很久，啟動被阻塞且沒有進度。
  - 失敗時仍繼續啟動，後續可能出現缺書籤、缺登入資料或設定不一致。
- **建議修法**：
  1. 必要步驟失敗應讓啟動失敗或至少記 `profile_init_failed` metric。
  2. 若可選，用 `TP_SKIP_PROFILE_INIT=1` 明確跳過，不要 `|| true` 靜默吞掉。
  3. 加 timeout（例如 60s），逾時記 phase 與錯誤，不記 profile 內容。
- **驗證方式**：
  - 以 fake profile-init 分別回傳 0、1、hang，驗證腳本行為。
  - 確認日誌只記 phase、duration、exit code。
- **優先級**：P2

### S-03 `spawn_detached()` 沒有處理子程序錯誤

- **位置**：`scripts/tp-start.sh` → `spawn_detached()`
- **影響**：
  - Chrome 或 daemon spawn 失敗時，只看到最後 `TP_NOT_READY`，缺少根因。
  - 子程序啟動後立即 exit 也不會回傳。
- **建議修法**：
  1. Node helper 加 `child.on('error', ...)` 與 `child.on('exit', ...)`，寫入 `logs/startup.log`。
  2. 只記 `command`、`pid`、`exitCode`、`signal`，不記完整環境或含敏感值的引數。
  3. 啟動前檢查埠號占用，明確失敗，不覆蓋舊服務。
- **驗證方式**：
  - 以不存在的 `TP_BROWSER_BIN` 測試 spawn error 有日誌。
  - 以立即 exit 的假 binary 測試 exit 事件有記錄。
- **優先級**：P2

### S-04 `tp-stop.sh` 過度依賴 `pkill`

- **位置**：`scripts/tp-stop.sh`
- **影響**：
  - `flush-and-close` 只試一次，失敗就往下 `pkill`，Cookie／storage 可能還沒沖刷。
  - `pkill -f "$PROFILE_DIR"` 可能影響命令列中包含相同路徑的其他程序。
  - 固定 `sleep 1.0` 不管 Chrome 是否真的退出。
- **建議修法**：
  1. flush 改重試：例如 3 次，每次 `--max-time 5`，之間 500ms。
  2. flush 後輪詢埠號與 process 狀態，確認退出再 `pkill`。
  3. 以 PID file 或 daemon 回報的 Chrome PID 為目標，避免全域 `pkill -f`。
  4. 停止過程分階段記 `flushMs`、`waitMs`、`killCount`。
- **驗證方式**：
  - 本機 fake daemon：`/flush-and-close` 先失敗兩次再成功，確認不會提前 kill。
  - 啟動與 profile 路徑無關的 sleep 程序，確認不會被誤殺。
- **優先級**：P1

### S-05 Windows `ego-stop.ps1` 沒有 graceful flush

- **位置**：`scripts/ego-stop.ps1`
- **影響**：
  - 直接 `Stop-Process -Force`，沒呼叫 `/flush-and-close`，登入態與 storage 可能不一致。
  - `$ErrorActionPreference = "SilentlyContinue"` 可能吞掉 CIM 查詢錯誤，回報終止 0 個程序。
- **建議修法**：
  1. Stop 前先對 daemon `/flush-and-close` 送請求，含逾時與重試。
  2. 只在 graceful stop 逾時後才 `Stop-Process -Force`。
  3. 不要全域靜默；分開記錄可預期錯誤與非預期錯誤。
  4. 以 PID file 或 `daemon.json` 記錄的 process 為目標，減少誤殺。
- **驗證方式**：
  - 在隔離 Windows 環境以 fake node daemon 與 fake chrome 程序驗證。
  - 斷言 flush 失敗會記日誌，並在逾時後才 force kill。
- **優先級**：P1

### S-06 systemd unit 缺少停止與重試保護

- **位置**：`scripts/ego-linux-browserd.service`、`scripts/ego-linux-chrome.service`
- **影響**：
  - 沒有 `TimeoutStopSec`，systemd stop 可能拖到預設 timeout。
  - 沒有 `StartLimitIntervalSec/StartLimitBurst`，反覆崩潰會無限重啟。
  - daemon 異常退出可能留下 agent profile Chrome 占用 CPU／RAM。
- **建議修法**：
  1. 兩者加 `TimeoutStopSec=30`、`Restart=on-failure`、`RestartSec=3`、`StartLimitIntervalSec=60`、`StartLimitBurst=5`。
  2. daemon 異常退出時，由 daemon 或 stop hook 關閉 agent profile Chrome。
  3. 未來支援健康回報後再加 watchdog；目前不建議假裝支援。
- **驗證方式**：
  - `systemd-analyze verify` 檢查 unit 語法。
  - 本機 user systemd 以 fake service 驗證 restart burst 與 stop timeout。
- **優先級**：P2

---

## E. 日誌與可觀測性

### O-01 只有 `console.*`，沒有結構化日誌與輪轉

- **位置**：`daemon/store.js`、`daemon/cdp.js`、啟動腳本重定向到 `logs/daemon.log`、`logs/chrome.log`
- **影響**：
  - 沒有時間戳、層級、component、event、關聯 ID。
  - `daemon.log` 無限成長，長期背景常駐會吃磁碟。
  - 無法回答「哪個 TaskSpace、哪一頁、哪個 CDP method 變慢」。
- **建議修法**：
  1. 採 JSON lines，允許清單欄位：`ts`、`level`、`component`、`event`、`spaceId`、`pageLabel`、`sessionId`、`method`、`durationMs`、`ok`、`errorName`、`errorMessage`。
  2. 不得記錄頁面內容、Cookie／token／密碼、完整 URL、title、案件內容、LINE 訊息內文。
  3. 加本地輪轉：例如 16MB × 5，只用 Node 內建模組。
  4. 先上脱敏，再開結構化日誌。
- **驗證方式**：
  - `node --test` 以 fake space/page/cdp event 驅動，斷言輸出可解析且只含允許欄位。
  - 脱敏測試：餵入含假 token `FAKE_VALUE_FOR_TEST`、假 URL、假 title，斷言不出現在日誌。
  - 輪轉測試：在 `mkdtempSync(tmpdir())` 寫超過門檻，確認只保留 N 份。
- **優先級**：P1

### O-02 沒有 metrics，無法量化效能與可靠性

- **位置**：daemon 目前只有 `/health` 回布林；無 `/metrics`
- **影響**：
  - 無法知道 ledger 大小、persist 延遲、CDP pending、reconnect 次數、RPC 錯誤率。
  - 出問題只能翻日誌，無法設 SLO 或告警。
- **建議修法**：
  1. 新增 loopback + token 保護的 `/metrics`，採 Prometheus text format，零相依。
  2. 第一版指標：
     - `tp_store_spaces`
     - `tp_store_pages`
     - `tp_store_ledger_bytes`
     - `tp_store_persist_duration_ms`
     - `tp_store_persist_errors_total`
     - `tp_cdp_pending`
     - `tp_cdp_inflight`
     - `tp_cdp_send_duration_ms`
     - `tp_cdp_timeouts_total`
     - `tp_cdp_reconnects_total`
     - `tp_rpc_duration_ms`
     - `tp_rpc_errors_total`
     - `tp_health_latency_ms`
     - `tp_startup_phase_duration_ms`
     - `tp_log_rotations_total`
  3. 標籤只用安全值，例如 `method`、`route`、`result`；不得使用 URL、title、space name。
  4. SLO 草案：本機 RPC p95 < 2s；CDP send p95 < 10s；Store persist p95 < 50ms；`tp-start` ready p95 < 30s。
- **驗證方式**：
  - `node --test` 以本機 `127.0.0.1` 與假 token `FAKE_VALUE_FOR_TEST` 請求 `/metrics`。
  - 斷言可解析且不含 URL、title、page content、token。
  - 負載測試後比對 counter 變化。
- **優先級**：P1

### O-03 脱敏紅機制必須先於結構化日誌上線

- **位置**：目前無 redaction 機制；`docs/fmb-observability/sensitive-fields.md` 已有規格
- **影響**：
  - 若先上 JSON 日誌，很容易把 `page.url`、`page.title`、錯誤訊息或頁面文字記進去。
  - URL 與 title 可能包含案件線索；錯誤訊息可能帶本機路徑或頁面資訊。
- **建議修法**：
  1. 採允許清單：先定義可記欄位，其餘預設丟棄。
  2. URL 只記 `origin`／`host`，不記 query、path、fragment，除非 BOB 明確核准。
  3. title 預設不記；必要時只記長度或 hash。
  4. `token`、`cookie`、`password`、`authorization`、`x-tp-token`、`x-ego-token` 等鍵名一律替换為 `[REDACTED]`。
  5. 文件、測試、範例中的認證值只用 `FAKE_VALUE_FOR_TEST`。
- **驗證方式**：
  - `node --test` 脱敏單元測試：敏感鍵、巢狀物件、陣列、錯誤訊息都被處理。
  - 整合測試：記錄一次 fake navigation，斷言日誌中不出現完整 fake URL。
- **優先級**：P0

---

## F. 安裝與發佈可靠性

### I-01 `install.sh`／`install.ps1` 非原子安裝

- **位置**：`install.sh` → `rm -rf "$APP_DIR/bin" ...` 後才 `cp`；`install.ps1` → `Remove-Item -Recurse -Force` 後才 `Copy-Item`
- **影響**：
  - 複製途中失敗會留缺檔 runtime。
  - 執行中 daemon 可能一邊被替檔一边使用舊模組，狀態不一致。
  - 沒有保留前一版，回滾只能重裝。
- **建議修法**：
  1. staging + 原子切換：安裝到 `$APP_DIR.next`；舊版改名 `$APP_DIR.old`；`$APP_DIR.next` 改名 `$APP_DIR`；成功後延遲清除 `$APP_DIR.old`。
  2. 任何階段失敗 rollback 回 `$APP_DIR.old`。
  3. 安裝前停止 daemon／Chrome，或用版本化目錄避免覆蓋執行中檔案。
- **驗證方式**：
  - 在 `mkdtempSync(tmpdir())` 設 fake `HOME`，以本機 checkout 跑安裝，不斷言網路。
  - 模擬 `cp` 失敗，確認舊 runtime 仍存在且可執行。
- **優先級**：P1

### I-02 `install.ps1` 暫存 clone 與啟動順序

- **位置**：`install.ps1`
- **影響**：
  - `$TempClone` 只在成功路徑尾端清除，中途 `$ErrorActionPreference="Stop"` 會留暫存目錄。
  - 安裝尾端直接跑 `version`、`status`，沒先等 `/health`，容易誤判失敗。
- **建議修法**：
  1. 用 `try/finally` 確保 `$TempClone` 一定清除。
  2. 啟動後輪詢 `127.0.0.1` 的 `/health`，`chrome:true` 再跑 `version`／`status`。
  3. 失敗保留診斷日誌，但不得包含 token。
- **驗證方式**：
  - 隔離 Windows 環境以 fake daemon 驗證 health 等待。
  - 模擬安裝失敗，確認 TempClone 被清掉。
- **優先級**：P2

### I-03 `install.sh` 不會安裝 `docs/` 子目錄

- **位置**：`install.sh` → `cp "$SRC/docs/"* "$APP_DIR/docs/"`
- **影響**：
  - `cp` 未加 `-R`，遇到 `docs/fmb-perf/`、`docs/fmb-api/` 等子目錄會失敗或被 `|| true` 吞掉。
  - 本目錄與其他 docs 子目錄不會進位到 `~/.local/share/ego-linux/app/docs/`。
- **建議修法**：
  1. 改為 `cp -R "$SRC/docs/." "$APP_DIR/docs/"`。
  2. 安裝後檢查 `docs/fmb-perf/README.md` 是否存在。
  3. `tests/` 若要完整部署，也應明確規則，不要只複製 `*.mjs`。
- **驗證方式**：
  - fake `HOME` 跑 `install.sh`，斷言 `$APP_DIR/docs/fmb-perf/README.md` 存在。
- **優先級**：P2

---

## 未完成事項與後續補審

1. 未實作任何修法；本報告只提供可執行改善項目。
2. `daemon/ego-browserd.js`、`daemon/tp-browserd.js`、`daemon/page-ops.js`、`lib/sdk.js`、`daemon/inpage.agent.js`、`tools/profile-init.js`、`scripts/ego-start.ps1` 本次未提供完整內容，未做實質審查。
3. 尚未整合 `fmb_feature2/reaper.js` 進 daemon。
4. 尚未新增 `/metrics`、結構化日誌、脱敏紅機制。
5. 尚未修改安裝腳本或 systemd unit。

## 決策點

本輪採用的保守預設：

1. `Store` 結構變更立即 persist，內容更新可短延遲批次，但不牺牲原子性。
2. 單一 `DATA_DIR` 採單寫入鎖，不允許多 daemon 無鎖共用 ledger。
3. CDP 只對安全查詢重試，最多 3 次；不自動重送 `navigate`／`evaluate`／`input`。
4. CDP 重連採有限次數，重連期間 `/health` 回 `chrome:false`。
5. 脱敏紅機制未上線前，不開啟完整結構化日誌。
6. reaper 初始政策建議 `idleSpaceMs: 6h`、`maxSpaces: 500`，先觀察一週。
7. 安裝流程建議 staging + 原子切換 + 保留舊版。

## 需要 BOB 決策的事

1. 是否核准 `Store` 單寫入鎖，徹底禁止多 daemon 共用 ledger？
2. 是否核准 reaper 初始政策 `6h/500`，以及一週後是否放寬？
3. 是否核准 CDP 只重試安全查詢、有限重連？
4. 是否核准先上脱敏與 metrics，再開結構化日誌？
5. 是否核准安裝流程改為原子切換，並將遠端安裝改為固定 tag + checksum？
6. 是否要求 Windows stop 也必須先 `flush-and-close`，逾時後才 force kill？
