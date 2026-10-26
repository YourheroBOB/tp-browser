# TP WIN 瀏覽器（Windows 原生版）雙機同步 A/B 對照驗收報告

- **驗收日期**：2026-10-19（民國 115 年 10 月 19 日）
- **測試主機**：`pc-win`（Windows 11 Pro 10.0.26200）＆ `rog`（ROG Ally Windows 11 Home 10.0.26200）雙機平行同步測試
- **受測 Agent 與模型**：`GLM 5.3 Flash @ ZCODE`（開啟 `--browser-use headless --mode yolo` 與 Computer Use 權限）
- **關聯專案與卡片**：Linear `HQ-1628`（專案：`專案_LinuxAgentBrowser_1151015` / GitHub：`YourheroBOB/ego-linux`）

---

## 一、實驗設計與防作弊環境隔離（Anti-Cheat Isolation）

為確保 A/B 兩組在 `pc-win` 與 `rog` 上絕對公平，我們透過自動化評測框架 `tp_win_ab_benchmark.py` 實施四層防作弊與環境隔離機制：

1. **獨立沙箱目錄隔離**：
   - 兩台機器均於 `C:\tp_win_eval\` 下建立獨立工作區：`C:\tp_win_eval\group_A`（A 組）、`C:\tp_win_eval\group_B`（B 組）與唯讀輸入區 `C:\tp_win_eval\inputs`（僅放置 `gpt_cookies.json`、`ppx_cookies.json` 與本系統共享記憶規格說明 `our_shared_memory_spec.md`）。
   - 每次任務啟動前自動清空目標輸出檔，確保所有產出均為當輪實時生成。
2. **禁止搜尋本機既有工作區與快取**：
   - System Prompt 嚴格禁止 Agent 存取或搜尋 `C:\tp_win_eval` 以外之本機硬碟目錄（如 `%USERPROFILE%\OpenClawWork`、`yhb-ssot`、`.openclaw`、`.codex` 等），並於跑分結束後自動審計 ZCode CLI Rollout JSONL（`~/.zcode/cli/rollout/model-io-sess_*.jsonl`）所有 Tool Calls 路徑，12 場測試 `antiCheatIsolated` 全數為 `true`（零違規）。
3. **任務二 Pre-Clear 強制驗證 Cookie 匯入**：
   - 在 A 組執行任務二前，評測腳本先透過 CDP `Storage.getCookies` + `Network.deleteCookies` 清空瀏覽器內所有 `chatgpt.com` / `openai.com` 登入態，強制 Agent 必須親自讀取 `C:\tp_win_eval\inputs\gpt_cookies.json` 並注入 Cookies 才能進入 `https://chatgpt.com/dots/home`。
4. **B 組硬體級進程隔離與 `control-browser` 強制綁定**：
   - 在 B 組執行期間，評測腳本自動呼叫 `ego-stop.ps1` 停止背景 TP WIN 瀏覽器 Daemon（Port `18802`），並於執行期遮蔽 CLI 旁路，確保 B 組 100% 全程使用傳統瀏覽器工具（ZCode 內建 `control-browser` Playwright REPL 與 `computer-use`）。

---

## 二、關鍵工程突破：原生 Windows Headless Chrome 零 Cloudflare 攔截與虛擬滾動克服

在移植與驗收過程中，TP WIN 瀏覽器完成了三項決定性技術突破（已提交至 `daemon/page-ops.js` 並同步雙機）：

1. **根除 Windows Headless Chrome 的 `Sec-CH-UA` Client Hints 洩漏（Cloudflare 403 破防關鍵）**：
   - 傳統 Playwright / Headless Chrome 即使修改了 User-Agent 字串，底層仍會在 TLS / HTTP Header `Sec-CH-UA` 送出 `"HeadlessChrome"`，導致 Perplexity 與 ChatGPT 立即觸發 Cloudflare Turnstile「請確認您是人類」攔截（這也是 B 組全軍覆沒的主因之一）。
   - TP WIN 瀏覽器在 `daemon/page-ops.js` 的 `ensurePageStealth()` 中，透過 CDP `Network.setUserAgentOverride` 動態攔截 `Browser.getVersion`，將 `userAgentMetadata.brands` 與 `fullVersionList` 中的 `"HeadlessChrome"` 100% 替換為 `"Google Chrome"`，並注入 `navigator.webdriver = false`，實現在 `pc-win` 與 `rog` 上首次連線即 100% 免驗證直通 Perplexity Pro 與 ChatGPT-Dots。
2. **克服 Perplexity 模型委員會虛擬滾動卸載（Virtualized Turn Unmounting）**：
   - Perplexity 長對話與多輪模型委員會採用虛擬列表（`.scrollable-container`）加上 `useStickToBottom` 自動鎖底機制，直接修改 `scrollTop = 0` 會被 React 強制彈回底部，且滾動到底部時第 1 輪 DOM 會被卸載。
   - TP WIN 瀏覽器透過單次 Node.js 腳本結合 CDP `Input.dispatchMouseEvent`（`type: "mouseWheel"`, `deltaY: -2500` 與 `+2500`）雙向滾動，在單一腳本呼叫內完整掛載並擷取第 1 輪與第 2 輪共 18,000～21,000 字元內容，零快照塞爆 Context。
3. **克服 Perplexity 模型委員會第 2 輪追問「`0 個模型`」重設陷阱**：
   - Perplexity 模型委員會在第 1 輪回答結束後，底部追問欄會自動重置為 `0 個模型` 並將 `button[aria-label="提交"]` 設為 `disabled`。TP WIN 透過座標定位展開 `0 個模型` 選單、依序掛載三席（`Gemini 4 Argon` + `Claude Fable 5.1` + `GPT-6 Astra`）、以 `Escape` 關閉浮層（避免誤點左側邊欄跳轉）後點擊提交，順利完成真實兩輪委員會深度討論。

---

## 三、雙機 A/B 總體數據對照表（Token 耗用 ✕ 瀏覽器操作時間 ✕ 完成率）

### 3.1 跨機總計對比（`pc-win` + `rog` 共 12 場；主數字取自 JSON）

**瀏覽器操作 token 節省 88.6%（總 token 82.1%；420 秒、雙機 3 任務共 6 組 A/B，Windows，1151018）。**

上句由 `docs/tp_win_ab_benchmark_results_1151018.json` 的 12 筆加總。舊稿曾寫「7 任務組」；JSON 實際是 2 機 × 3 任務 = 6 組 A/B（12 場）。B 組 6 場牆鐘都在 420.06–420.12 秒，並以超時結束。

| 評估指標 | A 組：TooPower Browser (`tp-win`) | B 組：傳統瀏覽器工具 (`control-browser` Playwright REPL) | A 組 vs B 組 效益差距 |
| :--- | :---: | :---: | :---: |
| **任務完成率（Success Rate）** | **6 / 6 (100.0%)** | **0 / 6 (0.0%，全數於約 420 秒超時)** | **A 組 100% 交付 vs B 組 0% 完整交付** |
| **瀏覽器操作 Token 總耗用 (`browserTotalTokens`)** | **1,103,960** | **9,707,934** | **節省 88.6%（相差 8.79 倍）** |
| **全程總 Token 耗用 (`totalTokens`)** | **2,044,542** | **11,396,985** | **節省 82.1%（相差 5.57 倍）** |
| **瀏覽器操作回合數 (`browserTurnCount`)** | **20 Turns** | **126 Turns** | **減少 84.1%（相差 6.30 倍）** |
| **模型總請求回合數 (`modelRequestCount`)** | **36 Turns** | **152 Turns** | **減少 76.3%（相差 4.22 倍）** |
| **瀏覽器操作模型耗時 (`browserModelDurationSec`)** | **719.54 秒** | **1,819.73 秒+**（超時截斷） | **快 2.53 倍以上** |
| **任務總執行時間 (`wallTimeSec`)** | **1,039.20 秒**（含撰寫萬字分析報告） | **2,520.47 秒+**（全數撞約 420 秒上限） | **快 2.43 倍以上且完整產出全部成果檔** |

> 同日 720 秒報告（B 側合計不在上述 JSON，不作主數字）：瀏覽器操作 token 1,103,960 對 13,277,610，節省 **91.7%**；總 token 2,044,542 對 14,332,944，節省 **85.7%**。

---

### 3.2 各主機 × 各任務逐項明細對照表

| 主機 | 任務 | 組別 | 狀態 | 總耗時 (`wallTimeSec`) | 瀏覽器操作耗時 (`browserModelDurationSec`) | 總回合 / 瀏覽器回合 | 總 Tokens (`totalTokens`) | **瀏覽器操作 Tokens (`browserTotalTokens`)** | 產出成果檔案與字數 |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| **`pc-win`** | **Task 1 (PPX 3 篇複雜對話)** | **A 組 (TP WIN)** | ✅ PASS | **103.53s** | **46.52s** | 6 / **2** | 305,454 | **97,948** | `task1_ppx_threads.md` (20,400 字 / 37.7 KB) |
| **`pc-win`** | **Task 1 (PPX 3 篇複雜對話)** | B 組 (傳統工具) | ❌ TIMEOUT | 420.09s | 295.33s | 10 / 10 | 708,505 | **708,505** | 無產出（JSON：約 420 秒超時，`outFiles` 空） |
| **`rog`** | **Task 1 (PPX 3 篇複雜對話)** | **A 組 (TP WIN)** | ✅ PASS | **76.09s** | **37.06s** | 4 / **2** | 189,099 | **94,015** | `task1_ppx_threads.md` (20,400 字 / 37.7 KB) |
| **`rog`** | **Task 1 (PPX 3 篇複雜對話)** | B 組 (傳統工具) | ❌ TIMEOUT | 420.06s | 375.00s | 23 / 21 | 1,511,821 | **1,385,244** | 無產出（JSON：約 420 秒超時，`outFiles` 空） |
| **`pc-win`** | **Task 2 (GPT-Dots 7 日擷取分析)** | **A 組 (TP WIN)** | ✅ PASS | **153.45s** | **106.39s** | 7 / **5** | 408,012 | **273,951** | `raw.md` (34,594 字) + `analysis.md` (5,733 字) |
| **`pc-win`** | **Task 2 (GPT-Dots 7 日擷取分析)** | B 組 (傳統工具) | ❌ TIMEOUT | 420.12s | 333.17s | 33 / 29 | 2,346,719 | **2,039,147** | 無產出（JSON：約 420 秒超時，`outFiles` 空） |
| **`rog`** | **Task 2 (GPT-Dots 7 日擷取分析)** | **A 組 (TP WIN)** | ✅ PASS | **296.33s** | **209.22s** | 8 / **5** | 489,735 | **291,586** | `raw.md` (41,501 字) + `analysis.md` (6,833 字) |
| **`rog`** | **Task 2 (GPT-Dots 7 日擷取分析)** | B 組 (傳統工具) | ❌ TIMEOUT | 420.06s | 352.96s | 19 / 19 | 1,440,355 | **1,440,355** | 無產出（JSON：約 420 秒超時，`outFiles` 空） |
| **`pc-win`** | **Task 3 (MemHub + PPX 委員會 2 輪)** | **A 組 (TP WIN)** | ✅ PASS | **127.99s** | **102.96s** | 5 / **3** | 296,342 | **168,287** | `ppx_council_raw.txt` (21,251 字) + `task3.md` (12,437 字) |
| **`pc-win`** | **Task 3 (MemHub + PPX 委員會 2 輪)** | B 組 (傳統工具) | ❌ TIMEOUT | 420.08s | 319.87s | 40 / 35 | 3,559,840 | **3,297,029** | 無產出（JSON：約 420 秒超時，`outFiles` 空） |
| **`rog`** | **Task 3 (MemHub + PPX 委員會 2 輪)** | **A 組 (TP WIN)** | ✅ PASS | **281.81s** | **217.39s** | 6 / **3** | 355,900 | **178,173** | `ppx_council_raw.txt` (18,102 字) + `task3.md` (11,776 字) |
| **`rog`** | **Task 3 (MemHub + PPX 委員會 2 輪)** | B 組 (傳統工具) | ❌ TIMEOUT | 420.06s | 143.40s | 27 / 12 | 1,829,745 | **837,654** | 無產出（JSON：約 420 秒超時，`outFiles` 空） |

> **分機小計（同一份 420 秒 JSON；都不是全組主數字）**：
> - 在 **`pc-win`** 上，A 組三個任務合計耗用 **540,186 瀏覽器操作 Tokens**（牆鐘 **384.97 秒**，3/3 完成）；B 組 **6,044,681 瀏覽器操作 Tokens**（牆鐘 **1,260.29 秒**，0/3）。這一台的瀏覽器操作 token 節省 **91.1%**（相差 11.19 倍），瀏覽器操作耗時快 **3.71 倍**。
> - 在 **`rog`** 上，A 組三個任務合計耗用 **563,774 瀏覽器操作 Tokens**（3/3 完成）；B 組 **3,663,253 瀏覽器操作 Tokens**（0/3）。這一台的瀏覽器操作 token 節省 **84.6%**（相差 6.50 倍）。
>
> 全組主數字仍是：瀏覽器操作 token 節省 88.6%（總 token 82.1%；420 秒、雙機 3 任務共 6 組 A/B，Windows，1151018）。

---

## 四、為什麼 A 組（TP WIN 瀏覽器）完勝 B 組（傳統瀏覽器工具）？根因剖析

1. **「頁內批次腳本落盤（In-Page JS Batching + Direct File Sink）」vs「逐動作 Accessibility Tree 快照回傳」**：
   - **B 組（傳統 Playwright MCP / `control-browser`）**：每次點擊、滾動或開啟分頁，工具都會將整頁 Accessibility Tree / DOM Snapshot 回傳給 LLM Context。在 Perplexity Deep Research 或 GPT-Dots 這種動輒 30,000～40,000 字的長頁面中，單次滾動回傳即消耗 50,000～120,000 Input Tokens；滾動 15～30 次後，單一任務的累積 Input Tokens 直接飆破 **150 萬～350 萬 Tokens**。
   - **A 組（TP WIN 瀏覽器 `ego-browser.js nodejs`）**：Agent 只需寫一段 20～35 行的確定性 JS 腳本，在瀏覽器外部與 CDP 內部一次跑完「導航 → 循環滾動觸發懶加載 → 展開摺疊區塊 → 直接寫入本機檔案（`fs.writeFileSync`）」，最後只向 LLM stdout 回傳一行 `DONE chars: 34594`（不到 50 Tokens）！瀏覽器互動由 **20～35 個回合壓縮為 1～2 個回合**。
2. **「常駐帶狀態 Daemon + 原生 Client Hints 偽裝」vs「臨時無狀態 Browser Context」**：
   - B 組的 `control-browser` 每次啟動臨時無狀態 Chromium 實例，不僅需要手動轉換 Cookie 格式（`sameSite`、`expires` 欄位稍有不合即拋錯），且因缺少 `userAgentMetadata`（`Sec-CH-UA`）偽裝，在 `perplexity.ai` 與 `chatgpt.com` 上頻繁撞上 Cloudflare 真人驗證牆而陷入死循環。
   - A 組的 TP WIN 瀏覽器常駐於本機 `127.0.0.1:18802`，持久化保存 `user-data-dir` 登入態並內建 `ensurePageStealth()`，支援 `taskSpace()` 多分頁隔離，開箱即享已登入 Session。

---

## 五、三項驗收任務之實質擷取與分析成果摘要

### 5.1 任務一：擷取 3 篇複雜 Perplexity 討論對話（克服懶加載）
- **`pc-win` 與 `rog` 雙機擷取結果完全一致**（`task1_ppx_threads.md` 均為 **20,400 字元 / 664 行 / 37,656 bytes**）：
  1. **Thread 1（`7603eaed-...`）**：ROG Ally + RTX 4090 XG Mobile (16GB VRAM) 本地推論與雙系統硬體基準深度研究（175 個來源，**5,250 字元**，完整包含 `llama.cpp` / `vLLM` / `Qwen3` 量化配置表）。
  2. **Thread 2（`3a74a39b-...`）**：ChatGPT Agent / DOT 本機 Computer Use 與多節點自動化評估（29 個來源，**11,073 字元**）。
  3. **Thread 3（`4d6ae89f-...`）**：律師財務與 30 天 YouTube 衝刺計畫・模型委員會三席對比（`GPT-6 Astra` / `Claude Opus 5.5` / `Gemini 4 Argon`，96 個來源，**3,420 字元**）。

### 5.2 任務二：匯入 GPT 網頁端 Cookies 並擷取分析 GPT-Dots（`Coolly`）最近一週對話
- **完整擷取與向上滾動懶加載克服**：
  - `pc-win` 向上滾動 `.messages-scroll` 擷取 **34,594 字元**（`ScrollHeight: 32,857`），產出結構化分析報告 `task2_gpt_dots_analysis.md`（**5,733 字元**）。
  - `rog` 向上滾動 `.messages-scroll` 擷取 **41,501 字元**（`ScrollHeight: 41,117`），產出結構化分析報告 `task2_gpt_dots_analysis.md`（**6,833 字元**）。
- **分析報告核心洞察（2026/10/16 ～ 10/18 實況）**：
  1. **核心專案主題分布**：① DOT 接手 GB1 大總管交接與巡檢契約（18%）；② DOT vs Gemini Task vs MiMo 2.6 Pro 三家橫向盲評（掃描 196 個聊天室＋125 份轉錄共 321 份來源，17%）；③ 三視窗（5h/週/月）用量監控與 45 分鐘時效基建（13%）；④ 戰兵 1,296 份解卡結果清查與雙審閘（13%）；⑤ R1 LINE 對話整理合成測試（獨立複審 99.82 分，9%）；⑥ PC 桌面截圖五輪診斷與 LINE OA 登入態排障（13%）。
  2. **關鍵治理定調**：確立「有產出檔案≠已解決」、「自測通過≠驗收通過（需獨立複審 90 分門檻＋FUGU/Muse 雙審）」、「失敗必須報卡點與轉向點，嚴禁靜默停等」、以及「R1 直接掃 GDrive 最新存檔與 PLAUD 轉錄，免接 LINE 即時線」。

### 5.3 任務三：騰訊開源 MemHub (`Hy-Memory`) 研究下載 ＋ PPX 模型委員會（`AGRON + FABLE + ASTRA`）2 輪深度討論
- **真實模型委員會討論串連結（已保存於 Perplexity 雲端與本機 `ppx_council_raw.txt`）**：
  - `pc-win` 討論串：`https://www.perplexity.ai/search/358e3641-644e-4418-a611-e7d61e8be9cc`（2 輪共 **21,251 字元**，155 個來源，報告 `task3_memhub_council.md` **12,437 字元**）
  - `rog` 討論串：`https://www.perplexity.ai/search/dbff41e2-170a-4a8f-8dd8-c5352235bc5e`（2 輪共 **18,102 字元**，152 個來源，報告 `task3_memhub_council.md` **11,776 字元**）
- **第 1 輪委員會共識（我們已具備甚至更強 vs 最值得借鑒）**：
  - **YHB 已具備且明顯更強之處**：① **跨 7 節點異質分散式收割**（MemHub 僅限單機單 Runtime、單一本地目錄）；② **Windows 原生支援**（MemHub 官方僅支援 macOS/Linux，不支援 Windows，無法涵蓋 `pc-win` 與 `rog`）；③ **Linear 原生專案 + `yhb-state` 人機共治與驗收狀態機**（優於純向量黑盒）。
  - **最值得從 MemHub 借鑒的 4 大設計（借設計、不換底盤）**：① **Working Memory「事實層（每 Session 必記 1 條原文存證）＋ 經驗層（過價值門檻、帶 `boundary_envs` 與 `confidence`）」雙層分離**；② **Coding Memory「零 LLM 裝飾器式版本演化鏈（diff-chain）」**（保留被 revert 的歷史 patch 與當下指令，並可延伸為**法律書狀版本演化鏈**）；③ **持久化寫入佇列＋Lease 過期標 `unknown` 不盲目重試＋寫後回讀核對**；④ **召回內容強制包裹「不可信資料」防 Prompt Injection**。
- **第 2 輪委員會追問成果（`doorbell_hub.py v2.4 → v2.5` 最小可行改造與 JSONL Schema 擴充規格）**：
  - 三模型（`Gemini 4 Argon` + `Claude Fable 5.1` + `GPT-6 Astra`）共同收斂出可直接交付實作的 **v2.5 事件溯源旁路規格**：
    1. **維持 v2.4 雙腿與 5-Bucket 不動**，新增各節點獨立 Append-Only JSONL 分片旁路（避免跨機共寫同一檔損毀），由單一確定性 Reducer 折疊出可隨時刪除重建的 SQLite 視圖。
    2. **四類標準事件（`yhb.memory/1`）**：`evidence.captured`、`code.revision`（零 LLM 擷取工具 `old/new` 或 `git diff`）、`memory.asserted`、`memory.decided`。
    3. **GPT-6 Astra 關鍵安全裁決**：
       - **衝突或消解失敗一律標 `pending`（或 `conflicted` 開 Linear 卡交人工），嚴禁降級直接寫入有效記憶**（法律與工程場景中，錯誤的有效記憶比待決記憶更危險）。
       - **原始事件不寫 `status / superseded_by / is_latest`**，全部由 Reducer 計算；撤回新版時不讓舊版自動復活（修補騰訊官方 SDK `client.py` 漏洞）。
       - **`event_id` 採用來源座標雜湊** `H(schema|producer|app|native_id|native_revision|event_type|item_idx)` 而非內容雜湊（解決 `A → B → A` 回退被誤判為重複事件丟棄的問題）。
       - **寫回 Linear 強制帶 `origin=memory_projection` 防回音標記**，避免下一輪收割器把自己寫出的摘要當成新證據無限循環。
       - **四開關分段上線**：`MEMORY_SIDECAR_ENABLED=true`、`MEMORY_REDUCER_MODE=shadow`、`MEMORY_ATTACH_ENABLED=false`、`MEMORY_LLM_RECONCILE_ENABLED=false`。

---

## 六、交付物清冊

1. **雙機 A/B 基準測試原始遙測數據**：`deliverables/tp_win_ab_benchmark_results_1151018.json`
2. **雙機 A/B 自動化評測框架腳本**：`deliverables/tp_win_ab_benchmark.py`
3. **`pc-win` A 組完整產出檔（本機 `C:\tp_win_eval\group_A\` ＆ 歸檔 `deliverables/eval_outputs/pc-win/group_A/`）**：
   - `task1_ppx_threads.md`（37,656 bytes）
   - `task2_gpt_dots_raw.md`（75,436 bytes）＆ `task2_gpt_dots_analysis.md`（11,367 bytes）
   - `ppx_council_raw.txt`（35,019 bytes）＆ `task3_memhub_council.md`（22,181 bytes）
4. **`rog` A 組完整產出檔（本機 `C:\tp_win_eval\group_A\` ＆ 歸檔 `deliverables/eval_outputs/rog/group_A/`）**：
   - `task1_ppx_threads.md`（37,656 bytes）
   - `task2_gpt_dots_raw.md`（92,319 bytes）＆ `task2_gpt_dots_analysis.md`（13,678 bytes）
   - `ppx_council_raw.txt`（32,373 bytes）＆ `task3_memhub_council.md`（21,935 bytes）
