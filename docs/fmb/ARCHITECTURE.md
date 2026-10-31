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
│  ├─ daemon/inpage.agent.js 經 Page.addScriptToEvaluateOnNewDocument │
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
| TaskSpace ledger JSON | `Store` 持久化（確切檔名由 daemon 決定，格式為 `{ nextSpaceId, labelSeq, spaces }`） | 依資料目錄 |

注意：`Store.load()` 讀到損壞 JSON 時會**回退成空 ledger 並繼續啟動**（記 `store load failed`）；載入形狀不完整的 JSON（如 `{}`）時各方法會拋 TypeError，此為已知健壯性缺口（`tests/test_fmb_store.test.mjs` 已文件化）。

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

1. **Cookie 匯出／匯入工具不存在**：README 宣稱 `tools/cookies-export.ego.js`／`tools/cookies-import.ego.js`，但 repo 的 `tools/` 目錄只有 `profile-init.js`。此為文件超前於程式碼的缺口。
2. **版本漂移**：`package.json` 為 `0.3.0`，CLI `version` 指令輸出 `0.3.1`（見 `docs/fmb-api/README.md`）。
3. **ledger 只增不減**：`Store` 無任何自動清理路徑；`fmb_feature2/reaper.js` 已完成回收器但尚未整合進 daemon（整合方案見其 README）。
4. **`Store.load()` 不驗證載入形狀**：缺 `spaces`／`labelSeq` 的 JSON 會使各方法拋 TypeError。
5. **`tests/smoke.ego.js` 硬編 `/tmp/...` 路徑**：在非 POSIX 環境或無 `/tmp` 寫入權限時會失敗。
6. **可觀測性缺口**：僅 `console.*` 日誌與 `/health` 一個端點，無指標／SLO／告警（全盤規劃見 `docs/fmb-observability/`）。

## 6. 相關文件

- API／介面：`docs/fmb-api/`（CLI、SDK、HTTP／SSE）
- CI／品質關卡：`docs/fmb-ci/`
- 可觀測性：`docs/fmb-observability/`
- 升級與支援矩陣：`docs/fmb-upgrade/`
- 安全稽核：`docs/fmb-security/`
- Ledger 回收器：`fmb_feature2/README.md`
- 操作手冊：`docs/fmb/RUNBOOK.md`；下一步規劃：`docs/fmb/ROADMAP.md`
