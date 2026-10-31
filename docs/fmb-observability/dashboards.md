# 儀表板版面設計

## 1. 資料來源

| 用途 | 來源 | 備註 |
|---|---|---|
| 主要 | Prometheus scrape `http://127.0.0.1:9772/metrics`（帶 token）+ Grafana | 生態完整；Grafana 本身也須綁 loopback + 認證 |
| 輕量替代 | 定期 JSON 快照 + 內部靜態 HTML | 零依賴；互動性差，列為 BOB 決策事項 |
| 日誌 | Loki，或直接 `tail logs/*.jsonl` | 日誌面板輸出同樣必須經過紅機制 |

## 2. 版面 Wireframe

```text
┌─ Row 1  Overview ─────────────────────────────────────────────────────┐
│ Daemon Up │ Chrome Connected │ Uptime │ Version/Instance │ Last Reaper │
├─ Row 2  Golden Signals (HTTP) ────────────────────────────────────────┤
│ QPS by route │ Error ratio │ p50/p95/p99 latency │ Pending WS / Heap  │
├─ Row 3  TaskSpace / Ledger ───────────────────────────────────────────┤
│ Spaces by state │ Pages │ Ledger bytes │ create/delete rate │ reaper  │
├─ Row 4  Browser / CDP ────────────────────────────────────────────────┤
│ cmd rate by method │ err ratio │ latency heatmap │ attach timeline    │
├─ Row 5  Batch JS ─────────────────────────────────────────────────────┤
│ exec by result │ duration p50/p95/p99 │ script/result bytes           │
├─ Row 6  Security ─────────────────────────────────────────────────────┤
│ auth failures by reason │ rejects by reason │ path violations         │
├─ Row 7  SLO / Error Budget ───────────────────────────────────────────┤
│ per-SLO attainment │ burn rate │ budget remaining                    │
├─ Row 8  Logs (warn/error only) ───────────────────────────────────────┤
│ event │ component │ trace_id │ msg(截斷，已紅機制)                      │
└───────────────────────────────────────────────────────────────────────┘
```

## 3. Panel 規格表

| Row | Panel | Viz | Query（PromQL） | 註 |
|---|---|---|---|---|
| R1 | Daemon Up | stat | `tp_daemon_up{instance="$instance"}` | 0 → 紅 |
| R1 | Chrome Connected | stat | `tp_chrome_connected{instance="$instance"}` | |
| R1 | Uptime | stat | `tp_daemon_uptime_seconds{instance="$instance"}` | |
| R1 | Version/Instance | text | `tp_daemon_up{instance="$instance"}` by (version, binary) | 偏斜時一眼可見 |
| R1 | Last Reaper | stat | `time() - tp_reaper_last_run_ts_seconds` | 未整合時顯示 No data |
| R2 | QPS by route | timeseries | `sum(rate(tp_http_requests_total{instance="$instance"}[5m])) by (route)` | |
| R2 | Error ratio | timeseries | `sum(rate(tp_http_requests_total{instance="$instance",status=~"5.."}[5m])) / sum(rate(tp_http_requests_total{instance="$instance"}[5m]))` | |
| R2 | Latency p50/p95/p99 | timeseries | `histogram_quantile(0.5\|0.95\|0.99, sum(rate(tp_http_request_duration_ms_bucket{instance="$instance"}[5m])) by (le,route))` | |
| R2 | Saturation | timeseries | `tp_ws_pending{instance="$instance"}` | heap 需 process exporter（選用） |
| R3 | Spaces by state | bargauge | `sum(tp_ledger_spaces{instance="$instance"}) by (state)` | 資料語意來自 reaper classifier |
| R3 | Pages / Ledger bytes | stat+timeseries | `sum(tp_ledger_pages)`、`tp_store_bytes` | bytes 成長趨勢 |
| R3 | create/delete rate | timeseries | `sum(rate(tp_space_created_total[1h]))`、`sum(rate(tp_space_deleted_total[1h])) by (reason)` | |
| R3 | Reaper actions | timeseries | `sum(rate(tp_reaper_actions_total[1h])) by (action)` | |
| R4 | CDP cmd rate | timeseries | `sum(rate(tp_cdp_commands_total{instance="$instance"}[5m])) by (method,result)` | |
| R4 | CDP err ratio | timeseries | error/total | |
| R4 | CDP latency heatmap | heatmap | `tp_cdp_command_duration_ms_bucket` | |
| R4 | Attach timeline | state timeline | `tp_chrome_connected{instance="$instance"}` | 對應 S5 |
| R5 | Batch by result | timeseries | `sum(rate(tp_batch_executions_total{instance="$instance"}[5m])) by (result)` | |
| R5 | Batch duration | timeseries | `histogram_quantile(0.5\|0.95\|0.99, ...)` | 門檻線畫 S3 |
| R6 | Auth failures | timeseries | `sum(rate(tp_auth_failures_total{instance="$instance"}[5m])) by (reason)` | |
| R6 | Rejects / violations | timeseries | `sum(rate(tp_http_rejected_total[5m])) by (reason)`、`increase(tp_path_violations_total[1h])` | |
| R7 | SLO attainment | stat/gauge | S1–S7 各自比率（見 `metrics-and-slo.md`） | 加上目標門檻線 |
| R7 | Burn rate | stat | `rate(errors[1h]) / (1-target)/window` | 簡化版單視窗 |
| R8 | Logs | logs | `{instance="$instance"} \| json \| level=~"warn\|error"` | 顯示 `event`、`component`、`trace_id`；`msg` 截斷 80 字元 |

## 4. 變數與重新整理

- 變數：`$instance`（`daemon:9772`／`daemon:9774`）、`$version`、時間範圍；logs panel 另加 `$level`。
- 重新整理：30s（本地工具足夠頻繁）。
- 時區：UTC（與 `ts` 欄位一致，避免跨機關聯時換算錯誤）。

## 5. Grafana JSON 骨架（最小可匯入）

```json
{
  "title": "tp-browser Observability",
  "uid": "tp-browser-obs",
  "tags": ["tp-browser", "fmb-observability"],
  "timezone": "utc",
  "refresh": "30s",
  "templating": {
    "list": [
      {
        "name": "instance",
        "type": "custom",
        "query": "daemon:9772,daemon:9774",
        "current": { "text": "daemon:9772", "value": "daemon:9772" }
      }
    ]
  },
  "panels": [
    {
      "id": 1, "type": "stat", "title": "Daemon Up",
      "gridPos": { "h": 4, "w": 6, "x": 0, "y": 0 },
      "targets": [{ "expr": "tp_daemon_up{instance=\"$instance\"}", "legendFormat": "up" }]
    },
    {
      "id": 2, "type": "stat", "title": "Chrome Connected",
      "gridPos": { "h": 4, "w": 6, "x": 6, "y": 0 },
      "targets": [{ "expr": "tp_chrome_connected{instance=\"$instance\"}" }]
    },
    {
      "id": 3, "type": "stat", "title": "Ledger Spaces (total)",
      "gridPos": { "h": 4, "w": 6, "x": 12, "y": 0 },
      "targets": [{ "expr": "sum(tp_ledger_spaces{instance=\"$instance\"}) by (state)", "legendFormat": "{{state}}" }]
    },
    {
      "id": 4, "type": "stat", "title": "Batch Error Rate",
      "gridPos": { "h": 4, "w": 6, "x": 18, "y": 0 },
      "targets": [{
        "expr": "sum(rate(tp_batch_executions_total{instance=\"$instance\",result=\"error\"}[30m])) / sum(rate(tp_batch_executions_total{instance=\"$instance\"}[30m]))"
      }]
    },
    {
      "id": 5, "type": "timeseries", "title": "HTTP QPS by route",
      "gridPos": { "h": 8, "w": 12, "x": 0, "y": 4 },
      "targets": [{ "expr": "sum(rate(tp_http_requests_total{instance=\"$instance\"}[5m])) by (route)", "legendFormat": "{{route}}" }]
    },
    {
      "id": 6, "type": "timeseries", "title": "CDP latency p95 (ms)",
      "gridPos": { "h": 8, "w": 12, "x": 12, "y": 4 },
      "targets": [{
        "expr": "histogram_quantile(0.95, sum(rate(tp_cdp_command_duration_ms_bucket{instance=\"$instance\"}[5m])) by (le, method))",
        "legendFormat": "{{method}}"
      }]
    }
  ]
}
```

## 6. 注意事項

- **儀表板常被截圖分享**：所有 panel 同樣禁止出現敏感內容（URL、`space.name`、頁面內容摘要、錯誤訊息原文）。R8 logs panel 的 `msg` 必須已紅機制。
- Grafana／Prometheus 若部署在本機，沿用既有安全姿勢：loopback 綁定 + token；不得對外暴露。
- `tp_ledger_*` 系列在 reaper 整合前會是 No data，屬預期；面板不需隱藏，便於驗證整合是否生效。
