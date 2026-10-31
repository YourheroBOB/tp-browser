# tp-browser 維運 Runbook

## 1. 文件目的與適用範圍

本文件提供 `tp-browser` 在 Windows、Linux 與 macOS 的安裝、部署、日常操作、健康檢查、故障排除、回滾及監控建議。

適用對象為：

- 執行安裝與升級的維運人員。
- 接手服務事故的第一線人員。
- 核准變更、監控政策與資料保留政策的負責人。

安全邊界：

- Daemon 與瀏覽器 CDP 應只綁定本機回環位址。
- 不得將 CDP、Daemon 或 Agent Skill 透過反向代理、連接埠轉發或公開網路服務暴露。
- 本文件不記錄認證秘密、瀏覽紀錄、Cookie、登入資料、客戶資料或其他敏感內容。
- 診斷與測試應使用本機服務及本機測試頁，不應操作正式外部服務。

## 2. 版本與變更基準

目前審閱的程式碼存在兩種版本來源：

- `package.json` 的套件版本：`0.3.0`。
- CLI `tp-browser version` 的執行期版本：`0.3.1`。

部署時應記錄以下資訊，以確認主機實際執行的是哪個版本：

```bash
git rev-parse HEAD
node --version
tp-browser version
```

Windows PowerShell 亦可執行相同的 `git rev-parse HEAD` 與 `node --version`。

在版本來源統一前，以 `tp-browser version` 顯示的執行期版本作為主機實際版本；不得只依 `package.json` 判斷。升級前應在乾淨的本機 clone 中取得並審閱指定的已知良好版本，不應直接部署遠端最新分支。

## 3. 系統架構

| 元件 | 程式路徑 | 職責 |
|---|---|---|
| 主要 CLI | `bin/tp-browser.js` | 啟停服務、狀態檢查、執行 Agent JavaScript |
| 相容 CLI | `bin/ego-browser.js` | `tp-browser` 的相容別名 |
| Daemon | `daemon/tp-browserd.js`、`daemon/ego-browserd.js` | 提供本機 HTTP、SSE 與 CDP 協調 |
| SDK | `lib/sdk.js` | 提供 TaskSpace、Page 等 Agent API |
| Chromium 類瀏覽器 | 系統安裝的 Chrome、Edge、Brave 或 Chromium | 透過 CDP 提供頁面控制 |
| 瀏覽器 Profile | `profile-agent` | 保存本機瀏覽狀態與工作階段 |
| 工作空間狀態 | Daemon 管理的資料目錄 | 保存 TaskSpace 與分頁對應 |
| 本機執行期資料 | 資料目錄內的認證與連線 metadata | 讓 CLI 找到正確的本機服務 |
| 日誌 | 資料目錄內的 `logs` | 保存 Daemon 與 Chromium 啟動／執行訊息 |

### 3.1 預設與備援連接埠

| 模式 | Daemon | CDP | 啟用方式 |
|---|---:|---:|---|
| 預設 | `9772` | `9773` | `tp-start` |
| 備援 | `9774` | `9775` | `tp-start --alt-port` 或 Windows `-AltPort` |

注意：

- Windows 啟動器會偵測 `9773` 上的 CDP 是否由 Linux 使用者代理提供；若是，會自動選擇備援連接埠。
- Unix/macOS 的備援連接埠需明確指定。
-  systemd 範例服務使用固定連接埠，不支援 `--alt-port`；若要使用備援連接埠，應先建立經核准的使用者服務覆寫。
- 所有連接埠均應只監聽 `127.0.0.1`。

## 4. 安裝前檢查

### 4.1 必要條件

- Node.js `22` 或以上。
- 至少一種受支援的 Chromium 類瀏覽器：Chrome、Edge、Brave 或 Chromium。
- Unix／macOS：POSIX shell、`curl`、基本檔案工具及 `git`。
- Windows：Windows PowerShell、Node.js、`git`，以及可執行安裝指令的管理員或一般使用者權限。
- 執行本機帳號應有權限寫入安裝資料目錄及專用 Profile。

本專案沒有 npm 執行期相依套件，正常安裝不需要執行 `npm install`。

### 4.2 安全與環境要求

- 共用主機應使用專屬作業系統帳號，避免不同使用者共用同一個 `profile-agent`。
- 同一個 Profile 不應同時啟動多個 TP Browser 實例。
- 安裝器可能從本機既有瀏覽器 Profile 初始化書籤、圖示、登入資料、Cookie、Local Storage 或 IndexedDB。共用工作站部署前應先確認此行為符合資料治理要求。
- Profile、認證檔與日誌均視為敏感資料，只允許服務帳號及獲授權的維運人員存取。
- 不應把 Profile、Cookie、認證檔或未去除敏感資訊的日誌上傳至 issue、聊天或郵件。

### 4.3 部署前檢查表

1. 確認目前分支、commit 與變更內容。
2. 確認 Node.js 版本。
3. 確認瀏覽器可執行。
4. 確認預設或備援連接埠沒有其他服務占用。
5. 停止同一 Profile 的既有 TP Browser 實例。
6. 依「[日常操作、監控與回滾](operations.md)」建立受保護的本機備份。
7. 記錄部署前 `tp-browser status` 與 `tp-browser version` 結果。

## 5. 安裝與部署

### 5.1 Linux／macOS

應在本機、已審閱的 repository clone 根目錄執行：

```bash
chmod +x ./install.sh
./install.sh
```

安裝器會：

- 將執行期程式放到使用者資料目錄的 `app` 子目錄。
- 建立 `profile-agent`、`logs` 等本機目錄。
- 在使用者 `PATH` 應包含的 `~/.local/bin` 建立 CLI 與啟動器連結。
- 嘗試安裝通用的 Agent Skill。
- 複製既有瀏覽器 Profile 資料時，僅在本機進行。

確認使用者 `PATH` 已包含 `~/.local/bin`，再開啟新的登入 shell，避免沿用舊環境：

```bash
command -v tp-browser
tp-browser version
```

啟動與檢查：

```bash
tp-start
tp-browser status
tp-browser doctor
```

預期啟動器會回報 `TP_READY`，`tp-browser status` 顯示 Daemon 正常且 `chrome` 為 `true`。

macOS 使用相同安裝器，但目前安裝器不會自動建立 macOS 登入啟動項目。需要自動啟動時，應使用主機既有的、經核准的 LaunchAgent 或等效機制。

### 5.2 Linux systemd user service（選用）

`tp-start` 與 systemd user service 應擇一使用，避免同一連接埠或 Profile 被重複啟動。

先完成 `install.sh`，再於本機 clone 根目錄執行：

```bash
mkdir -p ~/.config/systemd/user
cp scripts/ego-linux-chrome.service scripts/ego-linux-browserd.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now ego-linux-chrome.service ego-linux-browserd.service
```

檢查：

```bash
systemctl --user status ego-linux-chrome.service ego-linux-browserd.service --no-pager
tp-browser status
```

注意：

- 範例 Chromium unit 指向固定的 Chromium 路徑與預設 CDP 連接埠；安裝位置不同或需備援連接埠時，應建立經核准的 unit 覆寫。
- 必須以同一個 OS 使用者啟動 service 與 CLI。
- systemd user service 需要可用的使用者 session；常駐主機應依既定維運政策設定 user linger。

### 5.3 Windows

在已審閱的 repository clone 根目錄執行：

```powershell
.\install.cmd
```

`install.cmd` 會委派給 `install.ps1`。安裝器會：

- 將執行期程式安裝至使用者的本機資料目錄。
- 建立 `tp-browser.cmd`、`tp-start.cmd`、`tp-headed.cmd`、`tp-stop.cmd` 等 wrapper。
- 將使用者 bin 目錄加入 User `PATH`。
- 在 Windows Startup 資料夾建立自動啟動 launcher。
- 嘗試啟動服務並執行版本、狀態檢查。

安裝後開啟新的 PowerShell 視窗，再確認：

```powershell
Get-Command tp-browser
tp-browser version
tp-browser status
tp-browser doctor
```

若瀏覽器安裝在非標準位置，應透過已列出的環境變數指定受支援的瀏覽器執行檔，再重新執行啟動流程。

### 5.4 有頭與無頭模式

- 無頭模式：適合常駐服務與 Agent 操作。
- 有頭模式：適合需人工操作瀏覽器介面的工作階段。
- 切換前先停止其他使用相同 Profile 的實例，避免 Chrome Profile 鎖定。
- Windows 的工作階段 `0`、SSH 工作階段或无人登入的桌面可能無法顯示有頭視窗；此時應回到可互動的登入工作階段執行，而不是降低安全設定。

## 6. 部署後驗證

### 6.1 基本健康檢查

```bash
tp-browser status
tp-browser doctor
```

驗收條件：

- Daemon health 顯示 `ok` 為 `true`。
- `chrome` 顯示 `true`。
- CDP 版本端點可回應。
- 程序只監聽本機回環位址。

### 6.2 本機端到端冒煙測試

冒煙測試使用 repository 內的靜態測試伺服器與測試頁，不應連線至正式外部服務。

在 repository 根目錄的第一個終端機執行：

```bash
node tests/serve.mjs
```

在第二個終端機執行：

```bash
tp-browser nodejs < tests/smoke.ego.js
```

預期結果：

```text
== smoke: 23/23 pass ==
ALL_GREEN
```

測試完成後停止本機測試伺服器。測試失敗時，先保存去敏感資訊的錯誤摘要，再依「[故障排除](troubleshooting.md)」處理；不得將測試頁內容或瀏覽紀錄貼入公開 issue。

### 6.3 部署驗收清單

- [ ] 使用指定的本機 clone 與 commit。
- [ ] Node.js 版本符合要求。
- [ ] 瀏覽器版本與安裝位置已記錄。
- [ ] 安裝、啟動與停止命令可重複執行。
- [ ] `tp-browser status` 同時顯示 Daemon 與 Chromium 正常。
- [ ] `tp-browser doctor` 沒有未處置的錯誤。
- [ ] 本機冒煙測試全數通過。
- [ ] 連接埠只綁定本機回環位址。
- [ ] 自動啟動機制符合平台政策。
- [ ] Profile、認證檔與日誌權限已驗證。
- [ ] 備份與回滾版本已確認可用。

## 7. 延伸文件

- [日常操作、監控與回滾](operations.md)
- [常見故障排除](troubleshooting.md)
