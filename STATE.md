# 專案_LinuxAgentBrowser_1151015 STATE（TP 瀏覽器：Linux + Windows 全平台版）

- **更新日期**：1151019（2026-10-19）
- **雲端正本 Repo**：`https://github.com/YourheroBOB/ego-linux`
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
| **`pc` (WSL2 Linux)** | Ubuntu 24.04 WSL2 x86_64 | Node `v24.21.0` / Chrome `155` | `systemd --user` (`--no-sandbox`，`:9772` / `:9773`) | `{"ok":true,"chrome":true}` | ✅ 23/23 PASS (2,800 ms) | ✅ `rc=0` (16,387 ms) |

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
  - GitHub 私有庫：`https://github.com/YourheroBOB/ego-linux`（`main` 分支同步推送並經 `git ls-remote origin main` 讀回驗證）。
  - Perplexity 模型委員會 2 輪討論實況連結：
    - `pc-win`：`https://www.perplexity.ai/search/358e3641-644e-4418-a611-e7d61e8be9cc`
    - `rog`：`https://www.perplexity.ai/search/dbff41e2-170a-4a8f-8dd8-c5352235bc5e`
