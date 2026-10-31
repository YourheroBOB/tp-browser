# 指標與 SLO 設計

## 1. 暴露方式（零依賴）

| 方案 | 說明 | 取捨 |
|---|---|---|
| A（建議） | daemon 內建 `GET /metrics`（僅 loopback + `x-tp-token`），回 **Prometheus text format**（純文字，0 依賴） | 與既有安全姿勢一致；生態工具（Prometheus/Grafana）直接可用 |
| B（輕量） | daemon 定期把計數快照寫成 JSON 到 data dir，由外部 scraper 讀 | 更低侵入；無即時性 |
| C（未來選用） | OTLP over HTTP 推到後端 | 違反「預設不對外傳輸」，列為 BOB 決策事項 |

本文件只做設計；實作需修改 daemon，留待後續（本輪不得修改既有檔案）。

## 2. 命名與基數規則

- 前綴 `tp_`；單位後置：`_ms`、`_bytes`、`_seconds`、`_total`。
- **label 只能是固定 enum**（`route`、`method`、`result`、`reason`、`state`、`kind`、`action`、`instance`、`version`、`binary`）。
- 禁止作為 label：URL、`space.name`、`targetId`、錯誤訊息、`trace_id`（基數爆炸 + 隱私風險）。高基數資訊放日誌，不放指標。

## 3. 指標目錄

### 3.1 Counters

| 指標 | labels | 意義 |
|---|---|---|
| `tp_http_requests_total` | `route,method,status` | HTTP 流量（固定 route enum） |
| `tp_http_rejected_total` | `reason` | 被拒請求（bad-host/origin-present/bad-token/bad-path/rate-limit） |
| `tp_auth_failures_total` | `reason` | Token 驗證失敗（timingSafeEqual 失敗路徑） |
| `tp_cdp_commands_total` | `method,result`(ok/error/timeout) | CDP 指令結果 |
| `tp_cdp_reconnects_total` | `reason` | CDP 重連次數 |
| `tp_batch_executions_total` | `result`(ok/error/timeout) | `nodejs` 批次執行結果 |
| `tp_space_created_total` | — | ledger 空間新增 |
| `tp_space_deleted_total` | `reason`(user/reaper-dead/reaper-idle/reaper-overcap) | 空間刪除歸因 |
| `tp_page_dropped_total` | `reason` | 分頁記錄丟棄 |
| `tp_store_persist_total` | `result`(ok/error) | **persist 失敗＝資料風險，進 SLO** |
| `tp_path_violations_total` | `kind` | `safePath` 阻擋（穿越/symlink） |
| `tp_inpage_marker_rejects_total` | — | `window.__egoAgent` 標記驗證失敗 |
| `tp_reaper_actions_total` | `action`(close/drop) | reaper 實際動作數 |

### 3.2 Histograms（毫秒）

| 指標 | labels | buckets |
|---|---|---|
| `tp_http_request_duration_ms` | `route` | 5,10,25,50,100,250,500,1000,2500,5000,10000,30000 |
| `tp_cdp_command_duration_ms` | `method` | 同上（排除 navigation 類） |
| `tp_batch_duration_ms` | `result` | 10,50,100,500,1000,2500,5000,15000,30000,60000 |
| `tp_navigation_duration_ms` | `waitUntil` | 100,500,1000,2500,5000,10000,30000 |
| `tp_store_persist_duration_ms` | — | 1,5,10,25,50,100,250,500,1000 |
| `tp_health_probe_duration_ms` | — | 5,10,25,50,100,250,500,1000 |

### 3.3 Gauges

| 指標 | 說明 |
|---|---|
| `tp_daemon_up{instance}` | 1/0 |
| `tp_chrome_connected{instance}` | 1/0（對應 `/health` 的 `chrome`） |
| `tp_daemon_uptime_seconds{instance}` | |
| `tp_ledger_spaces{state}` | state ∈ `live/dead/unbound/mixed/empty`，資料直接來自 reaper `classifySpace` 統計 |
| `tp_ledger_pages{state}` | 同上 |
| `tp_live_targets` | Chrome 端活躍 page target 數 |
| `tp_store_bytes` | ledger 檔體積（成長趨勢） |
| `tp_ws_pending` | CDP pending request 數（壅塞指示） |
| `tp_reaper_last_run_ts_seconds` | 最後一次 reaper 成功執行的時間戳（未整合時不存在） |
| `tp_reaper_last_plan_close_total` / `tp_reaper_last_plan_drop_total` | 最後一次計畫的動作數（含 0） |

## 4. SLO 表

單機本地工具的「使用者」就是本機擁有者，SLO 以「不阻斷工作流」為核心。數值為**保守起始建議**，留給 BOB 調整。

| # | SLO | 目標 | 視窗 | 量測方式 | 錯誤預算 | 理由 |
|---|---|---|---|---|---|---|
| S1 | 可用性（`/health` + RPC 成功率） | ≥ 99.5% | 7d | `1 - errors/requests` | ≈ 50 min/週 | daemon 掛掉 = 完全阻斷；排除使用者主動 `tp-stop` 時段 |
| S2 | 批次執行成功率 | ≥ 99% | 7d | `ok/(ok+error)`（timeout 另計） | ≈ 10 次/週（依量） | agent 工作流主路徑 |
| S3 | 批次延遲 | p95 ≤ 5000ms；p99 ≤ 15000ms | 7d | 直方圖分位 | 5% 請求可超 p95 | 腳本複雜度差異大，用分位不用平均 |
| S4 | CDP 指令延遲 | p95 ≤ 250ms（排除 navigation） | 7d | 直方圖分位 | 5% | 基礎操作必須快 |
| S5 | 恢復力 | chrome detach → reattach p95 ≤ 30s | 7d | attach 事件時間差 | — | 使用者重返工作流的等待上限 |
| S6 | 持久性 | `store.persist` 成功率 = 100% | 30d | counter | 0 | ledger 是唯一任務軌跡，遺失不可逆 |
| S7 | 衛生（reaper 整合後） | `tp_ledger_spaces` ≤ 50 的時間占比 ≥ 95% | 持續 | gauge | 5% 時間 | 對應 reaper `maxSpaces` 預設 |
| S8 | 資安基線 | auth failure 速率不偏離 7d 基線 | 持續 | counter | 見 alerts | 異常 = 憑證錯置或本地掃描 |

**Burn rate（選用）**：1h/14.4x、6h/6x 雙視窗（Google SRE 慣例）。本地工具可先用單視窗（30m）簡化，見 `alerts.md`。

## 5. 與 reaper 的對接（零 schema 變更）

- `tp_ledger_spaces{state}` / `tp_ledger_pages{state}` 可由 `planReap`／`classifySpace` 的既有回傳統計直接產生（`stats.live`、`stats.closed`、分類 kind）。
- `tp_reaper_last_plan_*` 讓「安全閥 `no-live-targets` 卡住」變成可觀測：若 gauge 存在但 `close+drop` 長期為 0 且日誌持續出現 `reason:'no-live-targets'`，代表 Chrome `/json/list` 不可達或 live 集合解析錯誤（見 `alerts.md` 的 `TpReaperStale`／`TpLedgerOverCap`）。

## 6. 隱私檢查（指標層）

- 所有 label 已限制為固定 enum；`space.name`、URL、`targetId`、頁面內容**永不進入 label 或指標值**。
- histogram bucket 邊界不含任何業務語意。
- `/metrics` 需 token：它本身會暴露行為模式（何時工作、何時閒置），等同中敏感度資料。
