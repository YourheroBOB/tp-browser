# CLI 指令參考

## 指令與別名

`package.json` 公開四個命令：

| 命令 | 實作 | 說明 |
|---|---|---|
| `tp-browser` | `bin/tp-browser.js` | 主要使用者 CLI |
| `ego-browser` | `bin/ego-browser.js` | 相容別名；目前提供相同介面 |
| `tp-browserd` | `daemon/tp-browserd.js` | 主要 daemon 命令 |
| `ego-browserd` | `daemon/ego-browserd.js` | 相容 daemon 命令 |

`tp-browser` 與 `ego-browser` 應視為同一命令介面。以下範例可將 `tp-browser` 換成 `ego-browser`。

## `tp-browser nodejs`

執行一段 Node.js Agent 腳本。程式碼可由 `-e` 提供，或由 stdin／heredoc 管道提供。

```bash
tp-browser nodejs -e 'console.log("local test")'
```

```bash
tp-browser nodejs <<'EOF'
const task = await taskSpace("local-example");
const page = task.page("p1");
await page.goto("http://127.0.0.1:8765/");
console.log(await page.snapshot());
await task.finish({ keep: [] });
EOF
```

### 簽名

```text
tp-browser nodejs [-e <code>]
```

### 行為

- `-e` 必須是第一個 script 參數；其後的程式碼會被當成腳本內容。
- 未使用 `-e` 時，CLI 從 stdin 讀取完整內容，直到 EOF。
- 腳本以 ESM 方式執行，可使用 top-level `await`。
- 開頭的 UTF-8 BOM 會被移除。
- 若 daemon 尚未健康運作，CLI 會先嘗試啟動背景瀏覽器。
- 腳本結束後，CLI 會清理暫存腳本並明確結束程序；這是必要的，因為 SSE 連線會讓事件迴圈保持運作。
- CLI 不接受腳本檔案路徑作為程式碼來源。

### 可用全域

下列 SDK 物件在腳本中可直接使用：

| 名稱 | 型別 | 說明 |
|---|---|---|
| `taskSpace` | `Function` | 建立或取得 TaskSpace 的高階入口 |
| `TaskSpace` | `Class` | TaskSpace 類別 |
| `Page` | `Class` | Page 類別 |

SDK 模組的其他 named export 也可能由 CLI 注入同名全域，但 Agent 應優先使用上述穩定介面。

### 錯誤與退出碼

| 情況 | 行為 |
|---|---|
| stdin 是互動式 TTY 且未提供 `-e` | 顯示錯誤並以代碼 `2` 結束 |
| daemon 無法連線或未就緒 | 顯示啟動提示並以代碼 `2` 結束 |
| 腳本拋出例外 | 顯示錯誤名稱、訊息及少量 stack，最後以代碼 `1` 結束 |
| 腳本正常完成 | 以代碼 `0` 結束 |

## `tp-browser start`

啟動背景瀏覽器與 daemon。

```bash
tp-browser start
```

### 選項

| 選項 | 說明 |
|---|---|
| `--headed`、`-Headed`、`headed` | 啟動可見 GUI，供人工登入或共同操作 |
| `--restart`、`-Restart`、`restart` | 重新啟動既有程序 |
| `--alt-port`、`-AltPort` | 使用替代的本機連接埠組 |
| `--edge`、`-Edge`、`edge` | Windows 上優先選用 Edge |
| `--chrome`、`-Chrome`、`chrome` | Windows 上優先選用 Chrome |

POSIX 系統只有前四類啟動選項；瀏覽器選擇由平台腳本處理。

成功時，平台啟動器會輸出類似下列狀態文字；實際欄位依平台而異：

```text
TP_READY (port=..., chrome=..., os=..., mode=...)
```

```text
EGO_READY (port=..., chrome=..., browser=..., mode=...)
```

若瀏覽器或 daemon 未就緒，命令會以非零代碼結束。

## `tp-browser headed`

啟動可見 GUI 瀏覽器，適合由人工處理登入、二階段驗證或其他需要視窗的步驟。

```bash
tp-browser headed
```

此命令接受與 `start` 相同的啟動選項。Windows 啟動器可能透過工作排程器把 GUI 帶入互動式桌面工作階段。

成功時會顯示 ready 狀態與 TP 介面指示文字。程序啟動本身不應被當作登入已完成的證據；仍應以頁面狀態或 `status`／`doctor` 結果判斷。

## `tp-browser restart`

重新啟動瀏覽器與 daemon。

```bash
tp-browser restart
```

此命令會先嘗試優雅地保存狀態、關閉既有程序，再啟動新的程序。可搭配 `--alt-port`、`--edge` 或 `--chrome`。

## `tp-browser stop`

停止瀏覽器與 daemon。

```bash
tp-browser stop
```

POSIX 腳本會輸出：

```text
TP_STOPPED
```

Windows 腳本會輸出類似：

```text
EGO_STOPPED (terminated N processes)
```

停止命令會盡力只終止使用此專案 daemon 腳本或 agent profile 的程序，不應影響使用者自己開啟的一般瀏覽器程序。

## `tp-browser status`

查詢 daemon 與瀏覽器健康狀態。

```bash
tp-browser status
```

成功時以 pretty-printed JSON 輸出 daemon 的 health 回應。已確認的核心欄位為：

```json
{
  "ok": true,
  "chrome": true
}
```

其他欄位可能隨版本增加，呼叫端應忽略未知欄位。

daemon 不可連線時：

- stderr 顯示不可連線的提示。
- 退出代碼為 `2`。
- 不會輸出 health JSON。

## `tp-browser spaces`

列出 TaskSpace。

```bash
tp-browser spaces
```

此命令會先輸出 health JSON，再輸出 `space.list` 的結果 JSON。兩者是獨立的 JSON 文件，不是一個 JSON 陣列。

認證失敗、token 不存在或 RPC 失敗會以非零代碼結束。

## `tp-browser doctor`

診斷 daemon 與 Chromium CDP 連線。

```bash
tp-browser doctor
```

輸出包含：

- 平台 build tag。
- daemon 是否可達。
- Chromium CDP `/json/version` 是否可達。
- 修復建議命令。

此命令不需要呼叫者自行提供 token，也不會將實際認證資料印到 stdout。

## `tp-browser skill`

輸出 Agent Skill 指南。

```bash
tp-browser skill
```

CLI 依序尋找本機 checkout 或安裝目錄中的 `SKILL.md`。若找不到，才輸出說明性的公開文件位置。實際輸出是操作指引，不是 JSON。

## `tp-browser version`

```bash
tp-browser version
```

目前 CLI 输出版本與平台 build tag，例如：

```text
TooPower Browser (tp-browser) 0.3.1 [tp-linux / ego-linux — 強到沒朋友]
```

`package.json` 與此輸出目前不一致；整合測試若依賴精確版本字串，應先統一來源。

## 說明與無參數模式

```bash
tp-browser
```

```bash
tp-browser help
```

會顯示命令摘要。`help` 沒有獨立分支，但會落到同一usage 輸出。

## Daemon 命令

### `tp-browserd`

```bash
tp-browserd
```

以前景程序啟動 daemon。一般由 `tp-start` 或平台啟動器在背景呼叫。

已確認的啟動選項：

| 選項 | 說明 |
|---|---|
| `--alt-port` | 使用替代的本機 daemon／CDP 連接埠組 |

### `ego-browserd`

```bash
ego-browserd
```

相容 daemon 命令，介面與 `tp-browserd` 相同。正常啟動後會持續在前景執行，直到收到停止訊號。

直接啟動 daemon 前應確認：

- Node.js 版本符合 `package.json` 的 engine 宣告。
- 瀏覽器 CDP 只綁定本機位址。
- 資料目錄權限限制正確。
- 同一組連接埠沒有其他 daemon 占用。

## 輔助命令與腳本

### `install.sh`

macOS／Linux 安裝器。會複製 runtime、建立本機命令連結，並安裝 Agent Skill。可在 repo 根目錄執行：

```bash
./install.sh
```

### `install.ps1`

Windows 安裝器：

```powershell
.\install.ps1
```

### `install.cmd`

Windows CMD 包裝器，所有額外參數會轉交給 PowerShell 安裝器：

```bat
install.cmd
```

安裝器可能需要下載程式碼；這屬於安裝行為，不應在離線文件驗證或正式服務整合測試中自動執行。

### `scripts/tp-start.sh`

POSIX 啟動器，支援 `--headed`、`--restart` 與 `--alt-port`。

### `scripts/tp-stop.sh`

POSIX 停止器。

### `scripts/ego-start.ps1`

Windows 啟動器，支援：

- `-Headed`
- `-Restart`
- `-AltPort`
- `-Edge`
- `-Chrome`

### `scripts/ego-stop.ps1`

Windows 停止器。

### `tools/profile-init.js`

本機 profile 初始化工具：

```bash
node tools/profile-init.js
```

已確認的命令列旗標：

| 旗標 | 說明 |
|---|---|
| `--force` | 強制重新同步符合條件的本機 profile 資料 |
| `--sync-auth` | 與 `--force` 相同的強制同步入口 |

此工具可能讀取本機瀏覽器的書籤、favicon、登入資料庫、cookie DB 與 local storage。測試時應使用隔離的假資料環境，不應複製真實登入資料。
