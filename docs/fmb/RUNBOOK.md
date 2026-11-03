# tp-browser 操作手冊（RUNBOOK）

> **文件狀態**：依 repo 既有程式碼實際內容撰寫的 as-is 操作步驟。所有指令皆出自 `install.sh`／`install.ps1`／`scripts/*`／`tests/*`／README 可確認的行為。  
> **安全邊界**：本文不含任何實際 token、金鑰、密碼、客戶資料或案件內容；示例憑證一律使用 `FAKE_VALUE_FOR_TEST`。  
> **重要**：所有服務僅綁 `127.0.0.1`，只應在單一使用者個人電腦／專屬工作站上操作。

## 1. 前置需求

| 項目 | 需求 |
|---|---|
| Node.js | `>=22`（`package.json` `engines`；`daemon/cdp.js` 使用內建 WebSocket）。安裝器產生的 wrapper 仍帶 `--experimental-websocket` |
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
5. 截圖／下載／上傳路徑由 daemon `safePath` 檢查：必須是絕對路徑、拒絕 `..` 與 `.` 片段，存在的路徑或父目錄會再經 `realpathSync.native`。沒有限在 repo 內的邊界（`tests/smoke.ego.js` 寫入 `/tmp/ego-linux-smoke.png`）。

## 7. 相關文件

- 架構：`docs/fmb/ARCHITECTURE.md`；路線圖：`docs/fmb/ROADMAP.md`
- API：`docs/fmb-api/`（cli.md／sdk.md／http-api.md）
- 可觀測性（含敏感欄位規格）：`docs/fmb-observability/sensitive-fields.md`
- Ledger 回收：`fmb_feature2/README.md`
<<<FILE fmb_feature2/README.md>>>
# fmb_feature2 — TaskSpace ledger 自動回收器（Reaper）

> 本目錄為**獨立新增**的改進提案，**未修改任何既有檔案**。所有程式碼可獨立執行測試，
> 不連線任何網路服務、不讀寫 repo 以外的路徑（測試僅使用 `mkdtempSync(tmpdir())`）。

## 1. 為什麼挑這一項（不是最顯眼的第一項）

`README.md` 提到的 cookie 匯出／匯入工具是「最顯眼的第一項」，已留給另一個 agent。
本輪改動選擇的是**次高價值、但沒有人提到、且長期一定會發生的運維債**：`daemon/store.js`
的 ledger 在同一次 Chrome 連線期間只增不減（`attachChrome()` 後的 `rebindSpaces()` 會清掉失效 target，但不會依閒置時間回收）。

證據（純粹由既有程式碼推得，不需臆測）：

1. `Store` 有 `create` / `addPage` / `bindPage` / `setPage` / `nextLabel`，以及 `deleteSpace` / `removePage`。
   `daemon/ego-browserd.js` 的 `rebindSpaces()` 在每次 `attachChrome()` 成功後會刪掉 `targetId` 不在 `hub.sessions` 的分頁（`targetId` 為 null 也會刪），空間沒有分頁就 `store.deleteSpace`。
   這不是依閒置時間的回收；`removePage` 在這條路徑沒有被呼叫。
2. `Store.create()` 每次呼叫 agent 的 `taskSpace("...")` 就新增一筆記錄，
   連一個從未導航過的 `p1`（`targetId: null`）也會被寫進 ledger，直到下一次 `rebindSpaces()`。
3. 同一次 Chrome 連線期間，使用者手動關掉分頁之後，ledger 裡的 `targetId` 仍留著，`title` / `url` 也停在舊值。
   Chrome 重啟並重新 `attachChrome()` 時，`rebindSpaces()` 會清掉這些已失效分頁與空空間。
   目標仍存活、只是閒置的空間不會被這條路徑收掉。
4. `persist()` 每次都把**整份** JSON 原子寫回檔案，ledger 越大，每次開分頁的寫檔成本越高。

換句話說：背景常駐（`tp-start`、systemd user service）在同一次 Chrome 連線中 ledger 只增不減，
跑一週後 `space.list` 仍會夾著這段期間已關掉的分頁。這是「單 Turn 批次 JS、省 Token」這個賣點的反向耗損。

## 2. 這個模組做什麼

`reaper.js` 提供兩個純函式與一個分類器：

| 匯出 | 用途 |
|---|---|
| `classifySpace(space, { liveTargets, now, policy })` | 把單一空間分類成 `live` / `dead` / `unbound` / `mixed` / `empty`，並算出 `ageMs` / `idle` 與分頁清單 |
| `planReap({ spaces, liveTargetIds, now, policy, protect })` | 算出回收計畫：`closeSpaces`、`dropPages`，加碼唯讀診斷 `staleActiveTargets` 與 `stats` |
| `applyReapPlan(store, plan)` | 透過既有的 `store.deleteSpace` / `store.removePage` 套用計畫；方法不存在時是安全 no-op |

**它不會自己做任何刪除**：決定與執行分離，所以可以先乾跑、先觀察、再開自動化。

### 回收規則

| 情境 | 動作 |
|---|---|
| 空間內至少一個分頁的 `targetId` 仍在 live 集合 | 視為 `live`，**永不關閉**；只清掉同期已失效的分頁記錄 |
| 空間所有已綁定分頁都失效（`dead`） | 立即關閉（`policy.reapDeadSpaces`，預設 `true`） |
| 空間沒有任何存活分頁且閒置 ≥ `policy.idleSpaceMs`（預設 30 分鐘） | 關閉 |
| 僅有未綁定佔位分頁（`p1: { targetId: null }`）且未閒置 | 保留（剛建立的空間） |
| `pinned: true` 或列入 `protect` 的空間 | **不關閉、也不丟棄任何分頁** |
| 空間數超過 `policy.maxSpaces`（預設 50） | 從最舊的「非存活、非受保護」空間開始回收；存活空間永不因上限被犧牲 |

### 兩道保守安全閥（刻意的設計決策）

1. **live 集合為空 → 完全不動作**（`reason: 'no-live-targets'`）。
   傳入的 live 集合為空時直接不回收。Chrome 沒起來時 `GET /json/list` 會失敗，不該把失敗當成空清單再拿去回收；若照常回收，整份 ledger 會被誤清。
   真的要在離線狀態下整理 ledger，才顯式設 `policy.reapIdleWhenNoLiveTargets: true`。
2. **`createdAt` 無法解析 → 不判定閒置**（`ageMs: null`）。
   寧可漏收，不可誤刪。

## 3. 整合方式（不修改既有檔案也能先上線）

### 3.1 乾跑：先看計畫，什麼都不刪

```bash
node fmb_feature2/cli.js <<'JSON'
{
  "spaces": [
    { "id": 1, "createdAt": "2026-01-01T00:00:00.000Z", "pages": { "p1": { "targetId": "T-live" } } },
    { "id": 2, "createdAt": "2026-01-01T00:00:00.000Z", "pages": { "p1": { "targetId": "T-gone" } } }
  ],
  "liveTargetIds": ["T-live"]
}
JSON
# => { "closeSpaces": [2], "dropPages": [], "staleActiveTargets": [], "stats": { ... } }
```

要接真實環境的資料，把兩邊餵進來即可（皆為唯讀查詢）：

- `spaces`：`store.list()`（或 `tp-browser spaces` 的輸出）
- `liveTargetIds`：Chrome 的 `GET http://127.0.0.1:9773/json/list` 中 `type === "page"` 的 `id`，
  或既有 CDP client 的 `Target.getTargets` → `targetInfos`
- `now`：選填，蓋掉 `Date.now()` 以便重現測試

### 3.2 掛進 daemon（未來正式整合的建議位置）

在 `daemon/ego-browserd.js` 的 `attachChrome()` 成功之後加一個低頻計時器即可
（未接上時每 3 秒重試 `CHROME_VERSION_URL`，斷線後 2 秒重連；連上後沒有 target 輪詢）。
**本目錄不修改該檔，示範如下**：

```js
import { planReap, applyReapPlan } from '../fmb_feature2/reaper.js';

setInterval(async () => {
  let liveTargetIds = [];
  try {
    const r = await fetch('http://127.0.0.1:9773/json/list', { signal: AbortSignal.timeout(2000) });
    liveTargetIds = (await r.json()).filter((t) => t.type === 'page').map((t) => t.id);
  } catch {
    return; // Chrome 不在線：直接跳過，絕不在空集合下回收
  }
  const plan = planReap({
    spaces: store.list(),
    liveTargetIds,
    policy: { idleSpaceMs: 30 * 60 * 1000, maxSpaces: 50 },
  });
  if (plan.closeSpaces.length || plan.dropPages.length) {
    applyReapPlan(store, plan);
    console.error(`[reaper] ${JSON.stringify(plan.stats)}`);
  }
}, 60 * 1000);
```

建議上線節奏：先把 `policy` 設成 `{ idleSpaceMs: 6 * 60 * 60 * 1000, maxSpaces: 500 }` 只觀察
`stats` 一週，確認沒有誤收再放寬。

### 3.3 何時**不要**開自動回收

- 需要保留歷史紀錄做稽核（TaskSpace 的 `title` / `url` 是唯一的分頁軌跡）→ 關閉自動回收，
  或先把 ledger 歸檔。
- 同一台機器上多個 agent 共用 daemon，且以「空間存在」作為跨程序鎖 → 先加 `pinned: true`。

## 4. 測試

```bash
node --test fmb_feature2/
```

| 檔案 | 內容 |
|---|---|
| `reaper.test.js` | 純函式單元測試：分類、閒置判定、兩道安全閥、`maxSpaces` 上限、決定性排序、非法輸入、`applyReapPlan` 行為 |
| `store-integration.test.js` | 直接使用真實 `daemon/store.js` 的 `Store`（ledger 寫在 `mkdtempSync(tmpdir())` 內），驗證回收後檔案內容、存活空間資料完整、冪等性、空 live 集合時 ledger 原封不動 |
| `cli.test.js` | 以 `spawnSync(process.execPath, ...)` 餵 stdin，驗證乾跑 CLI 的輸出與退出碼 |

測試特性：**零外部依賴、零網路、零正式服務連線、零真實憑證**；所有暫存檔在 `after()` 清除。

## 5. 已知限制與後續

- `Store` 目前沒有 `lastUsedAt`。本模組用 `createdAt` 當閒置基準（保守且不改既有 schema）。
  未來若 `Store` 新增 `lastUsedAt` 並在使用時更新，建議改以 `lastUsedAt` 為準（`activeTargetId` 已由 `create()` 寫入，目前不是閒置基準）。
- 本模組只處理 ledger，**不會主動關閉 Chrome 端仍在的分頁**。若需要「關閉分頁」，
  應由 daemon 以 CDP `Target.closeTarget` 處理，屬另一項改動。
- `staleActiveTargets` 只做診斷輸出，不會另外清掉 `space.activeTargetId`。
  `Store.removePage` 只在被刪分頁的 `targetId` 等於 `activeTargetId` 時把該欄設成 null（`daemon/store.js`）；沒有 `clearActiveTarget()`。
- 未處理「同名空間重複建立」與「同一 URL 多分頁去重」，避免語意過度擴張。

## 6. 決策點（本次自行拍板，留給 BOB 覆核）

1. **預設 30 分鐘閒置即回收**：偏向「常用 agent 工作流節奏」，而非「保留完整歷史」。
2. **`reapDeadSpaces` 預設開啟**：Chrome 重啟後，指向已消失 target 的空間直接回收（視為雜訊）。
   若 BOB 想保留跨重啟的分頁軌跡，把它設為 `false`。
3. **`maxSpaces` 預設 50**：只作為失控保護，正常使用不會觸發。
4. **live 集合為空時完全不動作**：以「安全閥優先於回收率」為原則。
5. **受保護空間連失效分頁都不清**：`pinned` / `protect` 是「完全不要碰」的語意，避免半套清理造成狀態不一致。
6. **實作放在獨立目錄而非改 `daemon/`**：依本次任務硬性規則（只能新增），
   整合方式以文件與可直接 import 的模組呈現，待 BOB 同意後再移入 `daemon/`。
<<<FILE skills/tp-browser/SKILL.md>>>
---
name: tp-browser
description: TooPower Browser (tp-browser / ego-browser) — 強到沒朋友 | Zero-dependency Human-Agent Shared Browser for Windows, Linux, and macOS. When you need a browser, read this Skill by default. Use it to open and operate websites, extract lazy-loaded pages, interact with logged-in web apps, handle Cloudflare/2FA/OAuth via Human-Agent Co-Riding (tp-headed / ego-headed), or run multi-step browser automation in a single LLM turn (saving 90%+ tokens vs Playwright MCP / Computer Use).
---

# TooPower Browser (`tp-browser` / `ego-browser`) — Agent Skill Guide

> **Slogan**: 「TooPower — 強到沒朋友」
> **Author**: 嚴柏顯律師（市井律師BOB-嚴律｜弘人法律事務所）— [YouTube @YourHeroBob](https://www.youtube.com/@YourHeroBob)
> **Repository**: https://github.com/YourheroBOB/tp-browser (Apache-2.0)

## 🔴 GOLDEN RULE FOR AI AGENTS: Launch the Browser Yourself!
1. **NEVER ask the human user to manually launch Chrome, `tp-headed`, or `ego-headed`!** You have direct shell commands to pop up the visible GUI browser window on any desktop yourself (even over Windows OpenSSH Session 0, which `tp-headed` automatically bridges to the interactive desktop Session 1).
2. **`tp-browser` and `ego-browser` are 100% interchangeable aliases** across macOS, Windows (`rog`, `pc`), and Linux (`abacus`, WSL2):
   - Need **background headless** browsing? Just run `tp-browser nodejs << 'EOF' ...` (it **auto-starts** headless mode if not running!) or explicitly run `tp-start` (`ego-start` / `tp-browser start`).
   - Need a **human-visible GUI Chrome window** on the screen (so the user can log in, pass 2FA/Captcha, or watch)? Run **`tp-headed`** (or `ego-headed` / `tp-browser headed` / `ego-browser headed`) yourself!
   - If the GUI browser window is **already open** on the user's desktop, calling `tp-headed` is a safe no-op that preserves all open tabs.

---

## 1. Quick Lifecycle & Cross-Node SSH Commands

| Command | Alias | Purpose |
|---|---|---|
| `tp-headed` | `ego-headed` / `tp-browser headed` | **Open human-visible GUI Chrome window** on the desktop using `profile-agent` (1:1 synced Bookmarks, Favicons & Cookies + bottom-right `⚡ TooPower` Co-Riding capsule). Automatically breaks out of Windows SSH Session 0 into desktop Session 1! |
| `tp-start` | `ego-start` / `tp-browser start` | Start background **headless** daemon + Chrome (`127.0.0.1:9772/9773`, zero focus stealing). |
| `tp-stop` | `ego-stop` / `tp-browser stop` | Stop the `tp-browser` daemon and attached `profile-agent` Chrome cleanly. |
| `tp-browser status` | `ego-browser status` | Check JSON health (`{"ok":true,"chrome":true}`). |
| `tp-browser doctor` | `ego-browser doctor` | Diagnose daemon & Chrome CDP readiness across Windows (`tp-win`), Linux (`tp-linux`), and macOS (`tp-mac`). |

### Launching & Controlling Across Nodes (Mac / ROG / PC / Abacus)
- **On current local machine (Mac / Windows / Linux)**:
  - Pop up visible GUI browser: `tp-headed`
  - Run script: `tp-browser nodejs << 'EOF' ... EOF`
- **From Mac/PC targeting `ROG` Windows Desktop (`ssh rog`)**:
  - Pop up visible GUI browser on ROG desktop: `ssh rog "tp-headed"`
  - Run script on ROG: `ssh rog "tp-browser nodejs -e \"...\""` (or pipe via `ssh rog "tp-browser nodejs" << 'EOF'`)
- **From Mac/ROG targeting `PC` (`ssh pc`)**:
  - Pop up visible GUI browser on PC Windows desktop: `ssh pc "tp-headed"`
  - Run script on PC: `ssh pc "tp-browser nodejs" << 'EOF'`
- **Targeting `Abacus` (`ssh abacus`)**:
  - Run script on Abacus: `ssh abacus "~/usage-browser/bin/abx.mjs nodejs" << 'EOF'`

---

## 2. Core Pattern: Single-Turn Batch JS (`tp-browser nodejs`)

Traditional Playwright MCP / Computer Use tools operate 1 action per LLM turn (`goto` → full DOM snapshot → `scroll` → full DOM snapshot), burning millions of tokens.
With **`tp-browser nodejs`**, you submit a **complete async JavaScript workflow in a single Turn** via stdin Heredoc (`goto` + scroll loop to defeat lazy-loading + DOM extraction + file write), returning only the final clean output to stdout (**91.7% browser token savings**):

```bash
tp-browser nodejs << 'EOF'
const ts = await taskSpace("my-task");
const p = ts.page("p1");
try {
  await p.goto("https://example.com");
  await sleep(1000);

  // Scroll loop to defeat virtual scrolling / lazy-loading
  for (let i = 0; i < 5; i++) {
    await p.evaluate(() => window.scrollBy(0, 1500));
    await sleep(400);
  }

  const data = await p.evaluate(() => ({
    title: document.title,
    text: document.body.innerText.slice(0, 50000)
  }));
  console.log(JSON.stringify(data, null, 2));
} finally {
  // Close temporary tab when done (omit closePage if leaving login page open for human!)
  await ts.closePage("p1");
}
EOF
```

> **IMPORTANT when opening a login page for the human user**:
> 1. Run `tp-headed` (or `ssh rog "tp-headed"`) first so the GUI window is visible on the desktop.
> 2. In your `tp-browser nodejs` script, navigate `await p.goto("https://...")` and **do NOT call `ts.closePage("p1")`** in `finally` if you want the tab to stay open on screen for the human user to log in!

---

## 3. SDK Reference (Globals Available Inside `tp-browser nodejs`)

### TaskSpace & Tab Management
- `const ts = await taskSpace("name")` — Get or create an isolated TaskSpace (comes with default tab `"p1"`).
- `const p1 = ts.page("p1")` — Reference an existing labeled page in the TaskSpace.
- `const p2 = await ts.newPage()` — Open an additional tab (`p2`, `p3`, ...) in the TaskSpace.
- `await ts.tabs()` — List all open tabs in the TaskSpace.
- `await ts.closePage("p1")` / `await ts.finish({ keep: [] })` — Close a specific tab or finish the TaskSpace.

### Page Navigation & Extraction
- `await p.goto(url, { waitUntil: "load", timeout: 30000 })` — Navigate to URL.
- `await p.text({ maxChars: 100000 })` — Extract visible `document.body.innerText`.
- `await p.evaluate((arg) => { ... }, arg)` — Execute arbitrary JS in page context and return serializable result.
- `await p.snapshot()` — Get compact accessibility/DOM snapshot with `@N` interactive element refs.
- `await p.screenshot({ path: "/tmp/ego-linux-smoke.png" })` — Save a PNG. `daemon/ego-browserd.js` `safePath` requires an absolute path (`tests/smoke.ego.js` uses `/tmp/ego-linux-smoke.png`).

### Page Interactions
- `await p.click(selector)` — Supports CSS (`#id`, `.btn`), `@N` (`ref=N` from snapshot), `text=Submit`, `loc=role:button[name="Save"]`, `xpath=...`.
- `await p.fill(selector, value)` — Clear and fill an input/textarea.
- `await p.press(selector, "Enter")` / `await p.keyboard.press("Escape")` / `await p.keyboard.type("hello")`.
- `await p.mouse.click(x, y)` / `await p.mouse.wheel(0, 1200)`.
- `await p.setInputFiles("@N", ["/absolute/path/file.pdf"])` — Upload files to `<input type="file">`. Paths must be absolute (`safePath`).
- `await p.cdp(method, params)` — Direct Chrome DevTools Protocol call on the page target.

### Human-Agent Co-Riding (Handling Captcha / 2FA / Login / Account Switching)
1. When a page requires human login, OAuth (`az login`, `microsoft.com/devicelogin`, Google OAuth), or 2FA, run `tp-headed` yourself so the browser window opens visibly on the user's desktop.
2. Every tab includes a bottom-right **`⚡ TooPower`** Co-Riding Control Bar with **`[🧑 我要接手操控]`**, **`[🔄 換帳號]`**, and **`[🤖 完成並交還 Agent]`** buttons.
3. **Switching Cached SSO Accounts (`await p.resetSiteAuth()`)**: If a login page (e.g., Microsoft Azure / Live / Outlook / Google OAuth) automatically logs in with a wrong cached account (like an old Hotmail cookie causing `AADSTS50020` Access Denied), call `await p.resetSiteAuth()` (or ask the user to click **`[🔄 換帳號]`** in the bottom-right capsule) to clear only that site's SSO cookies/storage and force `prompt=select_account`.
4. Cookie Sovereignty: Export/import local cookies (including `HttpOnly`) via:
   - `tp-browser nodejs < tools/cookies-export.ego.js` (writes `~/.local/share/ego-linux/cookies.json`, or `TP_COOKIES_FILE` / `EGO_COOKIES_FILE`, mode `0600`; stdout is status JSON)
   - `tp-browser nodejs < tools/cookies-import.ego.js` (reads `TP_COOKIES_FILE` / `EGO_COOKIES_FILE` when that file exists, else `~/.local/share/ego-linux/cookies.json`, else `ego-cookies.json`, else `/tmp/ego-cookies.json`; cookie JSON is not read from stdin)

[ego-browser:skill] end of guide
