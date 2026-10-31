# HTTP／SSE API 參考

## 基礎資訊

- 傳輸協定：HTTP/1.1。
- 服務位址：僅限本機 loopback。
- daemon 支援預設與替代連接埠組；確切連接埠由本機 daemon metadata 決定。
- 所有請求的 `Host` 必須指向允許的本機 daemon。
- 瀏覽器互動式請求不得帶有跨站 `Origin`。

本文件以 `http://127.0.0.1:9772` 顯示請求格式；這是程式碼中的預設 daemon 連接埠，不是可部署到遠端的主機名稱。

## 認證標頭

需要認證的請求使用：

```http
x-tp-token: FAKE_VALUE_FOR_TEST
```

或：

```http
x-ego-token: FAKE_VALUE_FOR_TEST
```

上面的值只供 mock 測試。實際 token 不得出現在文件或輸出中。

部分本機維運端點可由啟動器在沒有 token 的情況下呼叫，因此只能依賴 loopback 綁定與 Host／Origin 防護；呼叫端不應把這些端點暴露到區網或公網。

## 端點總覽

| 方法 | 路徑 | 認證 | 用途 |
|---|---|---:|---|
| `GET` | `/health` | 否 | daemon 與瀏覽器健康狀態 |
| `GET` | `/newtab` | 否 | 建立或開啟新分頁 |
| `GET` | `/flush-and-close` | 否 | 優雅保存狀態並關閉瀏覽器 |
| `GET` | `/events` | 建議 | SSE 事件串流 |
| `POST` | `/rpc` | 是 | JSON RPC 操作 |

## `GET /health`

### 請求

```http
GET /health HTTP/1.1
Host: 127.0.0.1:9772
```

### 回傳

核心回應為 JSON：

```json
{
  "ok": true,
  "chrome": true
}
```

| 欄位 | 型別 | 說明 |
|---|---|---|
| `ok` | `boolean` | daemon 本身是否正常 |
| `chrome` | `boolean` | 是否已連上 Chromium CDP |

回應可能包含其他版本化欄位。呼叫端應忽略未知欄位，不應依賴欄位順序。

### 錯誤

- daemon 未執行：連線被拒絕或逾時。
- 回應不是有效 JSON：CLI 會將健康狀態視為不可用。
- `ok` 為 false 或 `chrome` 為 false：daemon 可回應，但瀏覽器尚未可用。

## `GET /newtab`

### 請求

```http
GET /newtab HTTP/1.1
Host: 127.0.0.1:9772
```

### 行為

讓 daemon 在已附著的瀏覽器中建立或開啟新分頁。headed 啟動器會把此 URL 當作 GUI 瀏覽器的起始頁。

回應可能由瀏覽器導覽處理，呼叫端應依正常 HTTP redirect／2xx 行為處理，不應依賴特定 HTML body。

### 錯誤

- Chromium 尚未附著。
- CDP 目標建立失敗。
- 瀏覽器正在關閉。

## `GET /flush-and-close`

### 請求

```http
GET /flush-and-close HTTP/1.1
Host: 127.0.0.1:9772
```

### 行為

要求 daemon／瀏覽器將可保存的本機狀態寫入磁碟，並優雅關閉瀏覽器。啟動器在重啟或停止前會呼叫此端點。

此操作具有副作用，且在瀏覽器未啟動時通常可安全忽略。

### 回傳

啟動器不依賴特定 response body。成功時可回傳 JSON 狀態；失敗時可能回傳錯誤狀態或關閉連線。

### 注意事項

- 不應在仍需保留瀏覽器 session 的情況下呼叫。
- 不應把「收到 HTTP 回應」等同於所有瀏覽器程序都已停止；程序清理仍由平台停止腳本完成。

## `GET /events`

### 請求

```http
GET /events HTTP/1.1
Host: 127.0.0.1:9772
Accept: text/event-stream
x-tp-token: FAKE_VALUE_FOR_TEST
```

### 回傳

回應為 `text/event-stream`。事件 data 為 JSON，核心欄位為：

```json
{
  "method": "event-method-name",
  "params": {},
  "sessionId": null
}
```

| 欄位 | 型別 | 說明 |
|---|---|---|
| `method` | `string` | 事件名稱 |
| `params` | `object` | 事件參數 |
| `sessionId` | `string \| null` | CDP session；非 session 事件可能為 null |

### 錯誤

- 認證失敗。
- daemon 在事件尚未送達前關閉。
- client 沒有及時讀取 stream，導致連線逾時或被緩衝機制中止。

### 用法注意事項

- SSE client 應在收到所需事件後取消讀取。
- 不應把 token 放在 URL query string。
- 事件可能包含頁面 metadata；記錄前應移除敏感內容。

## `POST /rpc`

### 請求

```http
POST /rpc HTTP/1.1
Host: 127.0.0.1:9772
Content-Type: application/json
x-tp-token: FAKE_VALUE_FOR_TEST

{
  "id": 1,
  "method": "space.list",
  "params": {}
}
```

### Request envelope

| 欄位 | 型別 | 必要 | 說明 |
|---|---|---:|---|
| `id` | `number \| string` | 是 | 請求識別碼；daemon 應原樣回傳 |
| `method` | `string` | 是 | RPC 方法名稱 |
| `params` | `object` | 否 | 方法參數；未提供時可視為空物件 |

### 成功回應

```json
{
  "ok": true,
  "id": 1,
  "result": []
}
```

| 欄位 | 型別 | 說明 |
|---|---|---|
| `ok` | `boolean` | 成功時為 true |
| `id` | `number \| string` | 對應請求 |
| `result` | `unknown` | 方法結果；形狀由方法決定 |

### 錯誤回應

```json
{
  "ok": false,
  "id": 1,
  "error": {
    "name": "Error",
    "message": "Human-readable error message"
  }
}
```

### 認證與解析錯誤

- token 缺少或錯誤時，daemon 應拒絕請求。
- `Content-Type` 不支援時，daemon 可能回傳解析錯誤。
- body 不是有效 JSON 時，daemon 應回傳可識別的解析錯誤。
- 呼叫端應以 `ok` 與 `error` 判斷應用層結果，不要只依賴 HTTP status code。

### curl 範例

此命令只適合對 mock daemon 測試；假 token 不應用於正式本機 daemon：

```bash
curl -sS \
  -H 'content-type: application/json' \
  -H 'x-tp-token: FAKE_VALUE_FOR_TEST' \
  --data '{"id":1,"method":"space.list","params":{}}' \
  http://127.0.0.1:9772/rpc
```

## 安全要求

1. daemon 只監聽 loopback。
2. CDP WebSocket 只允許本機瀏覽器端點。
3. `Host` 驗證應在任何路由操作前完成。
4. 帶有 `Origin` 的瀏覽器請求應被拒絕，避免跨站請求偽造。
5. token 應以固定時間比較驗證。
6. 所有寫入路徑都應先做 canonicalization 與 containment 檢查。
7. 不應開啟 CORS 允許任意來源。
8. 不應記錄 request body、認證標頭、cookie 或完整頁面內容。
