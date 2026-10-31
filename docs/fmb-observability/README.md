# tp-browser 可觀測性設計（fmb-observability）

- **性質**：設計文件（docs-only）。本輪**只新增 Markdown 文件**，未修改任何程式碼、未改任何設定。
- **範圍**：`daemon/*`（ego-browserd / tp-browserd）、`bin/*`（CLI）、`lib/sdk.js`、`daemon/cdp.js`、`daemon/store.js`、`daemon/page-ops.js`、`daemon/inpage.agent.js`、`tools/profile-init.js`、`scripts/*` 啟動／停止腳本、`fmb_feature2/reaper.js`（尚未整合）。
- **命名慣例**：指標前綴統一 `tp_`；`ego-*` 為相容別名，遙測上以 `binary` 欄位區分，不兩套命名。

## 文件地圖

| 文件 | 內容 |
|---|---|
| `inventory.md` | 現況盤點：現有日誌、指標、錯誤回報、健康檢查，以及缺口清單 |
| `events-and-fields.md` | 結構化日誌規格：關鍵事件目錄、通用欄位、關聯 ID、層級與範例 |
| `metrics-and-slo.md` | 指標目錄（counter/histogram/gauge）與 SLO／錯誤預算設計 |
| `alerts.md` | 告警條件、分級、路由與最小可行實作路徑 |
| `dashboards.md` | 儀表板版面（wireframe、panel 規格、Grafana JSON 骨架） |
| `sensitive-fields.md` | 日誌／指標／告警中**禁止出現**的敏感欄位清單與紅機制規格 |

## 設計原則

1. **本地優先（local-first）**：所有遙測資料預駐留在 `~/.local/share/ego-linux/`，預設不對外傳輸。
2. **零依賴相容**：本專案標榜 0 npm 依賴；遙測實作不得引入套件。指標採用 Prometheus text format（純文字）或 JSON 快照。
3. **隱私優先**：採「允許清單（allowlist）」思維——先定義什麼可以記，其餘預設丟棄。頁面內容、Cookie、Token、案件相關資料一律不記。
4. **可漸進採用**：Phase 1 結構化日誌 + 紅機制 → Phase 2 `/metrics` 與儀表板 → Phase 3 告警與 SLO 自動化。每階段都可獨立上線、可回退。
5. **決定與執行分離**：與 `fmb_feature2/reaper.js` 相同的保守哲學——先「可觀測」，再談自動化；任何自動動作前先有乾跑與統計。

## 現況一句話

目前只有 `console.*` 日誌（無時間戳、無層級、無結構）＋ 被啟動腳本重定向到 `logs/daemon.log`、`logs/chrome.log` 的附掛內容 ＋ 一個只回 `{"ok":true,"chrome":true}` 的 `/health`。**沒有任何指標、錯誤聚合、SLO、告警、儀表板**。詳見 `inventory.md`。

## 交付後的自動生效範圍

`install.sh` 以 `cp "$SRC/docs/"*` 整包複製 docs，因此本目錄會隨安裝器一起進位到 `~/.local/share/ego-linux/app/docs/`，無需額外修改安裝腳本。
