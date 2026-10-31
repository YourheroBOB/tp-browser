# tp-browser API／介面參考文件

本目錄是 `tp-browser` 0.3.x 的 API、CLI、HTTP／SSE、瀏覽器端代理與設定參考文件。

## 文件索引

- [CLI 指令參考](cli.md)
- [Node.js SDK 參考](sdk.md)
- [HTTP／SSE API 參考](http-api.md)
- [RPC 方法參考](rpc-methods.md)
- [公開匯出模組參考](exported-modules.md)
- [瀏覽器內代理參考](browser-agent.md)
- [設定項參考](configuration.md)

## 支援基準

- `package.json` 宣告的套件版本為 `0.3.0`。
- CLI 的 `version` 指令目前顯示 `0.3.1`。
- 為避免不相容，本文件以 **0.3.x 介面**描述共同行為；正式對外發行前應由維護者統一版本號。

## API 分層

| 層級 | 主要介面 | 用途 |
|---|---|---|
| CLI | `tp-browser`、`ego-browser` | 啟停瀏覽器、執行 Agent 腳本、查詢狀態 |
| Daemon CLI | `tp-browserd`、`ego-browserd` | 在前景執行本機瀏覽器控制 daemon |
| Node.js SDK | `lib/sdk.js` | 在單一 Agent 腳本內批次操作 TaskSpace 與 Page |
| HTTP／SSE | 本機 daemon | 健康檢查、RPC、事件串流、新分頁與關閉 |
| 瀏覽器端代理 | `window.__egoAgent` | 選取元素、產生快照、讀寫表單與檔案控制資訊 |
| 維護者模組 | `daemon/cdp.js`、`daemon/keys.js`、`daemon/store.js` | CDP、鍵盤事件與 TaskSpace 儲存 |

## 共通約定

### 非同步介面

- SDK 的公開操作回傳 `Promise`。
- `await` 是必要的；不要假設 DOM 操作已同步完成。
- 導航、等待、CDP 呼叫與檔案操作可能逾時。

### 錯誤模型

SDK 與 CLI 將 daemon 的錯誤轉成 JavaScript `Error`。錯誤訊息通常包含：

- `name`：例如 `Error`、`TypeError` 或 CDP 錯誤名稱。
- `message`：可供程式判斷的錯誤原因。
- 呼叫端應以 `try`／`catch` 包住操作，不應只依賴 stderr 文字。

RPC 回應使用下列邏輯結構：

```json
{
  "ok": false,
  "error": {
    "name": "Error",
    "message": "Human-readable error message"
  }
}
```

實際訊息可能包含本機路徑、頁面資訊或底層 CDP 錯誤；呼叫端應避免把完整錯誤直接記錄到共用日誌。

### 認證

對需要認證的本機請求，使用以下請求標頭之一：

- `x-tp-token`
- `x-ego-token`

文件示例一律使用明顯的假值：

```bash
-H 'x-tp-token: FAKE_VALUE_FOR_TEST'
```

不要在文件、測試、命令列歷史或 issue 中放入實際 token。CLI 正常情況下會自行從本機 daemon 資料目錄讀取認證資料。

### 網路邊界

- daemon 與瀏覽器 CDP 應只綁定 `127.0.0.1`。
- HTTP 請求必須使用本機 `Host`，且一般互動式工具不應送出跨站 `Origin`。
- 正式網站、外部 API 與遠端 daemon 不應用於本文件中的整合測試。
- 測試請使用 repo 內的本機測試伺服器或 `tmp_path`／`tempfile` 類型的暫存目錄。

### 路徑與敏感資料

- 上傳、下載、截圖等檔案操作必須由 daemon 做路徑正規化與邊界檢查。
- 不應將實際 cookie、登入資料、客戶資料或案件內容放進測試 fixture。
- Profile 初始化工具可能讀取本機瀏覽器資料；執行前應確認資料來源與用途。

## 最小本機範例

```bash
tp-browser nodejs -e '
const task = await taskSpace("local-example");
const page = task.page("p1");
await page.goto("http://127.0.0.1:8765/");
console.log(await page.snapshot());
await task.finish({ keep: [] });
'
```

此範例假設已有本機測試伺服器在 `127.0.0.1:8765` 提供頁面；它不應改成正式服務網址。

## 來源可見性與維護原則

本文件只把已提供來源中可直接確認的匯出符號、CLI 分支、HTTP 路徑與設定名稱列為公開契約。沒有出現在 SDK、daemon 或瀏覽器端匯出介面的內部 helper 不會被推測成公開 API。

新增或變更以下內容時，應同步更新本目錄：

1. `lib/sdk.js` 的匯出與方法簽名。
2. daemon 的 HTTP 路由、RPC 方法與錯誤格式。
3. `window.__egoAgent` 的欄位與回傳結構。
4. `package.json` 的 `bin` 對應。
5. 啟動器的命令列選項與環境變數名稱。
