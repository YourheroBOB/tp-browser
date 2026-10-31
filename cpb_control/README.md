# 人機共乘控制權等待（選用式模組）

## 選題依據

- `README.md` 與 `skills/tp-browser/SKILL.md` 將人工接手、完成後交還 Agent 列為核心功能。
- 本地沒有 TODO／ROADMAP 檔；本次唯讀查詢 GitHub issues 沒有取得任何 issue，沒有據此虛構待辦。
- `lib/sdk.js` 的 `TaskSpace.waitForControl()` 呼叫 `space.waitForControl`，但兩個 daemon 的實作均直接回傳 `{ control: true }`，沒有等待。
- daemon 的共乘事件已維護 `ownership` 與 `state`；`space.list` 可以唯讀取得兩者。因此不需要新增 daemon API、操作 Chrome 或改動登入資料。
- 不使用 `space.use` 輪詢：該 API 會重設 `state`，且可能建立瀏覽器分頁。

## 已實作

`lib/cpb_control.js` 零第三方依賴，沿用既有 SDK 與錯誤類別。

```js
import { waitForControl } from './lib/cpb_control.js';

// task 與 listTaskSpaces 為現有 SDK 提供的物件／函式。
await waitForControl(task, listTaskSpaces, {
  timeout: 120000,
  polling: 150,
  signal: controller.signal, // 可省略；controller 為呼叫端的 AbortController。
});
```

也可使用 `buildControlSdk(client)` 取代 `buildSdk(client)`，讓該 SDK 的所有
`TaskSpace.waitForControl()` 採用新行為。`client` 沿用既有 `createClient()` 回傳值，
不新增憑證設定、不讀取或保存憑證。不同次 `buildSdk()` 產生的類別互相隔離，
一般 SDK 不受選用式覆寫影響。

| 項目 | 行為 |
|---|---|
| 成功條件 | 指定 space 同時為 `ownership: "agent"`、`state: "active"` |
| 成功回傳 | 沿用 `{ control: true }` |
| 預設時間 | 逾時 30,000 ms；輪詢間隔 150 ms |
| 參數 | 正整數毫秒，最大 `2 ** 31 - 1`；不提供無限等待 |
| 不存在的 space | `UnknownSpace`，立即失敗 |
| 異常狀態／回應 | `ProtocolError`，不當作已交還 |
| 逾時／取消 | `TimeoutError`／`AbortError`，涵蓋尚未完成的查詢 |
| daemon／認證失敗 | 原錯誤直接傳遞，不自動重試或接管 |

此模組不會呼叫 `space.use`、`space.claim`、`space.takeOver` 或 `space.handOff`，
也不會開啟瀏覽器、讀寫 profile、保存對話或查詢正式網站。

## 在既有 CLI 中直接選用

既有 CLI 從暫存目錄執行腳本，所以不能以相對路徑匯入本模組。以下範例在呼叫端
以 repo 根目錄建立絕對 `file:` URL，再交給 CLI；Windows 可直接在腳本內使用
`pathToFileURL()` 將本地絕對路徑轉為 URL。這是使用說明，本次驗證不啟動既有服務。

```bash
CPB_CONTROL_URL="$(node --input-type=module -e \
  'import { pathToFileURL } from "node:url"; console.log(pathToFileURL(process.cwd() + "/lib/cpb_control.js").href)')" \
tp-browser nodejs <<'EOF'
const { waitForControl } = await import(process.env.CPB_CONTROL_URL);
const task = await taskSpace('my-existing-task');
await waitForControl(task, listTaskSpaces, { timeout: 120000 });
// 在成功觀察到交還後，才執行下一個操作。
EOF
```

## 離線測試

在 repo 根目錄執行：

```bash
node --test cpb_control/control.test.js
```

測試僅使用記憶體中的狀態與 mock fetch，不連線服務、不建立 profile，
不讀取或寫入憑證、Cookie、訊息或案件資料。涵蓋人工接手、雙條件交還、
跨 space 隔離、handoff、刪除、格式異常、daemon 錯誤、逾時、取消、
遲到回應，以及既有 SDK 的建構路徑與隔離性。

本次在 Node.js `v26.7.0` 實際執行：**49/49 通過**（含子測試），
沒有失敗、取消或略過；模組與測試的 `node --check` 亦通過。

## 決策點與尚未整合

**待 BOB 決定是否將本行為設為 CLI 預設。** 建議對
`bin/tp-browser.js` 與 `bin/ego-browser.js` 套用同一組 patch；本次沒有修改兩檔：

```diff
-  const { createClient, buildSdk } = await import('../lib/sdk.js');
+  const { createClient } = await import('../lib/sdk.js');
+  const { buildControlSdk: buildSdk } = await import('../lib/cpb_control.js');
```

模組使用 `lib/cpb_control.js` 路徑，既有 `install.sh` 的 `lib/*.js` 與
`install.ps1` 的整個 `lib` 複製規則已涵蓋，不需要修改安裝器。
本次沒有執行安裝或自動部署。

**限制：** 這是呼叫端明示等待，不是全面操作鎖。其他 API 不會因此自動暫停；
觀察到交還與下一次操作之間仍可能發生再次接手。逾時或取消會停止本模組輪詢，
但既有 client 沒有逐請求取消介面，已送出的單次唯讀 RPC 可能稍後才結束。
瀏覽器 UI 的真實點擊、Windows／macOS 實機驗收留待隔離測試環境；
本次不宣稱已完成該項驗證。
