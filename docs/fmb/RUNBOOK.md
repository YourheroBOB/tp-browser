# tp-browser 操作手冊（RUNBOOK）

> **文件狀態**：依 repo 既有程式碼實際內容撰寫的 as-is 操作步驟。所有指令皆出自 `install.sh`／`install.ps1`／`scripts/*`／`tests/*`／README 可確認的行為。  
> **安全邊界**：本文不含任何實際 token、金鑰、密碼、客戶資料或案件內容；示例憑證一律使用 `FAKE_VALUE_FOR_TEST`。  
> **重要**：所有服務僅綁 `127.0.0.1`，只應在單一使用者個人電腦／專屬工作站上操作。

## 1. 前置需求

| 項目 | 需求 |
|---|---|
| Node.js | `>=22`（`package.json` `engines`）。Node 20 需 `--experimental-websocket` 旗標（安裝器產生的 wrapper 已自動帶上） |
| 瀏覽器 | 本機已安裝 Chrome／Chromium／Edge／Brave 任一（Linux 探測順序：`google-chrome` → `google-chrome-stable` → `chromium` → `chromium-browser` → `microsoft-edge` → `brave-browser`；macOS 探測 `/Applications` 標準路徑；可用環境變數 `TP_BROWSER_BIN` 指定） |
| macOS/Linux 額外 | `curl`（啟停腳本使用） |
| Windows 額外 | PowerShell 5+（`install.ps1`／`ego-start.ps1`） |
| 安裝（遠端一鍵） | `git`（僅 `git clone --depth 1` 安裝路徑需要；本地 clone 安裝不需要） |

確認 Node 版本：

```bash
node --version   # 應 >= v22.x
```

## 2. 安裝

### 2.1 macOS / Linux

```bash
# 方式 A：本地 clone（推薦開發者；不會觸網）
cd tp-browser
./install.sh

# 方式 B：遠端一鍵（會 git clone 預設分支；供應鏈風險見 docs/fmb-ci/）
curl -fsSL https://raw.githubusercontent.com/YourheroBOB/tp-browser/main/install.sh | bash
```

安裝結果（`install.sh` 實際行為）：

- runtime 複製到 `~/.local/share/ego-linux/app/`（bin／daemon／lib／scripts／tools／tests／skills／docs／package.json）。
- 建立符號連結：`~/.local/bin/` 下的 `tp-browser`、`tp-browserd`、`tp-start`、`tp-headed`、`tp-stop`，以及相容別名 `ego-browser`、`ego-browserd`、`ego-start`、`ego-headed`、`ego-stop`；若 `/usr/local/bin` 可寫，亦連結過去。
- 自動把 `skills/tp-browser/SKILL.md` 複製到 `~/.claude/skills/`、`~/.agents/skills/`、`~/.codex/skills/`、`~/.gemini/config/skills/`（tp-browser 與 ego-browser 兩名）。
- 資料目錄 `~/.local/share/ego-linux` 設 `chmod 700`。

### 2.2 Windows

```powershell
.\install.cmd        # 內部以 Bypass 執行 install.ps1
```

`install.ps1` 實際行為：複製 runtime 到 `~\.local\share\ego-linux`、以 `icacls` 限當前使用者權限、建立 `~\.local\bin` 與 `~\bin` 的 `.cmd` wrapper、加入 User PATH、在 Startup 目錄建立 `tp-browser-autostart.vbs`（開機隱藏自啟）、最後**自動啟動服務並跑 `version`／`status`**。

## 3. 執行

### 3.1 啟動（macOS / Linux）

```bash
tp-start            # 背景無頭模式：daemon 127.0.0.1:9772 + Chrome CDP 127.0.0.1:9773
tp-start --headed   # 有頭 GUI 視窗（人工過 Cloudflare / 2FA；同一個 profile-agent）
tp-start --restart  # 強制重啟（跳過健康檢查）
tp-start --alt-port # WSL2 共存：daemon 9774 + Chrome 9775
```

- 成功輸出：`TP_READY (port=…, chrome=…, os=…[, mode=headed])`；失敗輸出 `TP_NOT_READY`（exit 1）。
- `--headed` 額外印 `TP_INDICATORS`（分頁標題前綴 `⚡[TP]`、金色頂條、右下角膠囊）。
- root 身份執行時自動加 `--no-sandbox`。

### 3.2 啟動（Windows）

```powershell
tp-start            # 無頭：WMI Win32_Process.Create 背景常駐（零管線繼承）
tp-headed           # 有頭 GUI
tp-stop             # 停止
tp-browser status   # 檢查狀態
```

### 3.3 systemd（Linux，選配）

```bash
mkdir -p ~/.config/systemd/user/
cp scripts/ego-linux-chrome.service scripts/ego-linux-browserd.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now ego-linux-chrome ego-linux-browserd
```

（unit 檔寫死 Chromium 路徑 `/usr/bin/chromium` 與埠 9773，非該環境需先改 unit——改 unit 屬部署設定，非本手冊範圍。）

### 3.4 停止

```bash
tp-stop    # 先打 /flush-and-close（9772 與 9774 皆試）→ pkill daemon 與 profile-agent → TP_STOPPED
```

停止只終止命令列含 `ego-browserd.js`／`tp-browserd.js`／`profile-agent` 的程序，**不影響日常瀏覽器視窗**。

### 3.5 常用 CLI

```bash
tp-browser status    # daemon 與 Chrome 連線狀態
tp-browser doctor    # 環境健檢與修復指引
tp-browser spaces    # 列出 TaskSpace（RPC space.list）
tp-browser skill     # 印出 Agent Skill 說明
tp-browser nodejs <<'EOF'    # 單 Turn 批次 JS
const task = await taskSpace("demo");
const page = task.page("p1");
await page.goto("http://127.0.0.1:8899/", { waitUntil: "load" });
console.log(await page.snapshot());
await task.finish({ keep: [] });
EOF
```

注意：示範網址一律用本機測試頁（`tests/serve.mjs` 的 `127.0.0.1:8899`），不要在驗證流程中使用正式服務。

## 4. 測試

### 4.1 單元／整合測試（零網路、零相依，可直接跑）

```bash
node --test tests/ fmb_feature2/
```

覆蓋範圍（皆為 repo 內實際測試檔）：

| 檔案 | 對象 |
|---|---|
| `tests/test_fmb_store.test.mjs` | `daemon/store.js` ledger 行為與邊界 |
| `tests/test_fmb_keys.test.mjs` | `daemon/keys.js` 鍵名對照 |
| `tests/test_fmb_cdp.test.mjs` | `daemon/cdp.js` |
| `tests/test_fmb_profile_init.test.mjs` | `tools/profile-init.js`（環境變數導向 `os.tmpdir()` 沙箱） |
| `tests/fmb_integration_cli.test.mjs` | CLI ↔ daemon HTTP 整合（本機 fixture server，`FAKE_VALUE_FOR_TEST` token；埠被占用時自動 skip） |
| `fmb_feature2/*.test.js` | reaper 純函式、真實 Store 整合、乾跑 CLI |

### 4.2 E2E 冒煙（23 項，需真實 Chrome 與已啟動的 daemon）

```bash
# 1. 起本機測試頁伺服器（僅 127.0.0.1:8899）
node tests/serve.mjs &

# 2. 確認 daemon 已啟動（見 §3.1），然後：
tp-browser nodejs < tests/smoke.ego.js

# 預期輸出：
# == smoke: 23/23 pass ==
# ALL_GREEN
```

注意事項：

- `smoke.ego.js` 會寫 `/tmp/ego-linux-smoke.png` 與 `/tmp/ego-linux-smoke-dl.txt`（硬編路徑；Windows 原生環境不適用，見 ROADMAP 項目 8）。
- 冒煙會真實開關分頁、觸發下載與對話框；只對 `127.0.0.1:8899` 的 `testpage.html` 操作。

### 4.3 效能基準（選配）

```bash
node tests/bench/bench-server.mjs &   # 未驗證於本手冊環境；位於 tests/bench/
```

`tests/bench/` 目錄存在 `bench-run.ego.js` 與 `bench-server.mjs`，屬 A/B 基準流程；操作前先閱讀該二檔內容確認埠與路徑（本手冊僅列出其存在，不保證與 smoke 相同的啟動方式）。

## 5. 除錯

### 5.1 健康檢查

```bash
curl -fsS --max-time 2 http://127.0.0.1:9772/health
# 預期：{"ok":true,"chrome":true}
# alt-port 環境改打 9774
```

`"chrome":false` 或連線失敗代表 daemon 沒接上 Chrome CDP，往下查 §5.3。

### 5.2 日誌位置

| 平台 | 檔案 |
|---|---|
| macOS/Linux | `~/.local/share/ego-linux/logs/daemon.log`、`logs/chrome.log`（`tp-start.sh` redirect） |
| Windows | 依 `ego-start.ps1` 的啟動方式；先以 `tp-browser status` 與程序清單確認 |

常見可從日誌確認的訊息：

- `[ego-browserd] store load failed, starting fresh: …` → TaskSpace ledger JSON 損壞，daemon 以空 ledger 繼續（見 §5.4）。
- `[ego-browserd] handler error: …` → CDP 事件處理器拋錯（不會中斷 daemon）。

### 5.3 常見故障與處置

| 症狀 | 原因 | 處置 |
|---|---|---|
| `TP_NOT_READY`（10 秒輪詢失敗） | Chrome 沒起來、CDP 埠不通、profile 鎖 | 看 `logs/chrome.log`；`tp-stop` 後 `tp-start --restart`（腳本會清 `SingletonLock/Cookie/Socket`）；確認埠 9772/9773 未被占用（`ss -ltnp`／`netstat -ano`） |
| `ERROR: No Chrome/... binary found` | 探測不到瀏覽器 | 安裝任一支援瀏覽器，或 `export TP_BROWSER_BIN=/path/to/chrome` 後重跑 |
| `/health` 回 `chrome:false` | daemon 活著但 CDP 斷線（Chrome 被手動關閉／崩潰） | `tp-start --restart` |
| EADDRINUSE / 埠衝突（WSL2 mirrored） | Windows 原生版與 WSL2 版搶埠 | WSL2 側改用 `tp-start --alt-port`（9774/9775） |
| `spaces` 等 RPC 回 401／認證錯誤 | `~/.local/share/ego-linux/token` 缺失或 daemon 重生 token | `tp-start --restart`（重啟流程會 chmod 600 token 與 daemon.json）；CLI 會自動讀 token，不需手動傳 |
| WSL2 `--headed` 沒開視窗 | 找不到 Windows 側 ego-linux 安裝 | 確認 `/mnt/c/Users/*/.local/share/ego-linux/scripts/ego-start.ps1` 存在；否則在 Windows 側先跑 `install.cmd` |
| ledger 相關 TypeError | ledger JSON 被手動編輯成缺欄位形狀（`{}` 等） | 目前無自動修復；最保守作法：停服務後把該 ledger 檔改名備份再重啟（daemon 會從空 ledger 開始；TaskSpace 記錄會遺失，Chrome 分頁不受影響）。永久解法見 ROADMAP 項目 5 |
| 跨站請求被拒 | daemon 防 DNS rebinding／CSRF（`Host` 非 `127.0.0.1` 或帶 `Origin`） | 一律用 `http://127.0.0.1:...` 直連，不帶 `Origin` 標頭 |

### 5.4 診斷工具

```bash
tp-browser doctor    # 完整健檢與修復指引（README 宣稱之指令）

# TaskSpace ledger 乾跑回收診斷（唯讀，不刪任何東西）：
# spaces 來源可用 tp-browser spaces 的輸出；liveTargetIds 來源可查
# http://127.0.0.1:9773/json/list 中 type === "page" 的 id
node fmb_feature2/cli.js <<'JSON'
{ "spaces": [ { "id": 1, "createdAt": "2026-01-01T00:00:00.000Z", "pages": { "p1": { "targetId": "T-live" } } } ], "liveTargetIds": ["T-live"] }
JSON
```

Chrome CDP 直接檢查：

```bash
curl -fsS http://127.0.0.1:9773/json/version   # Chrome CDP 是否活著（alt: 9775）
curl -fsS http://127.0.0.1:9773/json/list      # 分頁 / target 清單
```

### 5.5 完全重置（最後手段）

```bash
tp-stop
# 以下會清除登入態，執行前自行評估：
rm -rf ~/.local/share/ego-linux/profile-agent
./install.sh   # 重建 runtime 與空 profile
tp-start
```

## 6. 安全操作要點

1. **絕不**把 `token`、`cookies.json`、`profile-agent/` 內容貼進 issue、日誌或文件；測試示例一律用 `FAKE_VALUE_FOR_TEST`。
2. 所有請求只走 `127.0.0.1`；不要把埠轉發到區網或公網。
3. 多人共用主機不適用本工具的信任模型（單一 OS 使用者假設）；需用獨立 OS 帳號隔離。
4. 測試不連正式服務：一律 `tests/serve.mjs`（`127.0.0.1:8899`）＋ `os.tmpdir()` 暫存。
5. 截圖／下載／上傳路徑由 daemon `safePath`（`realpathSync.native`）邊界檢查；不要繞過 CLI 直接對 daemon 傳 repo 外路徑。

## 7. 相關文件

- 架構：`docs/fmb/ARCHITECTURE.md`；路線圖：`docs/fmb/ROADMAP.md`
- API：`docs/fmb-api/`（cli.md／sdk.md／http-api.md）
- 可觀測性（含敏感欄位規格）：`docs/fmb-observability/sensitive-fields.md`
- 安全稽核：`docs/fmb-security/AUDIT.md`、`CHECKLIST.md`
- Ledger 回收：`fmb_feature2/README.md`
