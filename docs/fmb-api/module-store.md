# TaskSpace Store 參考（`daemon/store.js`）

> 文件狀態：依據本次提供的 `daemon/store.js` 原始碼撰寫。只描述可直接確認的公開類別與方法；未確認行為一律標註。
> 安全邊界：本文不含任何實際 token、cookie、客戶資料或案件內容；範例一律使用暫存目錄與假值。

## 概述

| 項目 | 內容 |
|---|---|
| 模組路徑 | `daemon/store.js` |
| 匯出 | `class Store`（具名匯出） |
| 用途 | TaskSpace ledger 的記憶體表示與 JSON 持久化 |
| 相依 | 僅 Node.js 內建模組（`node:fs`、`node:path`） |
| 已知缺口 | `load()` 不驗證載入形狀；見「錯誤與已知缺口」 |

## 資料形狀

```js
// this.data
{
  nextSpaceId: 1,                    // number，下一個空間 ID
  labelSeq: { "1": 1 },              // Record<spaceId, number>，分頁標號計數
  spaces: {
    "1": {
      id: 1,
      name: "<space name>",
      profileId: "agent",
      ownership: "agent",
      state: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      pages: {
        p1: { targetId: null, openedBy: "agent", title: "", url: "" }
      },
      activeTargetId: null
    }
  }
}
```

- `targetId` 為 CDP target ID；未綁定分頁為 `null`。
- `createdAt` 為 ISO 8601 字串（`new Date().toISOString()`）。

## 建構子

### `new Store(file)`

| 項目 | 說明 |
|---|---|
| 參數 | `file: string` — ledger JSON 檔路徑 |
| 回傳 | `Store` 實例 |
| 副作用 | 立即呼叫 `load()` |
| 錯誤 | 一般情況不拋出；`load()` 內部已捕捉例外（見下） |

## 方法一覽

| 方法 | 簽名 | 回傳 |
|---|---|---|
| `load` | `load(): void` | `undefined` |
| `persist` | `persist(): void` | `undefined` |
| `list` | `list(): Space[]` | 所有空間（`Object.values(this.data.spaces)`） |
| `get` | `get(id): Space \| null` | 單一空間或 `null` |
| `create` | `create({ name, profileId = 'agent' }): Space` | 新建空間 |
| `nextLabel` | `nextLabel(spaceId): string` | 下一個分頁標籤 |
| `setPage` | `setPage(spaceId, label, patch): void` | `undefined` |
| `bindPage` | `bindPage(spaceId, label, targetId, openedBy = 'agent'): void` | `undefined` |
| `addPage` | `addPage(spaceId, label, targetId, openedBy = 'agent'): void` | `undefined` |
| `removePage` | `removePage(spaceId, label): void` | `undefined` |
| `deleteSpace` | `deleteSpace(id): void` | `undefined` |

## 方法細節

### `load()`

讀取 `this.file`（若存在）並以 `JSON.parse` 覆蓋 `this.data`。

- 成功：`this.data` 為檔案內容。
- 失敗（檔案不存在、JSON 損壞、讀取錯誤）：保留建構子的預設值 `{ nextSpaceId: 1, labelSeq: {}, spaces: {} }`，並以 `console.error('[ego-browserd] store load failed, starting fresh:', …)` 記錄後繼續啟動。
- 注意：載入 `{}` 這類「合法 JSON 但形狀不完整」的內容時**不會**被視為失敗，後續方法可能拋 `TypeError`（見「錯誤與已知缺口」）。

### `persist()`

1. `mkdirSync(dirname(this.file), { recursive: true })`。
2. 寫入暫存檔 `${this.file}.${process.pid}.tmp`。
3. `renameSync(tmp, this.file)` 原子替換。
4. 任一步驟拋出時，fallback 為直接 `writeFileSync(this.file, body)`。

所有會變更狀態的方法（`create` / `nextLabel` / `setPage` / `bindPage` / `addPage` / `removePage` / `deleteSpace`）結尾都會呼叫 `persist()`。

### `get(id)`

| 項目 | 說明 |
|---|---|
| 參數 | `id` — 空間 ID（ledger 中以字串鍵存放） |
| 回傳 | 空間物件；不存在時 `null` |

### `create({ name, profileId = 'agent' })`

| 項目 | 說明 |
|---|---|
| 參數 | `name: string`；`profileId?: string`（預設 `'agent'`） |
| 回傳 | 新建的空間物件 |
| 行為 | `id = this.data.nextSpaceId++`；建立 `pages.p1` 佔位分頁（`targetId: null`）；`labelSeq[id] = 1`；寫入 ledger |
| 錯誤 | 若 `this.data.spaces` 因載入形狀不完整而為 `undefined`，指派 `this.data.spaces[id]` 會拋 `TypeError` |

### `nextLabel(spaceId)`

| 項目 | 說明 |
|---|---|
| 參數 | `spaceId` |
| 回傳 | 空間存在時回傳 `` `p${n}` ``（`n` 為遞增後的 `labelSeq`）；空間不存在時回傳字串 `'p?'` |
| 副作用 | 遞增 `labelSeq[spaceId]`（初始視為 1，因此首次回傳 `p2`） |

### `setPage(spaceId, label, patch)`

| 項目 | 說明 |
|---|---|
| 參數 | `spaceId`、`label: string`、`patch: object` |
| 回傳 | `undefined` |
| 行為 | 以 `Object.assign(s.pages[label], patch)` 部分更新分頁紀錄 |
| 靜默條件 | 空間不存在或 `pages[label]` 不存在時**直接 return**（不拋錯、不寫入） |

### `bindPage(spaceId, label, targetId, openedBy = 'agent')` ／ `addPage(...)`

| 項目 | 說明 |
|---|---|
| 參數 | `spaceId`、`label`、`targetId`、`openedBy?` |
| 回傳 | `undefined` |
| 行為 | **整筆覆寫** `s.pages[label] = { targetId, openedBy, title: '', url: '' }` |
| 錯誤 | 空間不存在時拋 `Error('unknown space ' + spaceId)` |
| 備註 | 兩者簽名與行為相同；`addPage` 為語義別名 |

### `removePage(spaceId, label)`

| 項目 | 說明 |
|---|---|
| 參數 | `spaceId`、`label` |
| 回傳 | `undefined` |
| 行為 | `delete s.pages[label]` 後持久化 |
| 靜默條件 | 空間不存在時直接 return |

### `deleteSpace(id)`

| 項目 | 說明 |
|---|---|
| 參數 | `id` |
| 回傳 | `undefined` |
| 行為 | `delete this.data.spaces[id]` 後持久化 |
| 備註 | 不會一併清除 `labelSeq[id]`（未確認是否有意為之） |

## 錯誤與已知缺口

| 情況 | 行為 |
|---|---|
| ledger JSON 損壞 | 回退空 ledger，記 `store load failed`，繼續啟動 |
| ledger 為 `{}` 等形狀不完整內容 | `list()`／`create()` 等可能拋 `TypeError`（既有測試 `tests/test_fmb_store.test.mjs` 已文件化） |
| `bindPage`／`addPage` 傳入未知空間 | 拋 `Error`，訊息 `unknown space <id>` |
| 併發寫入 | `persist()` 以暫存檔 + rename 降低風險，但**無鎖**；多 daemon 共用同一檔案的競爭行為未確認 |

## 範例

```js
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../daemon/store.js';

const dir = mkdtempSync(join(tmpdir(), 'tp-store-doc-'));
const store = new Store(join(dir, 'ledger.json'));

const space = store.create({ name: 'doc-example' });
console.log(space.id, space.pages.p1.targetId); // 1 null

store.bindPage(space.id, 'p1', 'FAKE_TARGET_ID');
store.setPage(space.id, 'p1', { title: 'local test page', url: 'http://127.0.0.1:8765/' });

const label = store.nextLabel(space.id); // 'p2'
store.addPage(space.id, label, 'FAKE_TARGET_ID_2');

store.removePage(space.id, label);
console.log(store.get(space.id).pages.p1.title); // 'local test page'
store.deleteSpace(space.id);
console.log(store.list().length); // 0
```

> 範例中的 target ID 為假值；執行時請使用暫存目錄，勿指向正式瀏覽器或真實 profile。

## 相關文件

- CLI／HTTP／SDK 行為：`docs/fmb-api/cli.md`、`docs/fmb-api/http-api.md`、`docs/fmb-api/sdk.md`
- 架構與資料流：`docs/fmb/ARCHITECTURE.md`
- Ledger 回收提案：`fmb_feature2/README.md`
