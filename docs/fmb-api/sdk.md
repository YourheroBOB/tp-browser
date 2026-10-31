# Node.js SDK 參考

SDK 位於 `lib/sdk.js`，供 `tp-browser nodejs` 建立的 Agent 腳本使用。

## 模組匯出

```js
import {
  createClient,
  buildSdk,
  taskSpace,
  TaskSpace,
  Page,
} from "../lib/sdk.js";
```

實際使用時，CLI 會把 SDK 的匯出函式與類別注入 Agent 腳本的全域命名空間。

## `createClient(options)`

建立 daemon HTTP／SSE 用戶端。

### 簽名

```ts
createClient(options: {
  port: number;
  token: string;
}): {
  rpc(method: string, params?: Record<string, unknown>): Promise<unknown>;
  waitPush(method: string, options?: Record<string, unknown>): Promise<unknown>;
}
```

### 參數

| 參數 | 型別 | 必要 | 說明 |
|---|---|---:|---|
| `options.port` | `number` | 是 | daemon 的本機 HTTP 連接埠 |
| `options.token` | `string` | 是 | 認證 token；不得記錄或輸出 |

### 回傳

回傳包含 `rpc` 與 `waitPush` 的 client object。

- `rpc(method, params)` 送出 JSON RPC 請求並回傳 `result`。
- `waitPush(...)` 等待 daemon 的事件串流訊息。

### 錯誤

- daemon 不可連線時，Promise 會拒絕。
- HTTP 回應不是有效 JSON 時，會拋出 JSON 解析錯誤。
- RPC 回應的 `ok` 為 false 時，會轉成 `Error`。
- 認證失敗時，錯誤來自 daemon 的認證回應。

### 範例

```js
const { rpc, waitPush } = createClient({
  port: 9772,
  token: "FAKE_VALUE_FOR_TEST",
});
```

此範例中的 token 只適用於 mock 測試；真實 daemon 不會接受這個假值。

## `buildSdk(dependencies)`

以低階 client 建立高階 SDK 物件。

### 簽名

```ts
buildSdk(dependencies: {
  rpc: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  waitPush: (...args: unknown[]) => Promise<unknown>;
}): {
  taskSpace: typeof taskSpace;
  TaskSpace: typeof TaskSpace;
  Page: typeof Page;
}
```

### 參數

| 參數 | 型別 | 說明 |
|---|---|---|
| `dependencies.rpc` | `Function` | 執行 daemon RPC 的函式 |
| `dependencies.waitPush` | `Function` | 等待 daemon 事件的函式 |

### 回傳

回傳可建立 `TaskSpace` 的 SDK factory 與其型別。

### 範例

```js
const { rpc, waitPush } = createClient({
  port: 9772,
  token: "FAKE_VALUE_FOR_TEST",
});
const sdk = buildSdk({ rpc, waitPush });
const task = await sdk.taskSpace("local-example");
```

## `taskSpace(name)`

建立 Agent 所有的 TaskSpace。

### 簽名

```ts
taskSpace(name: string): Promise<TaskSpace>
```

### 參數

| 參數 | 型別 | 必要 | 說明 |
|---|---|---:|---|
| `name` | `string` | 是 | TaskSpace 的顯示名稱，用於 agent 端識別任務 |

### 回傳

回傳 `TaskSpace` 的 Promise。名稱不應包含案件當事人資料或其他敏感資訊；建議使用抽象名稱，例如 `research-flow` 或 `local-test`。

### 錯誤

- 名稱不是可接受的字串時，daemon／SDK 會回傳錯誤。
- daemon 不可連線或認證失敗時，Promise 會拒絕。
- 已存在同名 TaskSpace 時，是否重用或建立新空間取決於 daemon 實作；呼叫端應把 `taskSpace()` 視為取得一個可用工作空間，而非以名稱作唯一鍵。

### 範例

```js
const task = await taskSpace("local-example");
```

## `TaskSpace`

TaskSpace 是一組由同一 Agent 擁有、可在多個 Page 之間切換的瀏覽器工作空間。

### `task.page(label?)`

取得指定 label 的 Page 控制物件。

```ts
page(label?: string): Page
```

| 參數 | 型別 | 預設 | 說明 |
|---|---|---|---|
| `label` | `string` | `p1` | Page label，例如 `p1`、`p2` |

此方法在已提供的呼叫點中是同步的，不需要 `await`：

```js
const task = await taskSpace("local-example");
const page = task.page("p1");
```

Page 物件是操作描述；實際瀏覽器操作在呼叫其非同步方法時才執行。

### `task.finish(options?)`

結束 TaskSpace 的 Agent 工作流程。

```ts
finish(options?: {
  keep?: string[];
}): Promise<void>
```

| 欄位 | 型別 | 預設 | 說明 |
|---|---|---|---|
| `keep` | `string[]` | `[]` | 要保留的 Page label 清單 |

### 範例

```js
await task.finish({ keep: [] });
```

### 錯誤

- Page label 不存在時，相關 cleanup 呼叫可能回傳錯誤。
- daemon 在呼叫期間關閉時，Promise 會拒絕。
- `keep` 包含未知 label 時，應以錯誤為準，不應假設該 label 已成功保留。

## `Page`

Page 代表 TaskSpace 中的一個瀏覽器分頁。建議只透過 `task.page()` 取得，不直接呼叫 class constructor。

## `page.goto(url, options?)`

導覽至 URL。

### 簽名

```ts
goto(
  url: string,
  options?: {
    waitUntil?: "load" | "domcontentloaded" | "networkidle";
    timeout?: number;
  },
): Promise<unknown>
```

### 參數

| 參數 | 型別 | 說明 |
|---|---|---|
| `url` | `string` | 目標 URL |
| `options.waitUntil` | `string` | 導航完成條件 |
| `options.timeout` | `number` | 導航等待期限 |

### 回傳

在導航完成後 resolve。回傳內容應視為 daemon／CDP 的導航 metadata，而不是 DOM snapshot。

### 錯誤

- URL 無效或網路請求失敗。
- 等待條件在期限內未達成。
- Page 或 TaskSpace 已不存在。
- CDP 連線中斷。

### 範例

```js
await page.goto("http://127.0.0.1:8765/", {
  waitUntil: "load",
  timeout: 20000,
});
```

## `page.snapshot(options?)`

擷取 ego-format 語意快照。

### 簽名

```ts
snapshot(options?: {
  scope?: "only_within_viewport" | "full_page" | "subtree";
  rootRef?: number;
}): Promise<string>
```

| 參數 | 型別 | 預設 | 說明 |
|---|---|---|---|
| `options.scope` | `string` | `only_within_viewport` | 擷取範圍 |
| `options.rootRef` | `number` | 無 | `subtree` 範圍的根 element reference |

### 回傳

回傳多行文字快照。呼叫端可把它直接輸出或做文字處理。

### 錯誤

- `subtree` 的 `rootRef` 不存在。
- Page 已關閉或瀏覽器 context 已失效。
- 快照產生期間 CDP 連線中斷。

### 範例

```js
const snap = await page.snapshot({
  scope: "only_within_viewport",
});
console.log(snap);
```

## `page.evaluate(callback)`

在目前 Page 的瀏覽器 context 中執行程式碼。

### 簽名

```ts
evaluate<T>(callback: () => T | Promise<T>): Promise<T>
```

### 參數

| 參數 | 型別 | 說明 |
|---|---|---|
| `callback` | `Function` | 在瀏覽器內執行的函式 |

### 回傳

回傳 callback 的結果。回傳值必須能安全序列化；不應回傳 DOM node、函式、循環參考或敏感資料。

### 錯誤

- callback 不是可序列化函式。
- callback 拋出例外。
- 回傳值無法序列化。
- Page context 已失效。

### 範例

```js
const title = await page.evaluate(() => document.title);
```

## `page.screenshot(options?)`

擷取 Page 畫面。

### 簽名

```ts
screenshot(options?: {
  path?: string;
  fullPage?: boolean;
}): Promise<unknown>
```

| 參數 | 型別 | 預設 | 說明 |
|---|---|---|---|
| `options.path` | `string` | 無 | 圖片寫入路徑 |
| `options.fullPage` | `boolean` | `false` | 是否擷取完整頁面 |

### 回傳

在擷取完成後 resolve；呼叫端應依 `path` 或回傳 metadata 取得結果。

### 錯誤

- 指定路徑不可寫入。
- 路徑不符合 daemon 的安全邊界。
- Page 已關閉。
- CDP 截圖命令失敗。

### 範例

```js
const { mkdtempSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

const dir = mkdtempSync(join(tmpdir(), "tp-screenshot-"));
await page.screenshot({ path: join(dir, "page.png") });
```

## Page selector

SDK 的 DOM 操作若接受 selector，應使用下列已由瀏覽器端代理實作的格式：

| 格式 | 範例 | 說明 |
|---|---|---|
| element reference | `@12`、`ref=12` | 目前 snapshot／resolve 取得的 reference |
| text | `text=登入`、`text="登入"` | 未加引號為包含比對；加引號為精確比對 |
| role | `loc=role:button[name="登入"]` | 以 ARIA／HTML role 與 accessible name 查找 |
| CSS | `css=button.primary`、`css:button.primary` | CSS selector |
| CSS text filter | `css=button:has-text("送出")` | 包含文字 |
| CSS exact text | `css=button:text-is("送出")` | 精確文字 |
| nth | `css=li >> nth=0` | JavaScript slice 語意的索引 |
| href | `loc=href:/account` | href 包含指定片段 |
| XPath | `xpath=//button[@type="submit"]` | XPath expression |

完整的 selector 行為與錯誤請見瀏覽器端代理（`window.__egoAgent`）原始碼。

## SDK 錯誤處理範例

```js
try {
  const task = await taskSpace("local-example");
  const page = task.page("p1");
  await page.goto("http://127.0.0.1:8765/");
  console.log(await page.snapshot());
  await task.finish({ keep: [] });
} catch (error) {
  console.error(`${error.name}: ${error.message}`);
  process.exitCode = 1;
}
```

不要在錯誤輸出中加入 cookie、token、完整頁面內容或其他敏感資料。
