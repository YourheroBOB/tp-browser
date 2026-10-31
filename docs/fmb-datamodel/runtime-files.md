# 執行期檔案與埠位配置

所有執行期檔案都位於單一資料根目錄：`$HOME/.local/share/ego-linux`（POSIX）或 `%USERPROFILE%\.local\share\ego-linux`（Windows）。本文件只描述**格式與欄位**，不含任何真實內容。

## 1. 檔案總覽

| 檔案／目錄 | 格式 | 權限 | 產生者 |
|---|---|---|---|
| `token` | 純文字（單行，尾端換行由讀取端 `trim()` 容忍） | `0600` | daemon（於 `tp-start`／`ego-start` 成功後 chmod） |
| `daemon.json` | JSON object | `0600` | daemon |
| `spaces.json` 類 ledger 檔（實際檔名由 daemon 決定） | JSON（見 [`ledger-store.md`](./ledger-store.md)） | 由 daemon 決定 | `daemon/store.js` |
| `profile-agent/` | Chromium user-data-dir | `0700`（根目錄） | 瀏覽器 + `tools/profile-init.js` |
| `logs/daemon.log`、`logs/chrome.log` | 純文字 append | — | 啟動腳本 |
| `cookies.json` | （schema 未在本 repo 可見檔案中定義，見 README 的匯出／匯入工具說明；**本文件不記載內容**） | `0600` | 匯出工具 |

## 2. `daemon.json`

CLI（`bin/ego-browser.js`）的讀取邏輯：

```json
{ "port": 9774, "chromePort": 9775 }
```

| 欄位 | 型別 | CLI 認得的值 | 說明 |
|---|---|---|---|
| `port` | integer | 僅 `9774`；**其他任何值（含缺檔／解析失敗）都回退 `9772`** | daemon HTTP 埠 |
| `chromePort` | integer | 僅 `9775`；其他回退 `9773` | Chromium CDP 埠 |

設計意義：daemon.json 是「alt-port 模式」的指示器，不是通用配置檔；CLI 刻意只認一組替代值。

## 3. `token`

- 單一 字串值，作為 `x-tp-token` / `x-ego-token` HTTP 標頭送出（兩個標頭都帶同一值）。
- 讀取端 `readFileSync(..., 'utf8').trim()`。
- 檔案不存在時 CLI 拋錯（訊息提示 daemon 是否在跑），**不會**自動產生。
- WSL2 有頭模式委派 Windows 端時，`tp-start.sh` 會把 Windows 端的 `daemon.json`／`token` 複製回 Linux 端資料根目錄並 chmod 600。

## 4. 埠位配置（程式碼常數）

| 埠 | 用途 | 綁定位址 |
|---|---|---|
| `9772` | daemon HTTP（預設） | `127.0.0.1` |
| `9773` | Chromium CDP（預設） | `127.0.0.1`（`--remote-debugging-address`） |
| `9774` | daemon HTTP（`--alt-port`） | `127.0.0.1` |
| `9775` | Chromium CDP（`--alt-port`） | `127.0.0.1` |

Windows 端 `ego-start.ps1` 的雙軌偵測：若 `http://127.0.0.1:9773/json/version` 的 `User-Agent` 含 `Linux`（表示 WSL2 版已佔用），自動改用 9774/9775。

## 5. profile-agent 內的 Chromium 原生檔案（`tools/profile-init.js` 觸及者）

| 檔案 | 格式 | 初始化行為 |
|---|---|---|
| `Default/Preferences` | JSON | 強制寫入下表欄位（淺補丁，保留其他鍵） |
| `Default/Bookmarks`、`Default/AccountBookmarks` | Chrome Bookmarks JSON（`roots.bookmark_bar.children` / `roots.other.children`） | 來源為本機既有瀏覽器 profile；目的檔無書籤時複製 |
| `Default/Favicons`（含 `-journal`/`-wal`/`-shm` sidecar） | SQLite | 缺失／過小／`--force` 時 1:1 複製並刪 sidecar |
| `Default/Login Data`、`Default/Login Data For Account`、`Default/Web Data` | SQLite | 目的小於來源一半或 `--force` 時複製（含刪 sidecar） |
| `Default/Network/Cookies`（Windows）或 `Default/Cookies`（POSIX） | SQLite | 來源 > 32KB 且目的 < 64KB 時複製，並同步 `Local State` 的 `os_crypt` |
| `Local State` | JSON | **僅合併** `os_crypt` 鍵到目的檔（保留其餘鍵） |
| `Default/Local Storage/leveldb/` | LevelDB | 目的 < 1.5MB 且 < 來源 30% 時逐檔複製（跳過 `LOCK`） |
| `Default/IndexedDB/https_*` 目錄 | IndexedDB LevelDB 結構 | 只補**不存在**的 origin，遞迴複製、過濾 `LOCK` |

### `Preferences` 被強制寫入的欄位

| 路徑 | 型別 | 寫入值 |
|---|---|---|
| `bookmark_bar.show_on_all_tabs` | boolean | `true` |
| `session.restore_on_startup` | integer | `1` |
| `profile.name` | string | 原值若為 `Person 1`／`第一位使用者`／空 則覆寫為品牌名（固定字串） |
| `profile.exit_type` | string | `"Normal"` |
| `profile.exited_cleanly` | boolean | `true` |
| `credentials_enable_service` | boolean | `true` |
| `credentials_enable_autosignin` | boolean | `true` |

> 這些皆為 Chromium 原生格式；tp-browser 不定義自己的 schema，僅做鍵值補丁與檔案層級同步。`os_crypt` 的結構由 Chromium 決定（與 OS 層金鑰保護相關），本文件不展開。
