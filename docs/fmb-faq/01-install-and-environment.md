# 01 · 安裝與環境（Install & Environment）

## Q1. `install.sh`／`install.ps1` 到底裝了什麼、裝到哪裡？

- **問題**：不清楚安裝器做了哪些事、檔案落在哪。
- **原因**：安裝器會複製多個目錄、建立符號連結／wrapper、安裝 Agent Skill，並可能自動啟動服務。
- **解法**：
  - macOS/Linux：安裝至 `~/.local/share/ego-linux/app`，並在 `~/.local/bin` 建立 `tp-browser`、`tp-browserd`、`tp-start`、`tp-headed`、`tp-stop`（與 `ego-*` 別名）的符號連結；若 `/usr/local/bin` 可寫也會連一份。
  - Windows：安裝至 `~/.local/share/ego-linux` 與 `~/ego-linux-install`，在 `~/.local/bin`、`~/bin` 產生 `.cmd` 與 sh wrapper，並於 Startup 資料夾建立 `tp-browser-autostart.vbs` 開機自啟。
  - 兩平台皆會把 `skills/tp-browser/SKILL.md` 複製到 `~/.claude/skills`、`~/.agents/skills`、`~/.codex/skills` 等目錄（tp-browser 與 ego-browser 兩個名稱）。
- **相關檔案**：`install.sh`、`install.ps1`、`install.cmd`

## Q2. 需要哪個 Node.js 版本？Node 20 可以用嗎？

- **問題**：執行時出現 WebSocket 相關錯誤，或不確定版本需求。
- **原因**：本專案 0 npm 依賴，使用 Node 原生 `WebSocket` 連 CDP；`package.json` 宣告 `engines: node >=22`。
- **解法**：
  - 正式支援基線為 **Node.js >= 22**（原生 WebSocket 不需旗標）。
  - Node 20 屬舊世代相容路徑：安裝器產生的 wrapper 都帶 `--experimental-websocket`，README 亦描述此路徑；但 `docs/fmb-upgrade/` 已建議不再把 Node 20 列為正式支援環境，升級前請先閱該目錄。
- **相關檔案**：`package.json`、`install.sh`、`install.ps1`、`docs/fmb-upgrade/README.md`

## Q3. `tp-start` 印出「找不到 Chrome/Chromium/Edge/Brave」怎麼辦？

- **問題**：Linux/macOS 出現 `ERROR: No Chrome/Chromium/Edge/Brave binary found`；Windows 出現 `ERROR: No Chrome or Edge binary found`。
- **原因**：啟動器只偵測固定清單中的瀏覽器安裝路徑（macOS 的 `/Applications`、Linux 的 `google-chrome`／`chromium` 等、Windows 的 Program Files 與 LOCALAPPDATA 常見位置）。若你的瀏覽器裝在非標準位置，會偵測不到。
- **解法**：用環境變數 `TP_BROWSER_BIN` 指定瀏覽器執行檔的完整路徑，例如：

  ```bash
  TP_BROWSER_BIN=/opt/my-chrome/chrome tp-start
  ```

  Windows PowerShell 可用 `$env:TP_BROWSER_BIN = "C:\path\to\chrome.exe"` 後再執行 `tp-start`。
- **相關檔案**：`scripts/tp-start.sh`、`scripts/ego-start.ps1`

## Q4. 安裝完成後打 `tp-browser` 卻說 command not found？

- **問題**：終端機找不到 `tp-browser`／`tp-start` 等指令。
- **原因**：`~/.local/bin`（或 Windows 的 `~/.local/bin`、`~/bin`）不在 `PATH` 中。
- **解法**：
  - Linux/macOS：把 `export PATH="$HOME/.local/bin:$PATH"` 加進 shell 設定檔，或直接以完整路徑執行 `~/.local/bin/tp-browser`。
  - Windows：`install.ps1` 會把兩個 bin 目錄寫入 User PATH，但**已開啟的終端機不會自動更新**，請重開終端機（或登出登入）。
- **相關檔案**：`install.sh`、`install.ps1`

## Q5. Windows 上執行 `install.cmd`／PowerShell 腳本被執行原則擋住？

- **問題**：出現「無法載入指令碼，因為這個系統上已停用指令碼執行」之類訊息。
- **原因**：系統 PowerShell 執行原則（ExecutionPolicy）限制未簽署腳本。
- **解法**：本 repo 的 `install.cmd` 與所有 wrapper 都以 `-NoProfile -ExecutionPolicy Bypass` 呼叫 PowerShell，正常情況不會被擋；若你手動執行 `.ps1`，請仿照相同參數：

  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\ego-start.ps1
  ```

  不建議為此永久放寬全系統執行原則。
- **相關檔案**：`install.cmd`、`install.ps1`、`scripts/ego-start.ps1`

## Q6. `tp-browser version` 顯示 0.3.1，`package.json` 卻是 0.3.0？

- **問題**：版本號對不起來，不知道以哪個為準。
- **原因**：CLI 的 `version` 指令是寫死的字串 `0.3.1`，與 `package.json` 的 `0.3.0` 尚未統一（`docs/fmb-api/README.md` 已記錄此落差）。
- **解法**：以 **0.3.x 的介面行為**為準做相容判斷；正式發行前應由維護者統一版本號。這是文件已知的待辦，不需使用者處理。
- **相關檔案**：`bin/ego-browser.js`、`bin/tp-browser.js`、`package.json`、`docs/fmb-api/README.md`
