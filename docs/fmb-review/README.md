# tp-browser 程式碼審查報告（fmb-review）

> **文件狀態**：審查報告（docs-only）。本輪**只新增 `docs/fmb-review/` 下的 Markdown**，未修改任何程式碼、設定、`.github/workflows`、secrets 或 git remote。
> **審查基準**：本次任務提供的預設分支內容快照。**未連線**正式服務、registry、瀏覽器或任何遠端主機。
> **安全邊界**：本報告不含任何實際 token、金鑰、密碼、客戶個資、LINE 訊息內文或案件當事人資料；示例值一律使用 `FAKE_VALUE_FOR_TEST` 這類明顯假字串。

## 1. 審查範圍與方法

- **方法**：靜態閱讀（static review）。以資深審查者角度檢查正確性、併發、錯誤處理、可讀性、可測試性與相依風險；能引用的問題一律給出 `檔案:行號`、嚴重度、說明與建議修法程式片段。
- **限制**：審查者**看不到即時檔案系統**，只能根據本次提供的檔案內容作答。未提供內容的模組（見 [`02-coverage.md`](./02-coverage.md)）列為「未審」，不對其行號或行為臆測問題。
- **行號慣例**：行號以本報告所引用的「本次提供內容」計；若與實際 repo 有偏移，請以該行附近的程式片段為準。

## 2. 嚴重度定義

| 嚴重度 | 意義 | 處置建議 |
|---|---|---|
| **高** | 可能造成資料遺失、狀態不一致、安全邊界失效或對外承諾跳票 | 排入最近一次修補，補測試 |
| **中** | 特定情境會故障、難以維護或擴大爆炸半徑 | 排入 1–2 個 sprint，附重現或觀測 |
| **低** | 一致性、可讀性或跨平台小瑕疵 | 合併於相鄰改動一併修 |

## 3. 結果摘要

- 詳細問題清單與建議修法片段見 [`01-findings.md`](./01-findings.md)。
- 逐檔審查涵蓋範圍見 [`02-coverage.md`](./02-coverage.md)。
- 前十大修補建議與工作量估計見本檔第 5 節。

| 類別 | 問題數（約） | 重點 |
|---|---:|---|
| 正確性 | 8 | `Store` 載入/刪除語意、文件宣稱與程式不一致、跨平台按鍵 |
| 併發 | 5 | ledger 跨程序寫入競爭、`tp-start` 重入、`Cdp` pending 生命週期 |
| 錯誤處理 | 8 | `persist()` fallback、`spawn_detached` 吞錯、CLI 輸入驗證 |
| 可讀性 | 4 | 重複方法、靜默 no-op、命名與單一職責 |
| 可測試性 | 4 | 回傳內部參照、未檢視模組缺乏合成測試、版本漂移影響驗收 |
| 相依風險 | 6 | 安裝器抓浮動預設分支、非原子安裝、Node 版本契約不一 |
| 資安（附加） | 3 | root 跑 Chrome、token 權限時間窗、技能檔覆寫 |

## 4. 一句話結論

`daemon/store.js` 的持久化與併發語意、以及安裝／啟動腳本的供應鏈與失敗處理，是本輪最值得先修的三塊；`fmb_feature2/reaper.js` 已具備「決定與執行分離」的良好基礎，整合前必須先補 `Store` 的形狀驗證、`labelSeq` 清理與跨程序鎖，否則自動回收可能放大資料競爭。

## 5. 前十大修補建議與工作量估計

> 工作量以「熟悉本 codebase（約 2,000 行純 ESM、零 npm 相依）的單一工程師」為基準，單位人日（pd）。風險分低／中／高。

| # | 修補項目 | 對應問題 | 工作量 | 風險 | 主要風險與緩解 |
|---|---|---|---:|---|---|
| 1 | `Store.load()` 形狀驗證＋預設 merge；`deleteSpace()` 一併清 `labelSeq`；`list()` 回傳副本；整併 `bindPage/addPage` | F-01、F-02、F-03、F-06、F-07 | 0.5–1 pd | 低 | 改寫既有「現況測試」為期望行為；合法 ledger 不受影響 |
| 2 | `Store.persist()` 移除非原子 fallback，明確定義失敗語意；導入跨程序鎖或單一寫入者契約 | F-04、F-05 | 1–2 pd | 中 | 舊檔 rename 跨裝置情境需保留復原路徑；多 daemon 共用 ledger 需重新設計或加鎖 |
| 3 | 將 `fmb_feature2/reaper.js` 以低頻計時器整合進 daemon；維持「live 集合為空→不動作」安全閥；先只觀察 `stats` | F-08 | 1–2 pd | 低 | 需在第 1、2 項之後；預設保守 policy 一週後再放寬 |
| 4 | 補齊 README 宣稱的 `tools/cookies-export.ego.js`／`tools/cookies-import.ego.js`，或修正 README | F-30 | 0.5 pd（只修文件）/ 3–5 pd（含加密實作） | 中（實作）/ 低（文件） | 若實作：預設 `0600`、跨機預設加密、測試只用假 cookie＋`tmpdir()` |
| 5 | 安裝器供應鏈硬化：固定 tag／commit＋checksum、版本化目錄原子安裝、Node 版本閘、複製完整 `tests/` | F-18、F-19、F-20、F-22、F-28 | 1–2 pd | 中 | 遠端一鍵安裝是主要供應鏈面；改動需保留本機 clone 安裝路徑 |
| 6 | `tp-start.sh` 可靠性與安全：token 即時 `0600`、root 處理、spawn 錯誤可見、啟動失敗清理、`flock` 防重入 | F-23、F-24、F-25、F-26、F-27 | 1–2 pd | 中 | root 拒絕可能影響現有 WSL2 用法，需環境變數覆寫與 BOB 決策 |
| 7 | `daemon/cdp.js` 生命週期：close 時一併清理 pending timer、`once()` 於斷線 reject、`send()` race 防護 | F-09、F-10、F-11 | 0.5 pd | 低 | 補 `tests/test_fmb_cdp.test.mjs` 斷線／逾時案例 |
| 8 | `daemon/keys.js` 跨平台語意：`ControlOrMeta` 依 `process.platform` 解析、單字元大寫補 Shift、標點補 `code` | F-13、F-14、F-15 | 0.5 pd | 低 | 需確認上層 dispatch 端一併處理 modifier bit |
| 9 | 版本號單一來源（`package.json` `0.3.0` vs CLI `0.3.1`）與發佈一致性閘 | F-29 | 0.5 pd | 低 | 需協調第一個 `vX.Y.Z` tag 時點 |
| 10 | 補齊未審模組的審查與合成測試：daemon HTTP 層、`page-ops.js`、`lib/sdk.js`、`inpage.agent.js`、`bin/*`、`tools/profile-init.js`、`tests/*` | F-31 | 2–3 pd | 中 | 先補畸形輸入、斷線、逾時、symlink、併發等合成測試，再接真實 Chrome E2E |

**合計**：約 8.5–15.5 pd（依第 4、5 項是否含加密實作與第 10 項測試深度而顯著變動）。

## 6. 明確排除（本輪不做）

- 不修改任何既有檔案；不改 `.github/workflows`、secrets、git remote；不 push／merge／刪分支。
- 不新增任何 npm runtime／dev dependency。
- 不連線正式服務；測試設計僅使用 repo 內本機伺服器與 `os.tmpdir()` 類型暫存目錄。

## 7. 需要 BOB 決策的事

1. 第 4 項：Cookie 工具「直接實作（建議預設加密）」還是「先修正 README、工具另案排期」？
2. 第 3 項：reaper 上線 policy 初值（本報告建議 `idleSpaceMs: 6h`、`maxSpaces: 500` 先觀察一週）。
3. 第 6 項：是否允許 root 下以 `--no-sandbox` 啟動 Chrome（建議預設拒絕，`TP_ALLOW_ROOT=1` 覆寫）？
4. 第 5 項：遠端一鍵安裝是否改為固定 tag＋checksum，並何時為 0.3.x 凍結版本並打第一個 tag？
5. 未審模組（daemon HTTP 資安邊界、`page-ops.js` 路徑防護、`inpage.agent.js` 信任邊界）是否列為正式支援前的必要審查項目？
