# tp-browser 效能與可靠性審查（fmb-perf）

- **審查範圍**：`youtheroBOB/tp-browser`（`main` 分支內容）之常駐 daemon、CDP 傳輸層、TaskSpace 狀態檔、CLI、啟動/停止腳本、profile 初始化工具、systemd 單元與既有測試。
- **審查性質**：**唯讀審查**。本次**只新增** `docs/fmb-perf/` 下的 Markdown，**未修改任何既有程式碼或設定檔**；所有「建議修法」均為建議，需另行開分支實作與驗收。
- **不在本次範圍**：`@github/workflows`、secrets/憑證設定、對外正式服務的行為變更。

---

## 1. 審查方法

1. 逐檔靜態閱讀：`daemon/cdp.js`、`daemon/store.js`、`daemon/keys.js`、`bin/tp-browser.js`、`bin/ego-browser.js`、`scripts/tp-start.sh`、`scripts/tp-stop.sh`、`scripts/ego-start.ps1`、`scripts/ego-stop.ps1`、`scripts/*.service`、`tools/profile-init.js`、`install.sh`、`install.ps1`、`tests/*`。
2. 以「熱路徑成本 → 洩漏 → 競態 → 逾時/重試 → 錯誤恢復 → 可觀測性」六個構面逐項找缺陷，每項給出：位置、影響、建議修法、驗證方式、優先級。
3. **限制**：本次取得的檔案內容**不包含** `daemon/ego-browserd.js`、`daemon/tp-browserd.js`、`daemon/page-ops.js`、`daemon/inpage.agent.js`、`lib/sdk.js`、`tests/serve.mjs`、`tests/smoke.ego.js`。因此這些檔案的熱路徑問題（snapshot 產生、`evaluate` 序列化、SSE 佇列、重連）只能列為**待驗證假設**，集中於 [05-timeouts-retries-recovery.md](./05-timeouts-retries-recovery.md) 與 [08-backlog-and-decisions.md](./08-backlog-and-decisions.md)，**不臆測行號、不宣稱已確認**。

---

## 2. 優先級定義

| 級別 | 定義 | 處理建議 |
|---|---|---|
| **P0** | 可能造成資料遺失、憑證/登入態損毀，或讓使用者以為成功但實際失敗 | 下一個修補版本前必須處理 |
| **P1** | 明顯效能損耗、可觀察的卡頓/洩漏、常見故障無法自動恢復 | 排入近期迭代 |
| **P2** | 可維護性、診斷能力、邊界情況體驗 | 有空即修，或與 P1 同批 |
| **P3** | 錦上添花、整潔度 | 待辦清單 |

> 判斷原則：**能讓 Agent 單一 turn 卡住 ≥ 10 秒、或讓常駐 daemon 記憶體/磁碟無界成長**者一律 ≥ P1。

---

## 3. 建議先做的 8 件事（依序）

1. **S-01 / S-03**：`daemon/store.js` 的「每次 mutation 同步全量寫檔」改為 dirty + debounce，且損壞檔要先備份再重建（避免靜默清空 ledger）。
2. **L-05**：停止流程改 pidfile + 先 `/flush-and-close` 再分階段終止，**不要**用 `pkill -f <profile 路徑>` 掃殺（誤殺 + 登入態遺失）。
3. **C-03**：CDP WebSocket 加應用層心跳（`Browser.getVersion`），半開連線改為快速失敗並可重建，而不是每步空等 30 秒。
4. **L-03 / L-04**：CLI 的 `rpcCmd()` 補 `AbortSignal.timeout`，`spawnSync` 補 `timeout`（目前可無限阻塞）。
5. **I-01 / I-02**：`tools/profile-init.js` 加 marker 跳過與預設收斂（每次啟動重掃全機瀏覽器 profile + 同步大目錄，是啟動延遲主因；預設複製憑證 DB 需 BOB 決策）。
6. **O-01 / O-02 / O-03**：新增零依賴結構化日誌 + 每個 RPC 的 count/errors/p95 + `inflight` 欄位，讓 `tp-browser status` 能回答「現在卡在哪個 method」。
7. **T-01 / T-02**：逾時集中為單一來源，並區分「可重試（讀取/連線）」與「不可重試（點擊/輸入）」。
8. **L-01**：`bin/tp-browser.js` 與 `bin/ego-browser.js` 逐字重複且版本字串不一致，先收斂為單一入口。

---

## 4. 檔案索引

| 檔案 | 內容 | 主要 ID |
|---|---|---|
| [01-cdp-transport.md](./01-cdp-transport.md) | CDP WebSocket 傳輸層：pending 管理、逾時語意、心跳、半開連線、payload 大小、session 集合成長 | C-01 ~ C-08 |
| [02-state-store.md](./02-state-store.md) | TaskSpace JSON ledger：同步全量寫檔、原子性、權限、無界成長、損壞復原 | S-01 ~ S-07 |
| [03-cli-and-launchers.md](./03-cli-and-launchers.md) | CLI（`bin/*.js`）與啟動/停止腳本（`tp-start.sh`、`tp-stop.sh`、`ego-*.ps1`）：阻塞、逾時、掃殺、啟動競態、日誌輪替、雙軌衝突 | L-01 ~ L-12 |
| [04-startup-and-profile-init.md](./04-startup-and-profile-init.md) | 啟動成本與 `tools/profile-init.js`：全機掃描、大目錄同步、憑證 DB 複製、靜默失敗 | I-01 ~ I-05 |
| [05-timeouts-retries-recovery.md](./05-timeouts-retries-recovery.md) | 逾時一致性、重試分類與退避、Chrome/daemon 重連、錯誤資訊衰減、待驗證假設（`lib/sdk.js`、`page-ops.js`） | T-01 ~ T-08 |
| [06-observability.md](./06-observability.md) | 日誌格式、耗時/錯誤指標、`inflight` 可視性、事件洗版、輸出一致性與版本單一來源 | O-01 ~ O-06 |
| [07-verification-plan.md](./07-verification-plan.md) | 對應每個修法的驗證方式：單元（mock WS / tmp_path）、本機回環整合、故障注入、效能量測；測試安全規則 | V-01 ~ V-08 |
| [08-backlog-and-decisions.md](./08-backlog-and-decisions.md) | 未審到檔案清單與要看什麼、需要 BOB 決策的產品取捨、建議的落地順序與里程碑 | D-01 ~ D-06 |

---

## 5. 度量基線（建議在動手修改前先量）

在**本機回環**、不連外的前提下建立基線，避免「感覺變快了」：

| 指標 | 量測方式（皆為本機） | 現況推估 | 目標 |
|---|---|---|---|
| 冷啟動到 `TP_READY` | `time tp-start --restart`（三次取中位數；`tests/serve.mjs` 另起本機頁面） | 3~15 s（受 profile-init 與 10 s 輪詢影響） | 熱路徑 < 2 s、含 chrome 啟動 < 5 s |
| 單次 `goto` + `text` 往返 | 對 `127.0.0.1` 測試頁跑 20 次取 p95 | 未量測 | p95 明顯下降且變異小 |
| `store.js` 寫檔次數 / 一次 `goto` | 在 Store 外包一層計數 | 3~5 次全量寫檔 | ≤ 1 次（debounce 後） |
| daemon RSS（24h 常駐） | `process.memoryUsage()` 每 10 分鐘記一行 | 未知 | 成長斜率 ≈ 0 |
| daemon.log 大小（30 天） | 輪替策略驗證 | 無上限 | 有上限（例如 2 檔 × 10 MB） |

> **測試安全規則（本專案一律遵守）**：不得連線到網路上的正式服務；不得讀寫 repo 以外的路徑（測試一律用 `tmp_path`／`mkdtemp`）；假憑證一律使用 `FAKE_VALUE_FOR_TEST` 這類明顯假字串，**不得**使用任何真實格式前綴或真實值。
