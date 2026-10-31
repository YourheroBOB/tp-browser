# 結構化日誌規格：關鍵事件與欄位

## 1. 格式

- **JSON Lines**：一行一個 JSON 物件，附加寫入既有 log 路徑（`~/.local/share/ego-linux/logs/daemon.log` 等），不新增檔案位置。
- 解析器需容忍舊的 plain-text 行（過渡期雙軌並存）。
- 單行上限建議 8 KB，超出丟棄該事件的選擇性欄位並記 `truncated:true`。

## 2. 通用欄位（envelope）

| 欄位 | 類型 | 必要性 | 說明與限制 |
|---|---|---|---|
| `ts` | string (ISO 8601, UTC) | 必備 | 例：`2026-01-01T00:00:00.000Z` |
| `level` | enum | 必備 | `debug`｜`info`｜`warn`｜`error` |
| `event` | string (enum) | 必備 | 見事件目錄；不在目錄內的事件不允許上線 |
| `component` | enum | 必備 | `daemon`｜`cli`｜`sdk`｜`cdp`｜`store`｜`pageops`｜`inpage`｜`reaper`｜`profile-init`｜`startscript` |
| `binary` | enum | 選用 | `tp-browserd`｜`ego-browserd`｜`tp-browser`｜`ego-browser`（雙軌歸因用） |
| `version` | semver | 必備 | 執行中版本；解決 G7/G8 埠號漂移與版本偏斜 |
| `instance` | string | 必備 | 例：`daemon:9772`、`daemon:9774`、`cli` |
| `pid` | int | 選用 | |
| `trace_id` | 16 hex | 強烈建議 | 跨元件關聯（見 §3） |
| `span_id` | 8 hex | 選用 | |
| `msg` | string ≤128 | 選用 | 人類可讀摘要，**同樣受紅機制約束**（見 `sensitive-fields.md`） |

## 3. 關聯 ID（trace_id）

- CLI 產生 `trace_id`（隨機 16 hex），以 header **`x-tp-trace-id`** 傳給 daemon；daemon 沿用於 CDP 呼叫與所有子事件。
- 無 CLI 的來源（health probe、start script、reaper 計時器）由 daemon 自行產生。
- 查詢範例：`jq -c 'select(.trace_id=="0123456789abcdef")' logs/daemon.log`

## 4. 事件目錄

| event | component | level | 欄位 | 觸發時機／備註 |
|---|---|---|---|---|
| `daemon.start` / `daemon.ready` / `daemon.stop` | daemon | info | `port`, `chromePort`, `mode`(headless/headed) | 啟動生命週期；`ready` 對應現在 echo 的 `TP_READY` |
| `chrome.attach` / `chrome.detach` / `chrome.attach_retry` | daemon | info/warn | `port`, `ok`, `durationMs`, `attempt`, `reason` | CDP 掛載／脫離；`reason` 用固定 enum（`closed`/`timeout`/`refused`/`restart`） |
| `http.request` | daemon | info | `route`, `method`, `status`, `durationMs` | `route` 用固定 enum：`/health`、`/newtab`、`/flush-and-close`、`rpc`、`/json/list`（內部）；**不含 query** |
| `http.rejected` | daemon | warn | `reason` | `bad-host`｜`origin-present`｜`bad-token`｜`bad-path`｜`rate-limit`；不記 header 值 |
| `cdp.command` | cdp | info | `method`, `ok`, `durationMs`, `errorClass?` | `method` 限定實際使用的 CDP method；**不得記錄 wsUrl** |
| `cdp.disconnect` / `cdp.timeout` | cdp | warn/error | `method?`, `pendingCount` | 對應 `Cdp` 的 pending map 與 timeout 路徑 |
| `space.create` | store | info | `spaceId`, `profileId` | **禁記 `name`**（使用者自訂，可能是案號／案名） |
| `space.page.bind` / `space.page.drop` | store | info | `spaceId`, `label`, `reason?` | 對應 `bindPage`/`addPage`/`removePage`；`targetId` 預設不記（高基數） |
| `space.finish` / `space.delete` | store | info | `spaceId`, `reason`(user/reaper-dead/reaper-idle/reaper-overcap), `pages`(count) | |
| `batch.execute` | daemon | info | `phase`(start/end), `durationMs?`, `scriptBytes`, `resultBytes?`, `ok`, `errorClass?` | **禁記腳本內容與回傳值** |
| `navigation` | pageops | info | `urlOrigin`, `pathHash`, `waitUntil`, `durationMs`, `ok` | 預設只記 `scheme://host`；`pathHash = sha256(path)[:12]`；**query/fragment 一律丟棄** |
| `file.op` | pageops | info | `kind`(screenshot/download/upload), `ok`, `violation?`, `bytes?` | 對應 `safePath`；**禁記絕對路徑**，只用 basename 或 `fileHash` |
| `store.persist` | store | info | `durationMs`, `bytes`, `spaces`, `ok` | 對應 `persist()`；失敗升 `error` |
| `store.load_failed` | store | error | `errorClass` | 取代現有 A1 的 free-form 訊息；訊息正規化後才可入 `msg` |
| `reaper.plan` / `reaper.apply` | reaper | info | `closeSpaces`(count), `dropPages`(count), `staleActiveTargets`(count), `overCap`, `reason?` | 直接沿用 reaper 回傳的 `stats` 語意，不改其 schema |
| `profile.sync` | profile-init | info | `kind`(bookmarks/favicons/login/cookies/localstorage/indexeddb), `count?`, `bytes?` | **修正現況**：不再印絕對路徑（A3） |
| `key.input` | pageops | debug | `count` | 只記按鍵數量；**禁記按鍵文字**（`keys.js` 的 `text` 可能是密碼或個資） |
| `inpage.marker_reject` | inpage | warn | `reason` | `/^ego-\d+$/` 標記驗證失敗 |
| `redaction.hit` | 任一 | warn | `field`, `type` | 紅機制命中時記「哪個欄位、哪種類型」，**不記原值** |
| `health.probe` | startscript | debug | `ok`, `chrome`, `durationMs` | start script 層級，可採樣 |

## 5. 層級與採樣

- 預設 `level=info`；`debug` 需 `TP_LOG_LEVEL=debug`。
- `warn`：可恢復異常（重試、reject、violation、redaction.hit）。
- `error`：影響功能（persist 失敗、CDP 斷、batch error、store load failed）。
- 高頻事件（`http.request`、`cdp.command`）可採樣：`TP_LOG_SAMPLE=0.1`（預設 1.0）。

## 6. 範例（全為假資料，可直接作為測試基線）

```json
{"ts":"2026-01-01T00:00:00.000Z","level":"info","event":"daemon.ready","component":"daemon","binary":"tp-browserd","version":"0.3.0","instance":"daemon:9772","port":9772,"chromePort":9773,"mode":"headless","msg":"TP_READY"}
{"ts":"2026-01-01T00:00:01.000Z","level":"info","event":"batch.execute","component":"daemon","version":"0.3.0","instance":"daemon:9772","trace_id":"0123456789abcdef","phase":"end","durationMs":1363,"scriptBytes":2048,"resultBytes":512,"ok":true}
{"ts":"2026-01-01T00:00:02.000Z","level":"info","event":"navigation","component":"pageops","version":"0.3.0","instance":"daemon:9772","trace_id":"0123456789abcdef","urlOrigin":"https://example.test","pathHash":"a1b2c3d4e5f6","waitUntil":"load","durationMs":842,"ok":true}
{"ts":"2026-01-01T00:00:03.000Z","level":"warn","event":"http.rejected","component":"daemon","version":"0.3.0","instance":"daemon:9772","reason":"bad-token","msg":"token mismatch"}
{"ts":"2026-01-01T00:00:04.000Z","level":"warn","event":"redaction.hit","component":"daemon","version":"0.3.0","instance":"daemon:9772","field":"navigation.url","type":"url_query","msg":"query stripped"}
```

## 7. 明確禁止（摘要；完整規格見 `sensitive-fields.md`）

禁記：token／cookie／任何憑證、頁面內容與 DOM 快照、`snapshot()`／`evaluate()` 回傳值、URL query/fragment、絕對路徑、`space.name`、按鍵文字、批次腳本內容、LINE 訊息內文、案件與當事人資料。
