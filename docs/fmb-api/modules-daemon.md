# Daemon 維護模組參考（`daemon/cdp.js`、`daemon/keys.js`）

> 文件狀態：依據本次提供的原始碼撰寫，只列可直接確認的匯出符號與簽名。
> 安全邊界：本文不含任何實際 token、金鑰或客戶資料；範例使用假值與本機位址。

## `daemon/cdp.js` — CDP 用戶端

| 項目 | 內容 |
|---|---|
| 執行環境 | Node.js `>=22`（原生 `WebSocket`）；Node 20 需 `--experimental-websocket` |
| 協定 | Chrome DevTools Protocol over WebSocket（flat session protocol） |
| 匯出 | `class CdpError`、`class Cdp`、`once(cdp, method, opts)` |

### `CdpError`

| 項目 | 說明 |
|---|---|
| 簽名 | `new CdpError(method, data)` |
| 繼承 | `Error` |
| 屬性 | `name: 'CdpError'`；`cdpError: data`（CDP 原始錯誤物件） |
| 訊息 | `` `${method}: ${data?.message ?? JSON.stringify(data)}` `` |

### `Cdp`

| 成員 | 簽名 | 回傳／說明 |
|---|---|---|
| 建構子 | `new Cdp(wsUrl, label = 'cdp')` | 記錄 `wsUrl`／`label`；初始 `id = 0`、`pending`／`handlers`／`sessions` 為空集合 |
| `connect` | `connect(timeoutMs = 15000): Promise<Cdp>` | WebSocket `onopen` 時 resolve(this)；逾時或 `onerror` 時 reject（訊息含 `wsUrl`） |
| `onEvent` | `onEvent(fn): () => boolean` | 訂閱事件，回傳取消訂閱函式；`fn({ sessionId, method, params })`，`sessionId` 可能為 `null` |
| `onClose` | `onClose(fn): () => boolean` | 訂閱連線關閉，回傳取消訂閱函式 |
| `send` | `send(method, params = {}, { sessionId, timeout = 30000 } = {}): Promise<any>` | resolve CDP `result`；見下方錯誤表 |
| `close` | `close(): void` | 標記 `closed = true` 並關閉 WebSocket |

`send()` 行為細節：

- 連線已關閉或 `readyState !== 1`：立即 reject `Error('CDP connection closed')`。
- 訊息格式 `{ id, method, params }`，有 `sessionId` 時附加 `sessionId`。
- 逾時：reject `Error('<method> timed out after <timeout>ms')`，並自 `pending` 移除。
- CDP 回傳錯誤：reject `CdpError(method, msg.error)`。
- WebSocket 關閉時：所有 pending 請求 reject `Error('CDP connection closed')`，並呼叫所有 `onClose` 處理器。
- 收到帶 `sessionId` 的事件時會將該 session 加入 `sessions` 集合。

### `once(cdp, method, opts)`

| 項目 | 說明 |
|---|---|
| 簽名 | `once(cdp, method, { sessionId, timeout = 30000 } = {}): Promise<params>` |
| 回傳 | 第一筆符合條件事件的 `params` |
| 配對規則 | `ev.method === method`，且提供 `sessionId` 時 `ev.sessionId === sessionId` |
| 錯誤 | 逾時 reject `Error('<method> event timed out after <timeout>ms')` |

### 範例

```js
import { Cdp, once } from '../../daemon/cdp.js';

const cdp = new Cdp('ws://127.0.0.1:<chromePort>/devtools/browser/<FAKE_WS_ID>');
await cdp.connect();

const off = cdp.onEvent(({ method, sessionId }) => {
  if (method === 'Target.targetCreated') console.log('target created', sessionId);
});

const version = await cdp.send('Browser.getVersion', {}, { timeout: 5000 });
console.log(version.product);

const params = await once(cdp, 'Page.loadEventFired', { timeout: 10000 });
off();
cdp.close();
```

> `<chromePort>`、`<FAKE_WS_ID>` 皆為佔位假值；實例位址請由本機 daemon 取得，不要連線正式服務。

## `daemon/keys.js` — 鍵盤事件對照

| 項目 | 內容 |
|---|---|
| 用途 | Playwright 相容鍵名 → CDP `dispatchKeyEvent` 欄位 |
| 匯出 | `isModifier`、`modifierBit`、`keyDescriptor`、`parseChord` |

### 修飾鍵位元對照

| 名稱 | 位元 |
|---|---|
| `Alt` | 1 |
| `Control` | 2 |
| `ControlOrMeta` | 2 |
| `Meta` | 4 |
| `Shift` | 8 |

### `isModifier(name): boolean`

回傳 `name` 是否為上表任一修飾鍵名。

### `modifierBit(name): number`

回傳對應位元值；未知名稱回傳 `0`。

### `keyDescriptor(name): object | null`

解析規則（依序）：

1. 命中命名表 → 回傳命名表物件。
2. 長度為 1 的字元 → 回傳 `{ key: c, code, vk, text? }`：
   - `code`：英文字母為 `'Key' + 大寫`；數字為 `'Digit' + c`；其餘為 `null`。
   - `vk`：`c.toUpperCase().charCodeAt(0)`。
   - `text`：符合 `/[ -~]/`（可列印 ASCII）時為該字元，否則 `undefined`。
3. 其他 → 回傳 `null`。

命名表（未列出的 `key`／`code` 會補成與鍵名相同）：

| 鍵名 | 額外欄位 |
|---|---|
| `Enter` | `code: 'Enter'`、`vk: 13`、`text: '\r'` |
| `Tab` | `vk: 9` |
| `Escape` | `vk: 27` |
| `Backspace` | `vk: 8` |
| `Delete` | `vk: 46` |
| `Insert` | `vk: 45` |
| `Home` | `vk: 36` |
| `End` | `vk: 35` |
| `PageUp` | `vk: 33` |
| `PageDown` | `vk: 34` |
| `ArrowUp` | `vk: 38` |
| `ArrowDown` | `vk: 40` |
| `ArrowLeft` | `vk: 37` |
| `ArrowRight` | `vk: 39` |
| `Space` | `key: ' '`、`code: 'Space'`、`vk: 32`、`text: ' '` |
| `Alt` | `code: 'AltLeft'`、`vk: 18`、`modifier: 'Alt'` |
| `Control`／`Ctrl` | `code: 'ControlLeft'`、`vk: 17`、`modifier: 'Control'` |
| `Meta`／`Command` | `code: 'MetaLeft'`、`vk: 91`、`modifier: 'Meta'` |
| `Shift` | `code: 'ShiftLeft'`、`vk: 16`、`modifier: 'Shift'` |
| `F1`–`F12` | 僅 `vk`（112–123），`key`／`code` 補為鍵名 |

### `parseChord(chord): { modifiers: string[], main: string }`

| 項目 | 說明 |
|---|---|
| 參數 | `chord: string`，以 `+` 分隔，例如 `"ControlOrMeta+a"` |
| 回傳 | `{ modifiers, main }`；`main` 為最後一段，其餘為修飾鍵 |
| 錯誤 | 空和弦 → `Error('empty key chord')` |
| 錯誤 | 未知修飾鍵 → `` Error('unknown modifier "<m>" in chord "<chord>"') `` |
| 錯誤 | 未知主鍵 → `` Error('unknown key "<main>" in chord "<chord>"') `` |

### 範例

```js
import { isModifier, modifierBit, keyDescriptor, parseChord } from '../../daemon/keys.js';

isModifier('Shift'); // true
modifierBit('ControlOrMeta'); // 2
keyDescriptor('Enter'); // { key: 'Enter', code: 'Enter', vk: 13, text: '\r' }
keyDescriptor('a'); // { key: 'a', code: 'KeyA', vk: 65, text: 'a' }
parseChord('ControlOrMeta+a'); // { modifiers: ['ControlOrMeta'], main: 'a' }
parseChord('Shift+ArrowLeft'); // { modifiers: ['Shift'], main: 'ArrowLeft' }
```

## 相關文件

- TaskSpace ledger：`docs/fmb-api/module-store.md`
- 架構與模組圖：`docs/fmb/ARCHITECTURE.md`
- HTTP／SSE 與 RPC：`docs/fmb-api/http-api.md`
