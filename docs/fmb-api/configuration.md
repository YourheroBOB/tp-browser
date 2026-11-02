# 設定項參考（環境變數、命令列旗標與路徑）

> 文件狀態：依據本次提供的 `scripts/tp-start.sh`、`install.sh`、`install.ps1`、`package.json` 與 `docs/fmb-api/README.md` 撰寫。
> 書寫規則（本任務硬性要求）：**只列設定項名稱，不寫入任何設定值**（埠號、路徑常值、預設值等一律不放）。需要實際值時，請改為在執行環境查詢或參考 `docs/fmb/ARCHITECTURE.md`。
> 安全邊界：本文不含任何 token、金鑰、密碼、客戶資料或案件內容。

## 環境變數

| 名稱 | 用途 | 來源 |
|---|---|---|
| `TP_BROWSER_BIN` | 覆寫瀏覽器執行檔；未設定或指向不可執行檔時，改走 `tp-start.sh` 內建探測順序 | `scripts/tp-start.sh` |
| `HOME` | 決定資料目錄與安裝目標的父路徑 | `scripts/tp-start.sh`、`install.sh`、`install.ps1` |
| `USERNAME` | Windows 安裝與 ACL 授權對象 | `install.ps1` |
| `USERPROFILE` | Windows 包裝腳本中的家目錄 | `install.ps1` |
| `Path`（User 層級） | Windows 安裝器會把使用者的 bin 目錄附加進去 | `install.ps1` |

## 命令列旗標

### 啟動腳本（`tp-start.sh`，別名 `tp-headed`）

| 旗標 | 用途 |
|---|---|
| `--headed`／`-Headed`／`headed` | 以有頭 GUI 模式啟動（供人工登入） |
| `--restart`／`-Restart`／`restart` | 先刷新再啟動（略過「已健康就沿用」的快捷路徑） |
| `--alt-port`／`-AltPort` | 改用替代埠組合（與預設埠組合並存） |

### Daemon（`daemon/tp-browserd.js`／`daemon/ego-browserd.js`）

| 旗標 | 用途 |
|---|---|
| `--alt-port` | 切換 daemon 與 Chrome 的埠組合 |

### Node.js 執行旗標

| 旗標 | 用途 |
|---|---|
| `--experimental-websocket` | 安裝器產生的包裝腳本統一附加；Node.js 22 起為原生能力，此旗標為相容舊版而保留 |

## 路徑與資料目錄名稱

以下為**名稱**（實際值因平台與安裝方式而異，本文不寫入數值）：

| 名稱 | 用途 |
|---|---|
| 資料根目錄（`~/.local/share/ego-linux`） | 所有本機狀態的父目錄；安裝時設為僅當前使用者可存取 |
| `app/`（安裝目錄） | 安裝器複製的 runtime（`bin`、`daemon`、`lib`、`scripts`、`tools`、`tests`、`docs`、`skills`） |
| `profile-agent/` | Chrome `--user-data-dir`（Cookies、登入態、書籤） |
| `logs/` | 啟動腳本重導向的 daemon／Chrome 輸出 |
| `token` | daemon 認證 token 檔（CLI 自動讀取；內容一律不得寫入文件） |
| `daemon.json` | daemon 記錄目前使用的埠組合 |
| TaskSpace ledger JSON | `Store` 持久化檔，格式見 `docs/fmb-api/module-store.md` |

## 已知未提供的設定項

下列項目在本任務提供的來源中**無法確認**，待補齊對應原始碼後再新增文件，不在本文推測：

- daemon 的其他環境變數與命令列旗標（`daemon/tp-browserd.js`、`bin/tp-browser.js` 原始碼未提供）。
- `lib/sdk.js`、`daemon/page-ops.js`、`daemon/inpage.agent.js`、`tools/profile-init.js` 的任何可調參數。
- systemd unit（`scripts/ego-linux-*.service`）可覆寫的環境變數——unit 檔內未宣告 `Environment=`。
- 埠號實際值：請查詢執行環境的 `daemon.json`，或參考 `docs/fmb/ARCHITECTURE.md`（本文件依規則不重複數值）。

## 相關文件

- CLI 指令與用法：`docs/fmb-api/cli.md`
- HTTP／SSE 端點與認證標頭：`docs/fmb-api/http-api.md`
- 啟動／停止流程與架構：`docs/fmb/ARCHITECTURE.md`、`docs/fmb/RUNBOOK.md`
- 升級與支援矩陣：`docs/fmb-upgrade/`
