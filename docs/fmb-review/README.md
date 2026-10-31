# tp-browser 程式碼審查報告（索引）

- **審查對象**：`YourheroBOB/tp-browser`（審查基準：審查包提供的檔案內容；`package.json` 宣告 `0.3.0`，CLI 自報 `0.3.1`）
- **審查方式**：純靜態逐檔閱讀，不連線任何服務、不執行安裝腳本、不讀寫 repo 以外路徑
- **產出範圍**：**僅新增 `docs/fmb-review/` 底下的 Markdown**，未修改任何既有檔案、未動 `.github/`、未動 secrets、未 push
- **資料保護**：本報告不含任何 token、金鑰、密碼、客戶個資或對話內文；需示意憑證時一律使用 `FAKE_VALUE_FOR_TEST` 這類明顯假字串。原 repo 文件中的內部連結與對話網址，本報告僅以「內部連結」描述，**不複製**。

---

## 1. 檔案索引

| 檔案 | 內容 |
|---|---|
| `README.md`（本檔） | 範圍、方法、嚴重度定義、35 檔覆蓋率表、總覽結論 |
| `findings-core.md` | `daemon/cdp.js`、`daemon/keys.js`、`daemon/store.js`、`bin/tp-browser.js`、`bin/ego-browser.js` 與 `lib/sdk.js` 隱含契約 |
| `findings-scripts-install.md` | `scripts/*`、`tools/profile-init.js`、`install.sh`、`install.ps1`、`install.cmd` |
| `findings-docs-tests.md` | `README.md`、`SKILL.md`、`STATE.md`、`tests/*`、`package.json`、`.gitignore`、`LICENSE`/`NOTICE` |
| `top10-and-estimates.md` | 前十大修補建議、工作量估計、驗證計畫、決策點 |

## 2. 嚴重度定義

| 級別 | 定義 |
|---|---|
| **S0 阻擋** | 可由外部（網頁／本機其他程序）觸發的破壞性行為，或憑證外洩、資料毀損；修補前不建議對外宣布「資安加固」 |
| **S1 高** | 功能錯誤、跨平台失效、靜默失敗導致自動化誤判、或明顯的機密暴露面 |
| **S2 中** | 併發競態、錯誤處理缺口、效能與可測試性問題；不致命但會累積事故 |
| **S3 低** | 可讀性、註解與實作不符、死碼、文件與實作漂移 |
| **S4 建議** | 工程衛生與長期維護建議，非缺陷 |

## 3. 行號說明

行號以審查包提供的檔案內容計算（`daemon/*.js`、`scripts/*.sh`、`bin/*.js` 為精確值；`install.ps1`、`scripts/ego-start.ps1` 因檔長且縮排不一致，標為「約」）。**每一則發現都附上逐字程式碼片段**，因此即使主幹合併造成 ±3 行偏移，仍可用片段 grep 定位。

## 4. 35 檔覆蓋率表

| # | 檔案 | 狀態 | 對應發現 |
|---|---|---|---|
| 1 | `.gitignore` | 已審查 | DOC-11 |
| 2 | `LICENSE` | 已審查（僅確認完整性） | — |
| 3 | `NOTICE` | 已審查（僅確認完整性） | DOC-12 |
| 4 | `README.md` | 已審查 | DOC-01、DOC-02、DOC-03 |
| 5 | `STATE.md` | 已審查 | DOC-04、DOC-08 |
| 6 | `bin/ego-browser.js` | 已審查 | BIN-04 |
| 7 | `bin/tp-browser.js` | 已審查 | BIN-01～BIN-12 |
| 8 | `daemon/cdp.js` | 已審查 | CDP-01～CDP-06 |
| 9 | `daemon/ego-browserd.js` | **內容未提供，無法逐行審查** | 見 §5 待補審清單 |
| 10 | `daemon/inpage.agent.js` | **內容未提供** | 見 §5 |
| 11 | `daemon/keys.js` | 已審查 | KEY-01～KEY-07 |
| 12 | `daemon/page-ops.js` | **內容未提供** | 見 §5 |
| 13 | `daemon/store.js` | 已審查 | STORE-01～STORE-07 |
| 14 | `daemon/tp-browserd.js` | **內容未提供** | 見 §5 |
| 15 | `docs/TP_WIN_AB_ACCEPTANCE_REPORT_1151018.md` | **內容未提供** | 見 §5 |
| 16 | `docs/index.html` | **內容未提供** | 見 §5 |
| 17 | `docs/tp_win_ab_benchmark_results_1151018.json` | **內容未提供** | 見 §5 |
| 18 | `install.cmd` | 已審查（單行轉呼叫，無問題） | — |
| 19 | `install.ps1` | 已審查 | SH-21～SH-23 |
| 20 | `install.sh` | 已審查 | SH-17～SH-20 |
| 21 | `lib/sdk.js` | **內容未提供** | 見 §5（契約反推） |
| 22 | `package.json` | 已審查 | DOC-03、DOC-09、DOC-10 |
| 23 | `scripts/ego-linux-browserd.service` | 已審查 | SVC-01 |
| 24 | `scripts/ego-linux-chrome.service` | 已審查 | SVC-01、SVC-02 |
| 25 | `scripts/ego-start.ps1` | 已審查 | SH-12～SH-16 |
| 26 | `scripts/ego-stop.ps1` | 已審查 | SH-10、SH-11 |
| 27 | `scripts/tp-start.sh` | 已審查 | SH-02～SH-09 |
| 28 | `scripts/tp-stop.sh` | 已審查 | SH-01、SH-02 |
| 29 | `skills/tp-browser/SKILL.md` | 已審查 | DOC-05～DOC-07 |
| 30 | `tests/bench/bench-run.ego.js` | 已審查 | TEST-01、TEST-02 |
| 31 | `tests/bench/bench-server.mjs` | **內容未提供** | 見 §5 |
| 32 | `tests/serve.mjs` | **內容未提供** | 見 §5 |
| 33 | `tests/smoke.ego.js` | **內容未提供** | 見 §5 |
| 34 | `tests/testpage.html` | 已審查 | TEST-04 |
| 35 | `tools/profile-init.js` | 已審查 | SH-24～SH-27 |

統計：已逐行審查 **24** 檔；內容未提供 **11** 檔（其中 5 檔是核心執行路徑：兩個 daemon 入口、`lib/sdk.js`、`page-ops.js`、`inpage.agent.js`）。

## 5. 待補審清單（內容未提供，無法定論，僅列必須驗證的假設）

以下 **不是發現**，而是從已知檔案反推出來的「隱含契約」。核心 daemon 與 SDK 未提供，是本報告最大的審查缺口；建議 BOB 補齊內容後做第二輪。

| 檔案 | 從呼叫端反推的必須驗證點 |
|---|---|
| `daemon/tp-browserd.js` / `daemon/ego-browserd.js` | ① `/health`、`/rpc`、`/flush-and-close`、`/newtab` 的**認證邊界**（`scripts/tp-stop.sh:6-7` 以**無 token** GET 呼叫 `/flush-and-close`，見 SH-01）。② `/rpc` 是否以 `crypto.timingSafeEqual` 驗 `x-tp-token`/`x-ego-token`（README 宣稱有）。③ 是否寫出 `daemon.json`/`token` 且權限為 0600。④ 監聽是否真的 `127.0.0.1` 且驗 `Host`。 |
| `daemon/page-ops.js` | ① `keys.js` 產出的 `vk` 是否正確映射為 CDP 的 `windowsVirtualKeyCode`（KEY-07）。② `setInputFiles` 是否真的套用 README 宣稱的 `/^ego-\d+$/` 校驗。③ `safePath` 是否覆蓋所有檔案類 API。④ `Network.setUserAgentOverride` 的品牌替換是否會讓 `navigator.userAgentData` 自相矛盾（反偵測副作用）。 |
| `daemon/inpage.agent.js` | ① 注入到頁面的 `window.__egoAgent` 是否可被頁面 JS 篡改/覆寫。② 是否有 `postMessage` 來源驗證。③ 是否把頁面內容未經長度上限回傳（OOM）。 |
| `lib/sdk.js` | ① `SKILL.md` 範例使用全域 `await sleep(1000)`，但 `bin/tp-browser.js` 只注入 `sdk` 的 export；若 `sleep` 未匯出，官方範例第一次執行即 `ReferenceError`（DOC-06）。② `createClient()` 是否提供 `close()`；`bin` 以 `process.exit()` 收尾（BIN-02）暗示 SSE 沒有被正確關閉。③ `Page`/`TaskSpace` 是否可重入、`waitPush` 是否會無上限累積 listener。 |
| `tests/smoke.ego.js`、`tests/serve.mjs` | ① smoke 是否處理 `alert()` 對話框（TEST-04）。② 是否硬編 9772/9773 導致不可併發。③ 是否有真的 assertion（而非只印字）。 |
| `docs/*` | ① 基準測試 JSON 與 README 數字是否一致（DOC-02）。② `docs/index.html` 是否含內部主機名或追蹤碼（DOC-04）。 |

## 6. 總覽結論（TL;DR）

1. **最嚴重的是「無 token 的破壞性 GET 端點」與「profile-init 預設搬運密碼庫/解密金鑰」**。前者可由任一網頁以 `<img src="http://127.0.0.1:9772/flush-and-close">` 觸發（no-cors GET 不帶 `Origin`，因此 README 宣稱的 Origin 檢查擋不住），屬 S0；後者讓 Agent 可驅動的瀏覽器同時持有使用者所有已登入狀態與 `os_crypt` 金鑰，屬設計層 S1。
2. **CLI 有兩個「靜默成功」缺陷**：`spawnSync` 失敗被 `?? 0` 吞成 exit 0（BIN-01）、`process.exit()` 可能截斷大筆 stdout（BIN-02）。這兩個組合正是「Agent 說任務完成、其實什麼都沒做／輸出被砍一半」的典型成因。
3. **`daemon/keys.js` 有真的邏輯錯誤**：`in` 與 `NAMED[name]` 走原型鏈（`keyDescriptor('constructor')` 會回傳 `Object` 建構子）、`ControlOrMeta` 在 macOS 對應錯誤。這是唯一能在純單元測試中穩定重現的功能性 bug，修補成本極低，建議第一個修。
4. **`Store` 缺乏 schema 驗證 + 未鎖 0600 + 同步全量寫檔**：一次壞檔就讓 daemon 永久起不來；任務看板含 URL/title，權限預設可能為 0644，與 README 宣稱的 0600 不符。
5. **跨平台啟動腳本以 `pkill -f` 與路徑樣式殺程序**：在官方支援的雙 daemon（9772/9774）情境下會互殺；Windows 版 `ego-stop.ps1` 甚至抓不到 `tp-browserd.js`（與 `ego-start.ps1` 不一致）。
6. **文件與實作已漂移**：`README`/`SKILL.md` 教的 `tools/cookies-export.ego.js`、`tools/cookies-import.ego.js` 在 repo 中不存在（DOC-01）；版本號三個來源三個值；README 與 `STATE.md` 的節省比例不一致（97.5% vs 88.6%）。
7. **可測試性不足**：`package.json` 沒有 `scripts`、沒有 CI、bench 寫死 `/tmp` 與 8890 埠、smoke 依賴全域埠不可重複執行。建議的整體修補量約 **9～11 人日**（見 `top10-and-estimates.md`）。

## 7. 本報告不做的事

- 不提出任何會修改既有檔案、`.github/workflows`、secrets 或 remote 設定的變更。
- 不複製任何 token/金鑰/個資/對話內文/當事人資料；引用內部連結時僅以類別描述。
- 不對未提供內容的檔案妄下定論，一律歸入 §5 待補審。
