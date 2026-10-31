# 告警條件

## 1. 分級與路由

| 分級 | 定義 | 回應 |
|---|---|---|
| P1 Critical | 功能阻斷或資料有風險 | 立即處理 |
| P2 Warning | 品質下降或趨勢異常 | 當日處理 |
| P3 Info | 狀態通知／預期行為確認 | 週檢視 |

**路由（保守預設）**：寫入 `~/.local/share/ego-linux/alerts/alerts.jsonl` + 本機桌面通知（若可用）。**預設不對外发送**（隱私優先）。是否增加 webhook 列為 BOB 決策事項。

**靜默**：daemon restart 後 5 分鐘內抑制同 instance 的重複告警。

## 2. 規則表（條件以 PromQL 表達；無 Prometheus 時的等價寫法見 §3）

| ID | 條件 | 持續 | 分級 | 意義 | Runbook |
|---|---|---|---|---|---|
| `TpDaemonDown` | `tp_daemon_up{instance=~".+"} == 0` 或 health probe 連續失敗 ≥2 | 1m | P1 | daemon 崩潰／未啟動 | `tail logs/daemon.log`；`tp-start` 重啟；確認 9772/9774 與防火牆 |
| `TpChromeDisconnected` | `tp_chrome_connected == 0` 且 `tp_daemon_up == 1` | 5m | P1 | 瀏覽器程序死亡 | 看 `logs/chrome.log`；`tp-start`／`tp-headed` 重啟；清除 `SingletonLock` |
| `TpStorePersistError` | `increase(tp_store_persist_total{result="error"}[10m]) >= 1` | 10m | P1 | ledger 寫入失敗（磁碟／權限） | 檢查磁碟空間與 data dir 權限（0700/0600）；立即備份 ledger JSON |
| `TpAuthFailureSpike` | `rate(tp_auth_failures_total[5m]) > 0.5` | 10m | P1 | 憑證錯置或本地掃描 | 確認來源僅 127.0.0.1；核對 CLI 與 daemon 版本一致 |
| `TpBatchErrorRate` | `rate(tp_batch_executions_total{result="error"}[30m]) / rate(tp_batch_executions_total[30m]) > 0.01` | 30m | P2 | agent 工作流失敗變多 | 抽 `trace_id` 看 `errorClass`；確認 Chrome 健康與目標站狀態 |
| `TpBatchLatencyP99` | `histogram_quantile(0.99, tp_batch_duration_ms_bucket) > 30000` | 30m | P2 | 頁面變重或 CDP 壅塞 | 看 `tp_navigation_duration_ms`；減少並發分頁；必要時 `tp-headed` 人工介入 |
| `TpCdpErrorRate` | `rate(tp_cdp_commands_total{result="error"}[15m]) / rate(tp_cdp_commands_total[15m]) > 0.05` | 15m | P2 | CDP 層異常 | 看重試與 `cdp.disconnect`；確認 Chrome 版本相容 |
| `TpLedgerOverCap` | `sum(tp_ledger_spaces) > 50` | 1h | P2 | reaper 未整合或安全閥卡住 | 若日誌持續 `reason:"no-live-targets"`：確認 Chrome `/json/list` 可達、live 集合解析正確 |
| `TpReaperStale` | `time() - tp_reaper_last_run_ts_seconds > 21600`（reaper 整合後） | 6h | P2 | 回收器沒在跑 | 檢查計時器與例外；先手動乾跑 `fmb_feature2/cli.js` |
| `TpLogVolumeSpike` | 日誌行數 > 7d 基線 ×10 | 15m | P2 | crash loop 或迴圈重試 | 聚集 `level=error` 的 `event`；對照 restart 時間 |
| `TpPathViolation` | `increase(tp_path_violations_total[1h]) >= 1` | 1h | P2 | agent 腳本嘗試逃逸 `safePath` | 保守不升級 P1；記 `trace_id`，人工審脚本內容 |
| `TpInstanceAmbiguity` | `tp_daemon_up{instance="daemon:9772"} == 1 and tp_daemon_up{instance="daemon:9774"} == 1` | 15m | P3 | 雙軌並存（WSL2/Windows 為預期行為） | 確認是否符合預期；否則停掉多餘 instance |
| `TpVersionSkew` | 同期間 `version` label 出現多值 | 30m | P3 | tp/ego 雙軌版本不一致 | 以 `tp-browser` 版本為準重新安裝同步 |
| `TpReaperSafetyValve` | `reason:"no-live-targets"` 的 `reaper.plan` 連續出現 ≥12 次且 `tp_live_targets == 0` | 1h | P2 | 安全閥長期咬住（Chrome 從未接上） | 檢查 Chrome 啟動與 CDP 埠；必要時以 `reapIdleWhenNoLiveTargets:true` 顯式離線整理（BOB 決策） |

## 3. 無 Prometheus 的最小可行版

一個本地腳本（未來新增，非本輪）每 60s：`curl -s -H 'x-tp-token: …' http://127.0.0.1:9772/metrics` → 以字串比對執行上表條件 → 命中即追加 `alerts.jsonl`。

優先實作順序：`TpDaemonDown` → `TpChromeDisconnected` → `TpStorePersistError` → `TpAuthFailureSpike` → `TpLedgerOverCap`。

## 4. 告警訊息規範（紅機制）

- 只允許攜帶：`alert`、`severity`、`instance`、`value`、`ts`、`hint`（固定文案）。
- **不得攜帶**：URL、`space.name`、錯誤訊息原文、頁面內容、任何 Denylist 值（見 `sensitive-fields.md`）。
- 範例：

```json
{"alert":"TpStorePersistError","severity":"P1","instance":"daemon:9772","value":1,"ts":"2026-01-01T00:10:00.000Z","hint":"check disk space and data dir permissions"}
{"alert":"TpLedgerOverCap","severity":"P2","instance":"daemon:9772","value":63,"ts":"2026-01-01T01:00:00.000Z","hint":"reaper not integrated or no-live-targets safety valve engaged"}
```
