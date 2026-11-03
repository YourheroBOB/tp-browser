# TooPower Browser (`tp-browser`) — 強到沒朋友 🚀

> **Slogan：TooPower — 強到沒朋友**  
> **The Free, Open-Source, Zero-Dependency Agent & Human-Agent Shared Browser for Windows, Linux, and macOS.**  
> **License**: [Apache License 2.0](./LICENSE) · **Attribution**: [NOTICE](./NOTICE)

**TooPower Browser (`tp-browser`)** 是 TooPower 開源計畫的第一炮旗艦產品——專為 AI Agent 與人類協作（Human-in-the-Loop）打造的跨三平台（**Windows / Linux / macOS**）專用瀏覽器控制核心與常駐系統。

它讓消費端使用者與開發者能在三大作業系統上**完全免費、開源**地享有：
1. **當事人 100% 自持 Cookies 與金鑰主權（Local Cookie Sovereignty）**：所有登入態（Google、ChatGPT、Perplexity、Claude、Kimi 等 3,300+ Cookies 含 `HttpOnly`）100% 留在你自己的電腦本機，零雲端肉機上傳、零第三方伺服器過水。
2. **單 Turn 批次 JS 執行（`tp-browser nodejs`）狂省 95%+ Token**：告別傳統 Playwright MCP / Computer Use 每步截圖與全頁 DOM 快照的 Token 黑洞。Agent 透過 Heredoc 單次提交完整非同步腳本（自動捲動破除懶加載、DOM 萃取、認證下載一氣呵成）。
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
| **操作範式** | **單 Turn 批次 JS REPL（省 95%+ Token）** | 單 Turn 批次 JS REPL | 逐 Turn 快照/截圖往返（高延遲、高 Token） |
| **Cookie 主權** | **100% 使用者本機自持（支援跨機加密遷移）** | 本機自持（限 macOS） | 依配置而定（常因每次重啟遺失登入態） |

> **Clean-Room 獨立實作聲明**：`tp-browser` 的每一行程式碼（約 2,000 行純 ESM JavaScript）均基於 Node.js 22 原生 `WebSocket` 與公開之 Chrome DevTools Protocol (CDP) 標準從零獨立撰寫，未使用 EGo Browser 的任何閉源程式碼、專有元件或商標；同時提供 `ego-browser` 相容 CLI 別名，方便既有 Agent Skill 無痛跨平台遷移。

---

## 📊 雙機實戰 A/B 對照基準測試（PC RTX 5090 + ROG RTX 4090）

我們在 **PC (`Windows 11 + RTX 5090`)** 與 **ROG (`Windows 11 + RTX 4090`)** 雙機上，使用相同的 `GLM 5.3 Flash` 模型執行三項高難度真實網頁任務：
- **Task 1**：擷取 3 篇 Perplexity 模型委員會超長上下文討論（強制破除懶加載）
- **Task 2**：注入本地 Cookie 進入 GPT-Dots 頁面提取並分析最近一週對話
- **Task 3**：研究騰訊開源 MemHub 架構，並操控 Perplexity 網頁進行 2 輪追問與對話存檔

| 測試分組（Task 1 實測對照） | 平均耗時 | 請求輪數 (Turns) | 瀏覽器操作 Tokens | 總耗用 Tokens | 節省倍率 |
|---|---:|---:|---:|---:|---:|
| **A 組：TooPower Browser (`tp-browser`)** | **136.3 秒** | **4 Turns** | **44,827** | **64,955** | **基準 (1x)** |
| **B 組：傳統瀏覽器工具 (`control-browser` REPL)** | 720.1 秒 | 30 Turns | 2,122,536 | 2,639,211 | **耗費 40.6 倍 Token / 慢 5.3 倍** |

> **實測結論**：在複雜長文與多步互動場景下，**TooPower Browser 節省高達 97.5% 的總 Token 消耗（瀏覽器操作 Token 節省 97.9%），執行速度提升 5.3 倍**；且 A 組在 PC 與 ROG 雙機共 6 項任務達成 **100% 通過率**（雙機 6 任務總計僅耗 486,232 Tokens）。

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
<<<FILE STATE.md>>>
# 專案_LinuxAgentBrowser_1151015 STATE（TP 瀏覽器：Linux + Windows 全平台版）

- **更新日期**：1151019（2026-10-19）
- **雲端正本 Repo**：`https://github.com/YourheroBOB/tp-browser`
- **對應 Linear 卡片**：`HQ-1628`、`HQ-1629`
- **本輪進度摘要**：
  1. 完成 **Windows 原生版 TP 瀏覽器（`ego-win` / `ego-linux` 跨平台版 + `toopowerchat`）** 研發、一鍵安裝器（`install.ps1` / `install.cmd`）與常駐啟動器（`scripts/ego-start.ps1`、`scripts/ego-stop.ps1`），並於兩台 Windows 11 核心主機（`rog`、`pc-win`）實機部署及通過 23/23 全功能冒煙與 `toopower_run.py` 15KB 長文附件端到端實測。
  2. 完成 **`pc-win` ＆ `rog` 雙機同步 A/B 對照驗收（Agent：`GLM 5.3 Flash @ ZCODE`，開放 Computer Use）**：
     - **A 組（TP WIN 瀏覽器）**：雙機 6 場任務 **100% 完成（6/6 PASS）**，總計僅耗用 **1,103,960 瀏覽器操作 Tokens**（總 Tokens **2,044,542**）、瀏覽器操作回合共 **20 Turns**、瀏覽器操作耗時 **719.54 秒**。
     - **B 組（傳統瀏覽器工具 `control-browser` / Playwright / CU）**：雙機 6 場任務 **0% 完成（0/6，全數於 420 秒超時失敗）**，總計耗用 **9,707,934 瀏覽器操作 Tokens**（總 Tokens **11,396,985**）、瀏覽器操作回合高達 **126 Turns**、瀏覽器操作耗時 **1,819.73 秒+**。
     - **綜合效益**：TP WIN 瀏覽器較傳統瀏覽器工具 **節省 88.6% 瀏覽器操作 Tokens（相差 8.79 倍；`pc-win` 單機節省 91.1% / 相差 11.19 倍）**、**瀏覽器操作回合減少 84.1%（6.30 倍）**、**瀏覽器操作速度快 2.53 倍以上（`pc-win` 快 3.71 倍）**。

---

## 一、 全節點（5 台 Linux + 2 台 Windows 原生）部署與實測現況（1151017–1151019）

| 節點 | OS / 架構 | Node / Browser | 服務與連接埠埠號 | Health Check | 23/23 冒煙 (`smoke.ego.js`) | `toopower_run.py` 15KB 附件端到端 |
|---|---|---|---|---|---|---|
| **`rog` (Windows)** | Windows 11 `10.0.26200` AMD64 | Node `v24.20.0` / Chrome `155.0.8059.85` | WMI 背景無頭 + Startup 自啟 (`:18802` / `:18800`) | `{"ok":true,"chrome":true}` | ✅ 23/23 PASS (2,848 ms) | ✅ `rc=0` (16,475 ms) |
| **`pc-win` (Windows)** | Windows 11 `10.0.26200` AMD64 | Node `v24.19.0` / Chrome `155.0.8059.85` | WMI 背景無頭 + Startup 自啟 (`:18802` / `:18800`) | `{"ok":true,"chrome":true}` | ✅ 23/23 PASS (3,122 ms) | ✅ `rc=0` (16,675 ms) |
| **`claw` (Linux)** | Ubuntu 24.04 x86_64 | Node `v24.18.0` / Chrome `150` | `systemd --user`（Xvfb `:99` 有頭 + VNC，`:9772` / `:9773`） | `{"ok":true,"chrome":true}` | ✅ 23/23 PASS (2,525 ms) | ✅ `rc=0` (16,209 ms) |
| **`gb1` (Linux)** | Debian 13 x86_64 | Node `v26.7.0` / Chrome `154` | `ego-start` + `/workspace` 還原包 (`:9772` / `:9773`) | `{"ok":true,"chrome":true}` | ✅ 23/23 PASS (2,613 ms) | ✅ `rc=0` (16,310 ms) |
| **`gb2` (Linux)** | Debian 13 x86_64 | Node `v20.19.2` / Chrome `151` | `ego-start` + `/workspace` 還原包 (`:9772` / `:9773`) | `{"ok":true,"chrome":true}` | ✅ 23/23 PASS (2,451 ms) | ✅ `rc=0` (16,306 ms) |
| **`abacus` (Linux)** | Ubuntu 24.04 x86_64 | Node `v24.21.0` / Chrome `151` | `ego-start` 常駐 (`:18802` / `:18800`) | `{"ok":true,"chrome":true}` | ✅ 23/23 PASS (2,706 ms) | ✅ `rc=0` (16,258 ms) |
| **`pc` (WSL2 Linux)** | Ubuntu 24.04 WSL2 x86_64 | Node `v24.21.0` / Chrome `155` | `systemd --user`（`--no-sandbox`，`:9772` / `:9773`） | `{"ok":true,"chrome":true}` | ✅ 23/23 PASS (2,800 ms) | ✅ `rc=0` (16,387 ms) |

---

## 二、 Windows 原生版核心工程突破（1151017–1151019）

1. **ESM `file://` URL 動態載入修正（`bin/ego-browser.js`）**：
   - Windows 下 Node.js ESM `import('C:\\...')` 會拋出 `ERR_UNSUPPORTED_ESM_URL_SCHEME (Received protocol 'c:')`；改為 `import(pathToFileURL(tmp).href)`，並自動剝除 PowerShell 管線常見之 UTF-8 BOM (`\uFEFF`)。
2. **根除 Windows Headless Chrome `Sec-CH-UA` Client Hints 洩漏（`daemon/page-ops.js`）**：
   - 透過 CDP `Network.setUserAgentOverride` 動態讀取 `Browser.getVersion` 並將 `userAgentMetadata.brands` 與 `fullVersionList` 中的 `"HeadlessChrome"` 100% 替換為 `"Google Chrome"`，同時於 `Page.addScriptToEvaluateOnNewDocument` 注入 `navigator.webdriver = false`，徹底解決 Windows 無頭模式下連線 `perplexity.ai` 與 `chatgpt.com` 觸發 Cloudflare Turnstile 攔截的問題。
3. **WSL2 `networkingMode=mirrored` 雙軌連接埠共存機制（`daemon/ego-browserd.js`、`bin/ego-browser.js`、`lib/sdk.js`、`scripts/ego-start.ps1`）**：
   - 支援與 WSL2 Linux 版雙軌並存，Windows 原生 CLI 與 WSL2 Linux CLI 各走各的原生瀏覽器與原生檔案系統路徑，零衝突並存。
4. **WMI `Win32_Process.Create` 零管線繼承背景常駐（`scripts/ego-start.ps1`）**：
   - 解決 Windows OpenSSH (`sshd`) 與 Python `subprocess.run(..., capture_output=True)` 下 `Start-Process` 子程序繼承標準輸出管線導致等待卡死的問題；無頭模式統一透過 WMI `Win32_Process.Create` 脫離父程序管線常駐，並註冊 Windows Startup 開機自動啟動（`tp-browser-autostart.vbs`）。
5. **支援有頭 GUI 登入與無頭常駐無縫切換（`ego-headed` / `ego-start`）**：
   - 在 Windows 上執行 `ego-headed`（或 `tp-headed`）即可用同一個 `profile-agent` 資料夾開啟可見的 Chrome/Edge 桌面視窗供人工登入各家 AI 網站；登入完畢後執行 `ego-start`（或 `tp-start`）即切回背景無頭模式，Cookie 與登入態 100% 保留。

---

## 三、 雙機（`pc-win` ＆ `rog`）A/B 對照驗收數據摘要（1151019）

| 主機 | 任務 | A 組 (TP WIN) 狀態 / 耗時 / 瀏覽器 Tokens | B 組 (傳統工具) 狀態 / 耗時 / 瀏覽器 Tokens | A 組產出成果 |
|---|---|---|---|---|
| **`pc-win`** | **Task 1：PPX 3 篇複雜對話擷取** | ✅ PASS / **103.53s** / **97,948 Tok** | ❌ TIMEOUT (420.09s) / 708,505 Tok | `task1_ppx_threads.md` (20,400 chars) |
| **`rog`** | **Task 1：PPX 3 篇複雜對話擷取** | ✅ PASS / **76.09s** / **94,015 Tok** | ❌ TIMEOUT (420.06s) / 1,385,244 Tok | `task1_ppx_threads.md` (20,400 chars) |
| **`pc-win`** | **Task 2：GPT-Dots 7 日對話擷取分析** | ✅ PASS / **153.45s** / **273,951 Tok** | ❌ TIMEOUT (420.12s) / 2,039,147 Tok | `raw.md` (34,594 chars) + `analysis.md` (5,733 chars) |
| **`rog`** | **Task 2：GPT-Dots 7 日對話擷取分析** | ✅ PASS / **296.33s** / **291,586 Tok** | ❌ TIMEOUT (420.06s) / 1,440,355 Tok | `raw.md` (41,501 chars) + `analysis.md` (6,833 chars) |
| **`pc-win`** | **Task 3：MemHub + PPX 委員會 2 輪討論** | ✅ PASS / **127.99s** / **168,287 Tok** | ❌ TIMEOUT (420.08s) / 3,297,029 Tok | `ppx_council_raw.txt` (21,251 chars) + `task3.md` (12,437 chars) |
| **`rog`** | **Task 3：MemHub + PPX 委員會 2 輪討論** | ✅ PASS / **281.81s** / **178,173 Tok** | ❌ TIMEOUT (420.06s) / 837,654 Tok | `ppx_council_raw.txt` (18,102 chars) + `task3.md` (11,776 chars) |

- **完整驗收報告**：`docs/TP_WIN_AB_ACCEPTANCE_REPORT_1151018.md`
- **已上雲讀回**：
  - GitHub 私有庫：`https://github.com/YourheroBOB/tp-browser`（`main` 分支同步推送並經 `git ls-remote origin main` 讀回驗證）。
  - Perplexity 模型委員會 2 輪討論實況連結：
    - `pc-win`：`https://www.perplexity.ai/search/358e3641-644e-4418-a611-e7d61e8be9cc`
    - `rog`：`https://www.perplexity.ai/search/dbff41e2-170a-4a8f-8dd8-c5352235bc5e`
<<<FILE docs/fmb/ARCHITECTURE.md>>>
# tp-browser 架構文件（ARCHITECTURE）

> **文件狀態**：依預設分支內容快照撰寫的現況描述（as-is），非目標架構提案。  
> **基準**：本文件只描述可由 repo 既有程式碼、README、STATE.md 與 docs/ 既有文件直接確認的行為；無法確認之處一律標註「未確認」。  
> **安全邊界**：本文不含任何實際 token、金鑰、密碼、客戶資料或案件內容。

## 1. 系統總覽

`tp-browser` 是一個**零 npm 相依**的跨平台（Windows / Linux / macOS）Agent 瀏覽器控制系統，由三層構成：

1. **CLI 層**：`bin/tp-browser.js`（與相容別名 `bin/ego-browser.js`），把 Agent 的單 Turn 批次 JS 腳本送進 daemon。
2. **Daemon 層**：`daemon/tp-browserd.js`（與相容別名 `daemon/ego-browserd.js`），提供 loopback HTTP API（健康檢查、RPC、事件、`/newtab`、`/flush-and-close`），並管理 TaskSpace ledger。
3. **瀏覽器層**：以 `--remote-debugging-address=127.0.0.1 --remote-debugging-port=<chromePort>` 啟動的本機 Chrome / Chromium / Edge / Brave，透過原生 CDP WebSocket 控制；分頁內注入 `daemon/inpage.agent.js` 形成 `window.__egoAgent`。

`package.json` 宣告 `"engines": { "node": ">=22" }`、ESM（`"type": "module"`）、`bin` 四個入口（`tp-browser`、`tp-browserd`、`ego-browser`、`ego-browserd`）。**沒有任何 dependencies / devDependencies**。

## 2. 模組圖

```
┌────────────────────────────────────────────────────────────────────┐
│  Agent（LLM／人類）                                                 │
│    heredoc 批次 JS：tp-browser nodejs <<'EOF' ... EOF               │
└──────────────┬─────────────────────────────────────────────────────┘
               │ 讀取 ~/.local/share/ego-linux/token（0600）
               │ HTTP + x-tp-token / x-ego-token
               ▼
┌──────────────────────────┐        ┌───────────────────────────────┐
│  bin/tp-browser.js (CLI)  │        │  lib/sdk.js（Node SDK）        │
│  bin/ego-browser.js(別名) │───────▶│  taskSpace()/page API/        │
└──────────────────────────┘        │  window.__egoAgent 綁定        │
                                    └──────────────┬────────────────┘
                                                   │ RPC over HTTP
                                                   ▼
┌────────────────────────────────────────────────────────────────────┐
│  daemon/tp-browserd.js（daemon/ego-browserd.js 相容別名）            │
│  綁定 127.0.0.1:9772（--alt-port → 9774）                           │
│  ├─ /health          回 {"ok":true,"chrome":true}                  │
│  ├─ /rpc             JSON RPC（space.list、page.* 等）              │
│  ├─ /newtab          有頭模式開啟的首頁                              │
│  └─ /flush-and-close 停止前沖刷 Cookie/storage 並優雅關閉            │
│  ├─ daemon/store.js   TaskSpace ledger（JSON 原子持久化）            │
│  ├─ daemon/keys.js    鍵名 → CDP dispatchKeyEvent 對照（純函式）     │
│  └─ daemon/page-ops.js 頁面操作（UA/Client Hints 偽裝、截圖、下載…） │
└──────────────┬─────────────────────────────────────────────────────┘
               │ CDP WebSocket（Node 22 原生 WebSocket，非套件）
               ▼
┌────────────────────────────────────────────────────────────────────┐
│  daemon/cdp.js：Cdp 類別（flat session protocol）                   │
│  ├─ send(method, params, {sessionId, timeout}) → Promise           │
│  ├─ onEvent / onClose 事件訂閱；once() 輔助                          │
│  └─ CdpError（包裝 CDP 錯誤，含 cdpError 原始資料）                  │
└──────────────┬─────────────────────────────────────────────────────┘
               │ ws://127.0.0.1:<chromePort>/devtools/...
               ▼
┌────────────────────────────────────────────────────────────────────┐
│  Chrome / Chromium / Edge / Brave（--user-data-dir=profile-agent）  │
│  ├─ daemon/inpage.agent.js 經 Runtime.evaluate                      │
│  │   注入為 window.__egoAgent（元素選取、快照、表單、檔案控制）      │
│  └─ 所有登入態 Cookie（含 HttpOnly）100% 留在本機 profile-agent     │
└────────────────────────────────────────────────────────────────────┘

週邊：
  tools/profile-init.js     初始化 profile-agent（書籤/Favicons/Login Data 匯入、Preferences 設定）
  scripts/tp-start.sh       macOS/Linux 啟動器（無頭/有頭/--alt-port/WSL2 委派）
  scripts/tp-stop.sh        停止器（flush-and-close → pkill daemon+profile）
  scripts/ego-start.ps1     Windows 啟動器（WMI Win32_Process.Create 背景常駐）
  scripts/ego-stop.ps1      Windows 停止器（依命令列比對 Stop-Process）
  scripts/ego-linux-*.service  systemd user unit（Chrome 9773 + daemon）
  fmb_feature2/reaper.js    TaskSpace ledger 自動回收器（已完成、尚未整合進 daemon）
```

## 3. 資料流

### 3.1 一次 Agent 任務的資料流

1. Agent 以 heredoc 提交腳本 → CLI 讀取 `~/.local/share/ego-linux/token` 與 `daemon.json`（取得 daemon 埠號，預設 9772、alt 9774）。
2. CLI／SDK 對 daemon 發 `POST /rpc`，攜帶 `x-tp-token`（或 `x-ego-token`）；daemon 以 `crypto.timingSafeEqual` 常數時間驗證，並拒絕 `Host` 非 `127.0.0.1` 或帶 `Origin` 的跨站請求（防 DNS rebinding / CSRF）。
3. daemon 經 `Store.create()` 在 ledger 建立 TaskSpace（`p1` 佔位分頁、`createdAt`、遞增 `nextSpaceId`），`persist()` 以「暫存檔 + `renameSync`」原子寫回 JSON。
4. daemon 透過 `Cdp` 向 Chrome 發 CDP 指令（開分頁 `Target.*`、導航 `Page.navigate`、`Runtime.evaluate` 執行批次 JS、`Network.setUserAgentOverride` 偽裝 HeadlessChrome 為 Google Chrome 並設 `navigator.webdriver = false`）。
5. 頁面事件（popup、dialog、download）經 CDP 事件回流 daemon → SSE／事件串流 → SDK `page.waitForEvent()`。
6. `task.finish({ keep: [] })` → daemon 關閉分頁、更新 ledger；錯誤以 `{ ok:false, error:{name,message} }` 回傳，SDK 轉為 JavaScript `Error`。

### 3.2 持久化與本機檔案

| 路徑（`$DATA_DIR = ~/.local/share/ego-linux`） | 內容 | 權限 |
|---|---|---|
| `token` | daemon 認證 token（CLI 自動讀取） | `0600`（chmod 於啟動腳本） |
| `daemon.json` | `{ "port": …, "chromePort": … }` | `0600` |
| `profile-agent/` | Chrome user-data-dir（Cookies、登入態、書籤） | 資料根目錄 `0700`（Linux）／`icacls` 限當前使用者（Windows） |
| `logs/daemon.log`、`logs/chrome.log` | 啟動腳本 redirect 的 daemon／Chrome 輸出 | 依目錄 |
| `spaces.json` | `Store` 持久化（`daemon/ego-browserd.js` 與 `daemon/tp-browserd.js` 皆為 `join(DATA_DIR, 'spaces.json')`，格式為 `{ nextSpaceId, labelSeq, spaces }`） | 依資料目錄 |

注意：`Store.load()` 讀到損壞 JSON 或根節點不是物件時，會先把原檔複製為 `spaces.json.corrupt-<timestamp>`，再**回退成空 ledger 並繼續啟動**（記 `store load failed`）。`normalizeLedger()` 會補 `nextSpaceId` 與物件型 `labelSeq`。缺 `spaces` 的 JSON（如 `{}`）仍會使 `list()`／`get()`／`create()` 拋 TypeError，此為已知健壯性缺口（`tests/test_fmb_store.test.mjs` 已文件化）。

### 3.3 啟動／停止資料流

- **macOS/Linux（`tp-start.sh`）**：先查 `/health` → 若已健康直接 `TP_READY`；否則 `flush-and-close` → pkill 舊程序 → 清 `SingletonLock/Cookie/Socket` → 跑 `tools/profile-init.js` → 探測瀏覽器二元檔（`TP_BROWSER_BIN` 可覆寫）→ 以 detached Node helper 先啟 daemon 再啟 Chrome（無頭 `--headless=new`，有頭開 `http://127.0.0.1:<port>/newtab`）→ 輪詢 10 秒等 `chrome:true`。
- **WSL2 有頭模式**：`tp-start.sh --headed` 偵測 `/proc/version` 含 microsoft 時，委派給 Windows 側 `ego-start.ps1 -Headed`，並把 Windows 側 `daemon.json`／`token` 複製回 Linux 側（雙軌埠位共存：9772/9773 與 alt 9774/9775）。
- **Windows（`ego-start.ps1`）**：無頭統一經 WMI `Win32_Process.Create` 脫離父程序管線常駐，並由 Startup 目錄的 `tp-browser-autostart.vbs` 開機自啟；`ego-stop.ps1` 依命令列比對（`ego-browserd.js` 或 `profile-agent`）終止程序。
- **停止（`tp-stop.sh`）**：`flush-and-close`（9772 與 9774 都試）→ sleep 1 秒 → pkill daemon 與 profile → `TP_STOPPED`。

## 4. 外部相依

### 4.1 npm 相依

**零。** `package.json` 無任何 `dependencies`／`devDependencies`／`peerDependencies`。這是刻意設計（供應鏈優勢），詳見 `docs/fmb-upgrade/` 與 `docs/fmb-ci/`。

### 4.2 執行環境相依

| 相依 | 版本／條件 | 用途 | 備註 |
|---|---|---|---|
| Node.js | `>=22`（`engines` 宣告）；Node 20 需 `--experimental-websocket`（啟動 wrapper 均帶此旗標） | 全部程式；原生 `WebSocket`（CDP）、`fetch`、`node:test` | STATE.md 記錄實機曾跑 v20.19.2–v26.7.0；建議基線見 `docs/fmb-upgrade/` |
| Chrome / Chromium / Edge / Brave | 任何支援 `--remote-debugging-port` 與 `--headless=new` 的版本；STATE.md 記錄 Chrome 150–155 實測 | 被控瀏覽器 | 探測順序：Linux `google-chrome→chromium→…→brave-browser`；macOS 依 `/Applications` 路徑；可用 `TP_BROWSER_BIN` 覆寫 |
| curl | 啟停腳本使用 | `/health` 檢查、`flush-and-close` | `tp-start.sh`／`tp-stop.sh` 必需 |
| git | 僅遠端一鍵安裝路徑（`install.sh`／`install.ps1` 會 `git clone --depth 1` 預設分支） | 安裝來源 | 本地 clone 安裝不需要；供應鏈風險見 `docs/fmb-ci/04-security-scans.md` |
| PowerShell 5+／WMI | Windows | `ego-start.ps1`、`ego-stop.ps1`、`install.ps1`、`icacls` 權限 | WMI 用於脫離管線常駐 |
| systemd（user unit） | Linux 選配 | `scripts/ego-linux-chrome.service`（9773）＋`ego-linux-browserd.service` | 非必需；`ego-start` 路徑即可 |
| Xvfb＋VNC | Linux 選配（STATE.md `claw` 節點） | 有頭模式於無顯示器主機 | 屬部署選擇，非程式相依 |

### 4.3 網路邊界

- daemon 與 Chrome CDP **一律綁 `127.0.0.1`**；`tp-start.sh` 明確傳 `--remote-debugging-address=127.0.0.1`。
- 預設埠：daemon `9772`、Chrome `9773`；`--alt-port`／Windows WSL2 共存情境為 daemon `9774`、Chrome `9775`（STATE.md 另記錄 Windows 節點使用 `18802`／`18800`，屬該部署的 `daemon.json` 覆寫值）。
- 程式本身**不對任何外部網路服務發起依賴性請求**；Agent 任務瀏覽的網站由使用者腳本決定，不屬架構相依。
- 測試僅使用 repo 內本機伺服器（`tests/serve.mjs`，`127.0.0.1:8899`）與 `os.tmpdir()` 暫存目錄。

## 5. 已知落差（與文件宣稱的差異）

1. **版本漂移**：`package.json` 為 `0.3.0`，CLI `version` 指令輸出 `0.3.1`（見 `docs/fmb-api/README.md`）；daemon 有頭新分頁 HTML 徽章為 `v0.3.2`（`daemon/ego-browserd.js`、`daemon/tp-browserd.js`）。
2. **閒置空間回收器未進 daemon**：`Store` 已有 `deleteSpace`／`removePage`，且 `rebindSpaces()`（`daemon/ego-browserd.js`、`daemon/tp-browserd.js`）會在重新附掛時刪除已無分頁的空間；`fmb_feature2/reaper.js` 的閒置／上限回收仍未整合進 daemon（整合方案見其 README）。
3. **`Store.load()` 對缺 `spaces` 仍不補預設**：`normalizeLedger()`（`daemon/store.js`）會把 `nextSpaceId` 正規化、把非物件的 `labelSeq` 補成 `{}`；根節點不是物件會當成損壞檔回退。缺 `spaces` 的 JSON（如 `{}`）仍會使 `list()`／`get()`／`create()` 拋 TypeError。
4. **`tests/smoke.ego.js` 硬編 `/tmp/...` 路徑**：在非 POSIX 環境或無 `/tmp` 寫入權限時會失敗。
5. **可觀測性缺口**：僅 `console.*` 日誌與 `/health` 一個端點，無指標／SLO／告警（全盤規劃見 `docs/fmb-observability/`）。

## 6. 相關文件

- API／介面：`docs/fmb-api/`（CLI、SDK、HTTP／SSE）
- CI／品質關卡：`docs/fmb-ci/`
- 可觀測性：`docs/fmb-observability/`
- 升級與支援矩陣：`docs/fmb-upgrade/`
- Ledger 回收器：`fmb_feature2/README.md`
- 操作手冊：`docs/fmb/RUNBOOK.md`；下一步規劃：`docs/fmb/ROADMAP.md`
<<<FILE docs/fmb/ROADMAP.md>>>
# tp-browser 路線圖（ROADMAP）

> **文件狀態**：依價值排序的下一步 10 項提案。本文僅規劃，未修改任何程式碼。  
> **排序原則**：(1) 修補「文件宣稱但程式不存在」的信譽缺口；(2) 低成本高回報的既有資產收尾；(3) 供應鏈與品質地基；(4) 中長期能力擴充。  
> **工作量估計**：以熟悉本 codebase（約 2,000 行純 ESM、零相依）的單一工程師為基準，單位人日（pd）。風險分低／中／高。

## 總覽表

| # | 項目 | 價值 | 工作量 | 風險 | 主要風險來源 |
|---|---|---|---|---|---|
| 1 | 補齊 Cookie 匯出／匯入工具（`tools/cookies-export.ego.js`、`tools/cookies-import.ego.js` 已在 repo） | 極高 | 3–5 pd | 中 | 觸碰敏感資料的匯出格式與加密 |
| 2 | 將 `fmb_feature2/reaper.js` 整合進 daemon | 高 | 1–2 pd | 低 | 自動刪除誤傷（已有兩道安全閥） |
| 3 | 統一版本號並改為固定 tag 安裝 | 高 | 0.5–1 pd | 低 | 發佈流程變更需協調 |
| 4 | 上線 Phase 0 CI（lint + `node --test` + gitleaks + npm audit） | 高 | 1 pd | 低 | repo 設定權限（需 BOB 操作） |
| 5 | `Store.load()` 形狀驗證與預設值 merge | 中高 | 0.5 pd | 低 | 需同步改寫既有「現況測試」 |
| 6 | `Store` 新增 `lastUsedAt` 並供 reaper 使用 | 中高 | 1 pd | 低 | schema 變更需向後相容 |
| 7 | 結構化日誌＋脫敏（redaction）機制（observability Phase 1） | 中高 | 2–3 pd | 中 | 日誌量大與敏感欄位洩漏防護 |
| 8 | `smoke.ego.js` 去除 `/tmp` 硬編路徑＋跨平台化 | 中 | 0.5 pd | 低 | 改動驗收基準腳本本身 |
| 9 | 瀏覽器支援矩陣正式化（Edge／Brave／macOS 驗收） | 中 | 3–5 pd（多為驗證） | 中 | 瀏覽器版本差異與 anti-bot 行為 |
| 10 | `/metrics` 端點＋基礎儀表板（observability Phase 2） | 中 | 2–4 pd | 中 | 零相依下自製 Prometheus text format 的維護成本 |

## 各項細節

### 1. 補齊 Cookie 匯出／匯入工具（優先序最高）

- **現況**：README「跨機 Cookie 登入態自由遷移」段落引用 `tools/cookies-export.ego.js` 與 `tools/cookies-import.ego.js`。這兩個檔案已在 repo 的 `tools/`（同目錄另有 `profile-init.js`）。
- **內容**：以 `tp-browser nodejs` 批次腳本形式實作；匯出走 CDP `Storage.getCookies`／`Network.getAllCookies`，寫入 `~/.local/share/ego-linux/cookies.json`（README 已宣稱 `0600` 權限）；匯入走對應的 set 系列。跨機情境依 README 宣稱提供加密（可用 Node 內建 `crypto`，如 AES-256-GCM + 使用者提供的通行語）。
- **風險與緩解**：這是全專案最敏感的操作（HttpOnly session cookies）。必須：預設輸出檔 `0600`、加密為跨機預設、文件一律用假值示例、測試只用 fake cookie 與 `tmpdir()`。
- **驗收**：新增 `tests/` 下的測試（fake cookies、`tmp_path`），並在 README 保留既有指令介面不變。

### 2. 整合 ledger 回收器進 daemon

- **現況**：`fmb_feature2/` 已提供完整、經測試（`node --test fmb_feature2/`）的 `planReap`／`applyReapPlan`，整合位置與程式碼片段都寫在其 README §3.2，只差在 `daemon/` 加一個低頻計時器。
- **內容**：照其建議以保守 policy 起步（`idleSpaceMs: 6h`、`maxSpaces: 500`），先只觀察 `stats` 一週再放寬；維持「live 集合為空 → 完全不動作」安全閥。
- **風險**：低——決定與執行分離的設計已內建乾跑能力；最大風險是與未來 `lastUsedAt`（項目 6）的語意銜接。

### 3. 統一版本號＋固定 tag 安裝

- **現況**：`package.json` `0.3.0`、CLI `version` `0.3.1`、有頭新分頁徽章 `v0.3.2`（`daemon/ego-browserd.js`、`daemon/tp-browserd.js`）；`install.sh`／`install.ps1` 會 `git clone` **浮動的預設分支**，且安裝流程會先 `rm -rf` 既有 runtime，無可靠回滾。
- **內容**：統一為單一版本號來源；安裝器改抓固定 `vX.Y.Z` tag 並驗證 checksum；runtime 改版本化目錄＋原子切換。細節見 `docs/fmb-ci/05-build-and-release.md` 與 `docs/fmb-upgrade/`。
- **風險**：低，但發佈節奏需 BOB 決策（見末節）。

### 4. Phase 0 CI 上線

- **現況**：`.github/workflows` 未列入 repo 檔案清單（即目前無 CI）；`docs/fmb-ci/` 已給出可直接採用的 workflow 範本。
- **內容**：L1 `node --check` 全量＋L2 `node --test tests/ fmb_feature2/`＋L3 gitleaks＋L4 `npm audit`（零相依 ⇒ trivial pass）。**不新增任何 devDependency**。
- **風險**：低。唯一障礙是建立 workflow 需 repo 寫入權限與分支保護設定，屬 BOB 親自操作範圍。E2E 冒煙（需真實 Chrome）先維持 advisory。

### 5. `Store.load()` 形狀驗證與 merge

- **現況**：`tests/test_fmb_store.test.mjs` 已文件化——載入 `{}` 會讓 `list()`／`create()` 拋 TypeError。
- **內容**：`load()` 改為與預設值 `{ nextSpaceId:1, labelSeq:{}, spaces:{} }` merge 並驗證欄位型別；**同步改寫**該「現況測試」為期望行為。向後相容：既有合法 ledger 不受影響。
- **風險**：低；是項目 2、6 的地基。

### 6. `Store` 新增 `lastUsedAt`

- **現況**：reaper 只能用 `createdAt` 判閒置（保守但會誤收「建立很久但仍在用」的空間）。
- **內容**：在 `setPage`／`bindPage`／`addPage` 等寫入點更新 `lastUsedAt`；reaper 的閒置基準改為 `lastUsedAt ?? createdAt`。schema 屬**加欄位**，舊 ledger 載入後為 `undefined`，回退 `createdAt`，向後相容。
- **風險**：低；需擴充 `fmb_feature2/reaper.test.js`。

### 7. 結構化日誌＋脫敏（redaction）機制（Phase 1）

- **現況**：僅無時間戳、無層級的 `console.*`，重定向到 `logs/daemon.log`／`chrome.log`；無任何敏感欄位防護。
- **內容**：依 `docs/fmb-observability/events-and-fields.md` 與 `sensitive-fields.md` 實作——允許清單欄位、JSON lines、本地優先（不外傳）、零相依。
- **風險**：中——主要是「不小心把頁面 URL／title（可能含案件線索）寫進日誌」的隱私風險，因此脫敏（redaction）機制必須與日誌同批上線，不可先上日誌後補防護。

### 8. 冒煙腳本跨平台化

- **現況**：`tests/smoke.ego.js` 硬編 `/tmp/ego-linux-smoke.png` 與 `/tmp/ego-linux-smoke-dl.txt`，且依賴 POSIX `/tmp` 與 `ps ax`（`tp-start.sh` 亦然）。
- **內容**：改為 env 或參數傳入輸出目錄（預設 `os.tmpdir()`），讓 Windows 原生環境可跑同一套冒煙；STATE.md 宣稱的「三平台」因此才有單一可重現的驗收腳本。
- **風險**：低——但它是驗收基準，改動後需在至少一台 Windows＋一台 Linux 各跑一次 23/23。

### 9. 瀏覽器支援矩陣正式化

- **現況**：STATE.md 有 Chrome 150–155 的實機證據；Edge／Brave 僅有探測程式碼，macOS 有路徑但缺可重現驗收報告。
- **內容**：為 Chrome／Chromium（正式）與 Edge／Brave／macOS（best effort）各建一張「版本 × 任務」驗收表，全部用 `tests/serve.mjs` 本機頁 + 假資料，不碰正式服務。
- **風險**：中——Chromium 系分支的 anti-bot／Client Hints 行為差異可能需要 `page-ops.js` 的 UA 偽裝邏輯各別調整。

### 10. `/metrics` 端點＋基礎儀表板（Phase 2）

- **現況**：`/health` 只回一個布林；無任何指標。
- **內容**：依 `docs/fmb-observability/metrics-and-slo.md` 與 `dashboards.md`，在 daemon 加 `/metrics`（Prometheus text format，純字串輸出，零相依），先揭露空間數、分頁數、RPC 延遲／錯誤率等**非內容型**指標。
- **風險**：中——`/metrics` 也在 loopback 上且需 token；需注意指標不得含 URL／title（依 `sensitive-fields.md`）。

## 明確排除（本輪不做）

- 不新增任何 npm runtime/dev dependency（違反零相依賣點；若未來必須，另案審查）。
- 不動 `.github/workflows`、git remote、secrets（任務規則；且 workflow 建立屬 BOB 權限）。
- 不連線正式服務做驗證；所有測試設計以 `tests/serve.mjs`＋`tmpdir()` 為限。

## 需要 BOB 決策的事

1. 項目 1 的跨機加密：預設加密（通行語制）還是明文 JSON＋警告？（本文建議：**預設加密**）。
2. 項目 3 的發佈節奏：何時凍結 0.3.x → 打第一個 `vX.Y.Z` tag？
3. 項目 4 的 required checks／分支保護：需 BOB 親自設定。
4. 項目 2 的回收 policy 上線值（本文建議 6h/500 先觀察一週）。
5. 項目 9 的 macOS 是否列入正式支援承諾（涉及 README 宣稱）。
