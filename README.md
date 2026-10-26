# TooPower Browser (`tp-browser`) — 強到沒朋友 🚀

> **Slogan：TooPower — 強到沒朋友**  
> **The Free, Open-Source, Zero-Dependency Agent & Human-Agent Shared Browser for Windows, Linux, and macOS.**  
> **License**: [Apache License 2.0](./LICENSE) · **Attribution**: [NOTICE](./NOTICE)

**TooPower Browser (`tp-browser`)** 是 TooPower 開源計畫的第一炮旗艦產品——專為 AI Agent 與人類協作（Human-in-the-Loop）打造的跨三平台（**Windows / Linux / macOS**）專用瀏覽器控制核心與常駐系統。

它讓消費端使用者與開發者能在三大作業系統上**完全免費、開源**地享有：
1. **當事人 100% 自持 Cookies 與金鑰主權（Local Cookie Sovereignty）**：所有登入態（Google、ChatGPT、Perplexity、Claude、Kimi 等 3,300+ Cookies 含 `HttpOnly`）100% 留在你自己的電腦本機，零雲端肉機上傳、零第三方伺服器過水。
2. **單 Turn 批次 JS 執行（`tp-browser nodejs`）：瀏覽器操作 token 節省 88.6%（總 token 82.1%；420 秒、雙機 3 任務共 6 組 A/B，Windows，1151018）**。告別傳統 Playwright MCP / Computer Use 每步截圖與全頁 DOM 快照的 Token 黑洞。Agent 透過 Heredoc 單次提交完整非同步腳本（自動捲動破除懶加載、DOM 萃取、認證下載一氣呵成）。
3. **TaskSpace 人機共乘（Human-Agent Co-Riding）**：背景無頭常駐（`tp-start`，零焦點搶占、零彈窗干擾）；遇到 Cloudflare 驗證或 2FA 登入時，一行指令切換有頭視窗（`tp-headed`）由人類接手登入，完成後無縫交還 Agent。

---

## 💡 概念啟發與原創定位聲明（Inspiration & Positioning）

本專案在「Agent 批次 JavaScript 執行」與「TaskSpace 人機共乘」之產品理念上，受到 **[EGo Browser (`lite.ego.app`)](https://lite.ego.app/)**（Citro Labs）的優秀概念啟發，特此致敬。

| 比較維度 | **TooPower Browser (`tp-browser`)** | **EGo Browser (`ego-lite`)** | **傳統 Playwright MCP / Computer Use** |
|---|---|---|---|
| **核心定位** | **賦能消費端與開發者免費自由使用** | 聚焦企業端（Enterprise）安全權限控管與合規治理 | 通用開發測試工具轉接 |
| **支援系統** | **Windows + Linux + macOS 三系統全支援** | 僅 macOS 正式版（Windows 封測、Linux 規劃中） | 跨平台但需安裝龐大驅動依賴 |
| **開源程度** | **100% 核心開源（Apache-2.0）** | 核心閉源 Mach-O 二進位檔（僅公開 Skill 文件） | 開源但無內建 TaskSpace 人機共乘 |
| **外部依賴** | **0 npm 依賴**（純 Node.js 22 原生 WebSocket + CDP） | 獨立封裝約 200MB+ 應用程式 | 需下載數百 MB 瀏覽器套件與依賴樹 |
| **操作範式** | **單 Turn 批次 JS REPL（瀏覽器操作 token 節省 88.6%；總 token 82.1%；420 秒、雙機 3 任務共 6 組 A/B，Windows，1151018）** | 單 Turn 批次 JS REPL | 逐 Turn 快照/截圖往返（高延遲、高 Token） |
| **Cookie 主權** | **100% 使用者本機自持（支援跨機加密遷移）** | 本機自持（限 macOS） | 依配置而定（常因每次重啟遺失登入態） |

> **Clean-Room 獨立實作聲明**：`tp-browser` 的每一行程式碼（約 2,000 行純 ESM JavaScript）均基於 Node.js 22 原生 `WebSocket` 與公開之 Chrome DevTools Protocol (CDP) 標準從零獨立撰寫，未使用 EGo Browser 的任何閉源程式碼、專有元件或商標；同時提供 `ego-browser` 相容 CLI 別名，方便既有 Agent Skill 無痛跨平台遷移。

---

## 📊 雙機實戰 A/B 對照基準測試（PC RTX 5090 + ROG RTX 4090）

我們在 **PC (`Windows 11 + RTX 5090`)** 與 **ROG (`Windows 11 + RTX 4090`)** 雙機上，使用相同的 `GLM 5.3 Flash` 模型執行三項高難度真實網頁任務：
- **Task 1**：擷取 3 篇 Perplexity 模型委員會超長上下文討論（強制破除懶加載）
- **Task 2**：注入本地 Cookie 進入 GPT-Dots 頁面提取並分析最近一週對話
- **Task 3**：研究騰訊開源 MemHub 架構，並操控 Perplexity 網頁進行 2 輪追問與對話存檔

| 測試分組（420 秒、雙機 3 任務共 6 組 A/B） | 瀏覽器操作 Tokens | 總耗用 Tokens | 完成 |
|---|---:|---:|---:|
| **A 組：TooPower Browser (`tp-browser`)** | **1,103,960** | **2,044,542** | **6/6** |
| **B 組：傳統瀏覽器工具 (`control-browser` REPL)** | 9,707,934 | 11,396,985 | 0/6（約 420 秒超時） |

> **實測結論**：瀏覽器操作 token 節省 88.6%（總 token 82.1%；420 秒、雙機 3 任務共 6 組 A/B，Windows，1151018）。A 組 6/6 完成，B 組 0/6。數字由 `docs/tp_win_ab_benchmark_results_1151018.json` 的 12 筆加總（2 機 × 3 任務）。同日 720 秒報告另寫瀏覽器操作 token 節省 91.7%（總 token 85.7%；B 組瀏覽器操作 token 13,277,610、總 token 14,332,944）。該組 B 側合計不在這份 JSON，不作主數字。

---

## ⚡ 三大系統一鍵安裝與快速開始

**前置需求**：Node.js `>= 22`（或 Node 20 帶 `--experimental-websocket`）與系統已安裝的 Chrome / Edge / Brave / Chromium。

### 1. Windows 原生版 (`tp-win`)

```powershell
# 安裝並設定開機背景自動啟動（同時建立 tp-browser 與相容別名 ego-browser）
.\install.cmd

# 常用指令
tp-start                  # 啟動背景無頭模式（零視窗干擾、自動處理 WSL2 9773/9775 埠位避讓）
tp-headed                 # 切換為有頭 GUI 視窗（供人工通過 Cloudflare / 2FA 登入，共用同一個 Profile）
tp-browser status         # 檢查 daemon 與 Chrome/Edge 連線狀態
tp-browser doctor         # 完整環境健檢與修復指引
tp-stop                   # 停止背景服務（絕不影響你個人日常開啟的瀏覽器視窗）
```

### 2. macOS 原生版 (`tp-mac`)

```zsh
# 安裝至 ~/.local/share/ego-linux/app 並連結至 ~/.local/bin（自動保護既有原生 ego-browser 不被覆蓋）
./install.sh

# 常用指令
tp-start                  # 自動偵測 macOS Google Chrome / Brave / Edge 並以 setsid 背景無頭啟動
tp-headed                 # 切換為有頭 GUI 視窗供人工登入
tp-browser doctor         # 檢查 macOS 連線狀態
tp-stop                   # 停止服務
```

### 3. Linux 原生版 (`tp-linux`)

```bash
./install.sh
tp-start                  # 自動偵測 chromium / google-chrome 並啟動背景常駐
# 或啟用 systemd user service：
# cp scripts/*.service ~/.config/systemd/user/ && systemctl --user enable --now ego-linux-chrome ego-linux-browserd
tp-browser doctor
```

---

## 🤖 Agent 批次 JS 操控範例（`tp-browser nodejs`）

```bash
tp-browser nodejs <<'EOF'
const task = await taskSpace("research-flow");
const page = task.page("p1");

await page.goto("https://example.com", { waitUntil: "load" });
console.log(await page.snapshot());

// 單 Turn 內在頁面執行任意複雜滾動、懶加載破除與 DOM 萃取
const data = await page.evaluate(async () => {
  window.scrollTo(0, document.body.scrollHeight);
  await new Promise(r => setTimeout(r, 500));
  return { title: document.title, text: document.body.innerText.slice(0, 500) };
});
console.log("Extracted:", JSON.stringify(data));

await task.finish({ keep: [] });
EOF
```

### 跨機 Cookie 登入態自由遷移（100% 本地自持）

```bash
# 從已登入的瀏覽器匯出完整 Cookies（自動設為 0600 權限寫入 ~/.local/share/ego-linux/cookies.json）
tp-browser nodejs < tools/cookies-export.ego.js

# 在另一台機器或新 Profile 一鍵匯入所有 Cookies（含 HttpOnly Session）
tp-browser nodejs < tools/cookies-import.ego.js
```

---

## 🛡️ 輕量化資安加固架構（經 GPT 6.1 SOL 與 GLM 5.3 雙重審計）

TooPower Browser 堅持「**極致輕量、零臃腫**」原則，在不引入任何外部套件的前提下，內建六道嚴密資安防線：
1. **Loopback 強制綁定**：Daemon (`127.0.0.1:9772/9774`) 與 Chromium CDP (`--remote-debugging-address=127.0.0.1`) 嚴格限制僅綁定本地迴路，杜絕區網探測。
2. **防 DNS Rebinding 與跨站 CSRF 攻擊**：HTTP 層強制驗證 `Host` 標頭必須為 `127.0.0.1`，且拒絕任何帶有 `Origin` 標頭的瀏覽器跨站請求。
3. **常數時間 Token 驗證**：透過 `crypto.timingSafeEqual` 驗證 `~/.local/share/ego-linux/token`（支援 `x-tp-token` 與 `x-ego-token`），消除時序側信道風險。
4. **檔案系統與符號連結防逃逸 (`safePath`)**：所有截圖、下載與檔案上傳路徑均強制通過 `realpathSync.native` 真實路徑解析，阻斷 `..` 穿越與 Symlink 逃逸。
5. **DOM 標記注入防護**：檔案上傳 `setInputFiles` 強制執行 `/^ego-\d+$/` 正則校驗，防止惡意網頁竄改 `window.__egoAgent` 注入腳本。
6. **最小權限原則（`0700` / `0600` & Windows `icacls`）**：資料根目錄、Token、臨時執行目錄 (`mkdtempSync`) 與 `cookies.json` 均強制鎖定僅當前作業系統使用者可讀寫。
   - *安全邊界提示*：本工具設計適用於**單一使用者個人電腦或專屬開發工作站**；在多人共用的作業系統主機上，請確保使用獨立 OS 帳號以隔離本地迴路埠位。

---

## 🧪 端到端測試（23/23 Smoke Suite）

```bash
node tests/serve.mjs &
tp-browser nodejs < tests/smoke.ego.js
# == smoke: 23/23 pass ==
# ALL_GREEN
```

---

## 📄 開源授權（License）與創始作者

本專案採用 **[Apache License 2.0](./LICENSE)** 開源授權。任何衍生作品、修改或商業整合均免費開放，惟再散布時須依 Apache-2.0 第 4(d) 條保留 [`NOTICE`](./NOTICE) 檔案中之 TooPower Browser 原創歸屬聲明與 EGo Browser 概念啟發致敬。

### 👨‍⚖️ 創始作者與官方頻道（Founder & Creator）
- **創始作者**：**嚴柏顯律師（BOB）**｜**弘人法律事務所**主持律師
- **YouTube 官方頻道**：[**📺 市井律師BOB-嚴律 (`@YourHeroBob`)**](https://www.youtube.com/@YourHeroBob)
- **開源主倉庫**：[https://github.com/YourheroBOB/tp-browser](https://github.com/YourheroBOB/tp-browser)
- **線上產品介紹頁**：[https://yourherobob.github.io/tp-browser/](https://yourherobob.github.io/tp-browser/)

