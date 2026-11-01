# tp-browser 逐檔審查涵蓋範圍（fmb-review）

> 本表標示每檔在本次審查中的可達性。**「未審」不代表沒問題**，而是本次未提供檔案內容，避免對未見程式碼臆測行號與行為。  
> 「已審（程式）」＝本次提供內容並給出問題或確認無顯著問題；「已檢視（文件）」＝僅就文件一致性檢視。

| 檔案 | 類型 | 狀態 | 備註 |
|---|---|---|---|
| `.gitignore` | 設定 | 已檢視 | 未見異常；未涵蓋敏感檔規則（可考慮加 `*.tmp`、`*.lock`） |
| `LICENSE` | 法務 | 已檢視 | Apache-2.0 條文，無審查標的 |
| `NOTICE` | 法務 | 已檢視 | 歸屬與致敬聲明；無審查標的 |
| `README.md` | 文件 | 已檢視 | F-20、F-29、F-30：宣稱工具不存在、Node 契約不一、安裝後冒煙路徑不完整 |
| `STATE.md` | 文件 | 已檢視 | 未複製其中任何連結或主機名至本報告 |
| `bin/ego-browser.js` | 程式 | **未審** | 本次未提供內容 |
| `bin/tp-browser.js` | 程式 | **未審** | 本次未提供內容 |
| `daemon/cdp.js` | 程式 | 已審 | F-09、F-10、F-11 |
| `daemon/ego-browserd.js` | 程式 | **未審** | 本次未提供內容；Host/Origin/token 驗證待補測（F-31） |
| `daemon/inpage.agent.js` | 程式 | **未審** | 本次未提供內容；`window.__egoAgent` 信任邊界待補測（F-31） |
| `daemon/keys.js` | 程式 | 已審 | F-13、F-14、F-15 |
| `daemon/page-ops.js` | 程式 | **未審** | 本次未提供內容；`safePath`/UA 偽裝待補測（F-31） |
| `daemon/store.js` | 程式 | 已審 | F-01～F-08 |
| `daemon/tp-browserd.js` | 程式 | **未審** | 本次未提供內容 |
| `docs/TP_WIN_AB_ACCEPTANCE_REPORT_1151018.md` | 文件 | **未審** | 本次未提供內容 |
| `docs/fmb-api/README.md` | 文件 | 已檢視 | 與 F-29 版本漂移互相印證；文件示例已採假值原則 |
| `docs/fmb-api/cli.md` | 文件 | **未審** | 本次未提供內容 |
| `docs/fmb-api/http-api.md` | 文件 | **未審** | 本次未提供內容 |
| `docs/fmb-api/sdk.md` | 文件 | **未審** | 本次未提供內容 |
| `docs/fmb-ci/01-lint-and-style.md` | 文件 | **未審** | 本次未提供內容 |
| `docs/fmb-ci/02-type-check.md` | 文件 | **未審** | 本次未提供內容 |
| `docs/fmb-ci/03-tests-and-coverage.md` | 文件 | **未審** | 本次未提供內容 |
| `docs/fmb-ci/04-security-scans.md` | 文件 | **未審** | 本次未提供內容 |
| `docs/fmb-ci/05-build-and-release.md` | 文件 | **未審** | 本次未提供內容 |
| `docs/fmb-ci/README.md` | 文件 | 已檢視 | 與 F-18、F-29 供應鏈/版本議題一致 |
| `docs/fmb-observability/README.md` | 文件 | 已檢視 | 設計文件；無程式碼審查標的 |
| `docs/fmb-observability/alerts.md` | 文件 | **未審** | 本次未提供內容 |
| `docs/fmb-observability/dashboards.md` | 文件 | **未審** | 本次未提供內容 |
| `docs/fmb-observability/events-and-fields.md` | 文件 | **未審** | 本次未提供內容 |
| `docs/fmb-observability/inventory.md` | 文件 | **未審** | 本次未提供內容 |
| `docs/fmb-observability/metrics-and-slo.md` | 文件 | **未審** | 本次未提供內容 |
| `docs/fmb-observability/sensitive-fields.md` | 文件 | **未審** | 本次未提供內容 |
| `docs/fmb-security/AUDIT.md` | 文件 | **未審** | 本次未提供內容 |
| `docs/fmb-security/CHECKLIST.md` | 文件 | 已檢視 | 自述「未驗證」項目與本報告 F-31 一致 |
| `docs/fmb-upgrade/01-inventory.md` | 文件 | **未審** | 本次未提供內容 |
| `docs/fmb-upgrade/02-risk-register.md` | 文件 | **未審** | 本次未提供內容 |
| `docs/fmb-upgrade/04-validation-and-rollback-runbook.md` | 文件 | **未審** | 本次未提供內容 |
| `docs/fmb-upgrade/README.md` | 文件 | 已檢視 | 與 F-22、F-29 Node 契約議題一致 |
| `docs/fmb/ARCHITECTURE.md` | 文件 | 已檢視 | 「已知落差」與 F-01、F-30 對應 |
| `docs/fmb/ROADMAP.md` | 文件 | 已檢視 | 前十大建議與其排序互相參照 |
| `docs/fmb/RUNBOOK.md` | 文件 | **未審** | 本次未提供內容 |
| `docs/index.html` | 文件 | **未審** | 本次未提供內容 |
| `docs/tp_win_ab_benchmark_results_1151018.json` | 資料 | **未審** | 本次未提供內容 |
| `fmb_feature2/README.md` | 文件 | 已檢視 | 回收器設計文件；F-08 與其「已知限制」呼應 |
| `fmb_feature2/cli.js` | 程式 | 已審 | F-16、F-17 |
| `fmb_feature2/cli.test.js` | 測試 | **未審** | 本次未提供內容 |
| `fmb_feature2/reaper.js` | 程式 | **未審** | 本次未提供內容；建議補 `lastUsedAt` 後一併回歸測試 |
| `fmb_feature2/reaper.test.js` | 測試 | **未審** | 本次未提供內容 |
| `fmb_feature2/store-integration.test.js` | 測試 | **未審** | 本次未提供內容 |
| `install.cmd` | 腳本 | 已審 | 僅轉呼 `install.ps1`；無獨立問題 |
| `install.ps1` | 腳本 | 已審 | F-28 |
| `install.sh` | 腳本 | 已審 | F-18～F-22 |
| `lib/sdk.js` | 程式 | **未審** | 本次未提供內容；RPC/`safePath` 行為待補測（F-31） |
| `package.json` | 設定 | 已審 | F-29 |
| `scripts/ego-linux-browserd.service` | 設定 | 已審 | `Restart=on-failure` 可接受；未涵蓋 hardening（`NoNewPrivileges` 等） |
| `scripts/ego-linux-chrome.service` | 設定 | 已審 | 固定 `/usr/bin/chromium`，未用 `TP_BROWSER_BIN`；root/systemd 情境需確認 |
| `scripts/ego-start.ps1` | 腳本 | **未審** | 本次未提供內容 |
| `scripts/ego-stop.ps1` | 腳本 | 已審 | 以命令列比對終止；範圍合理，但誤殺風險取決於比對字串 |
| `scripts/tp-start.sh` | 腳本 | 已審 | F-23～F-27 |
| `scripts/tp-stop.sh` | 腳本 | 已審 | `flush-and-close` 後 `pkill`；可接受，`sleep 1.0` 為經驗值 |
| `skills/tp-browser/SKILL.md` | 文件 | **未審** | 本次未提供內容 |
| `tests/bench/bench-run.ego.js` | 測試 | **未審** | 本次未提供內容 |
| `tests/bench/bench-server.mjs` | 測試 | **未審** | 本次未提供內容 |
| `tests/fmb_integration_cli.test.mjs` | 測試 | **未審** | 本次未提供內容 |
| `tests/serve.mjs` | 測試 | **未審** | 本次未提供內容 |
| `tests/smoke.ego.js` | 測試 | **未審** | 本次未提供內容；README/ROADMAP 提及硬編 `/tmp`（另案） |
| `tests/test_fmb_cdp.test.mjs` | 測試 | **未審** | 本次未提供內容 |
| `tests/test_fmb_keys.test.mjs` | 測試 | **未審** | 本次未提供內容 |
| `tests/test_fmb_profile_init.test.mjs` | 測試 | **未審** | 本次未提供內容 |
| `tests/test_fmb_store.test.mjs` | 測試 | **未審** | 本次未提供內容；已文件化 `Store.load()` 形狀缺口 |
| `tests/testpage.html` | 測試 | **未審** | 本次未提供內容 |
| `tools/profile-init.js` | 程式 | **未審** | 本次未提供內容；Cookie/登入資料匯入行為待補測（F-31） |

## 未完成事項（對應本報告）

1. 上表標記 **未審** 的程式／測試檔，需取得內容後補做逐檔審查（對應前十大第 10 項）。
2. `daemon/store.js` 的跨程序鎖方案需 BOB 確認「單一寫入者」或「加鎖」取向後再實作。
3. Cookie 工具屬「實作」或「先修 README」需 BOB 決策後排期。
