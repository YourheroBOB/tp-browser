# tp-browser 離線使用範例

本目錄提供 **6 個可直接執行的 tp-browser 核心使用範例**。所有範例皆符合下列條件：

- 不連線外部網路，也不操作正式服務。
- 不需要瀏覽器、daemon、真實金鑰、token 或密碼。
- 測試資料皆為明確的假值，例如 `FAKE_LIVE_TARGET_FOR_TEST`。
- 需要暫存檔時，僅使用 `mkdtempSync(tmpdir())` 建立暫存目錄，並於 `finally` 中清除。
- 使用 Node.js 內建 `node:assert/strict` 進行自我驗證；失敗時會以非零退出碼結束。

本套範例刻意不啟動 Chrome 與 tp-browser daemon，因此不會讀寫既有瀏覽器 Profile、Cookie 或登入資料，也不會干擾目前正在運行的瀏覽器服務。

## 執行需求

- Node.js **22 以上**，與專案 `package.json` 的需求一致。
- 請在 repository 根目錄執行下列命令。

先確認 Node.js 版本：

```bash
node --version
```

## 一次執行全部範例

```bash
node fmb_examples/run-all.mjs
```

預期輸出：

```text
01-key-chords: PASS
02-task-space-ledger: PASS
03-task-space-reaper: PASS
04-offline-cdp-mock: PASS
05-sdk-offline-harness: PASS
06-offline-cli-demo: PASS
ALL PASS (6/6 examples)
```

`run-all.mjs` 是驗證入口，不屬於六個功能範例之一。它會以獨立 Node.js 子程序執行各範例；若任一範例失敗，會顯示該子程序的 stdout、stderr 與錯誤訊息，並以非零退出碼結束。

## 範例一：解析鍵盤 Chord 與按鍵描述

**檔案：** `fmb_examples/01-key-chords.mjs`

**用途：**

示範如何使用 `daemon/keys.js`：

- 解析 `ControlOrMeta+a`、`Shift+Enter` 等鍵盤 chord。
- 取得一般按鍵、Enter 與方向鍵等按鍵描述。
- 查詢 modifier bit。
- 驗證未知 modifier 與未知按鍵會被安全拒絕。

**執行方式：**

```bash
node fmb_examples/01-key-chords.mjs
```

成功時會輸出 JSON，內含 `"status": "PASS"`。

## 範例二：建立、重新載入並清理 TaskSpace ledger

**檔案：** `fmb_examples/02-task-space-ledger.mjs`

**用途：**

直接使用 daemon 所採用的 `daemon/store.js`，示範：

1. 建立 TaskSpace。
2. 取得下一個分頁標籤。
3. 綁定與新增分頁。
4. 將 ledger 重新載入，確認資料確實持久化。
5. 移除分頁與刪除空間。

**執行方式：**

```bash
node fmb_examples/02-task-space-ledger.mjs
```

ledger 僅存於系統暫存目錄；無論成功或失敗，程式都會刪除該暫存目錄。

## 範例三：TaskSpace 回收器的離線決策與套用

**檔案：** `fmb_examples/03-task-space-reaper.mjs`

**用途：**

使用 `fmb_feature2/reaper.js` 與 `daemon/store.js`，以合成空間模擬：

- 存活分頁。
- 已失效分頁。
- 混合空間。
- 已固定（`pinned`）空間。
- 閒置空間。

範例會先驗證回收計畫，再套用到暫存 ledger，並確認：

- 存活空間不會被關閉。
- 已失效分頁會依規則移除。
- `pinned` 空間完全不受影響。
- 當 live target 集合為空時，安全閥會阻止所有破壞性操作。

**執行方式：**

```bash
node fmb_examples/03-task-space-reaper.mjs
```

## 範例四：以記憶體 Fake WebSocket 測試 CDP client

**檔案：** `fmb_examples/04-offline-cdp-mock.mjs`

**用途：**

示範如何在不啟動 Chrome、不建立網路連線的情況下測試 `daemon/cdp.js`：

- 以記憶體中的 Fake WebSocket 模擬連線。
- 驗證 CDP request 與 response。
- 驗證 CDP event 訂閱。
- 確認 close 行為。

**執行方式：**

```bash
node fmb_examples/04-offline-cdp-mock.mjs
```

Fake WebSocket 完全位於記憶體中；`ws://127.0.0.1/...` 僅是明確標示的假 URL，不會送出封包。

## 範例五：SDK 依賴注入的離線測試骨架

**檔案：** `fmb_examples/05-sdk-offline-harness.mjs`

**用途：**

使用 `lib/sdk.js` 的 `buildSdk()` 建立 SDK，並注入假的 `rpc` 與 `waitPush` 函式，示範如何：

- 在沒有 daemon 的情況下建立 SDK。
- 確認 `taskSpace`、`TaskSpace` 與 `Page` API 可用。
- 建立合成 TaskSpace 與頁面物件。
- 在後續單元測試中，以假的 transport 取代正式 daemon。

**執行方式：**

```bash
node fmb_examples/05-sdk-offline-harness.mjs
```

本範例只建立 SDK 與合成物件，不會執行需要 daemon 的頁面導覽操作。

## 範例六：唯讀 CLI 與回收器乾跑

**檔案：** `fmb_examples/06-offline-cli-demo.mjs`

**用途：**

示範兩種不需瀏覽器的 CLI 用法：

1. 執行 `bin/tp-browser.js version`，確認 CLI 可啟動且版本資訊可讀。
2. 將 JSON 透過 stdin 傳給 `fmb_feature2/cli.js`，執行唯讀回收計畫乾跑。
3. 再次使用空的 live target 集合，驗證 CLI 的安全閥回報 `no-live-targets`。

**執行方式：**

```bash
node fmb_examples/06-offline-cli-demo.mjs
```

兩個 CLI 子程序皆為唯讀操作，不會啟動 daemon、瀏覽器或修改 ledger。

## 安全與維護注意事項

- 範例中的 `FAKE_TARGET_FOR_TEST`、`FAKE_LIVE_TARGET_FOR_TEST` 等值只供測試，不得當成正式識別資料使用。
- 本目錄不需要也不應加入真實 token、金鑰、密碼、Cookie、瀏覽器紀錄或任何個人資料。
- 若要新增需要瀏覽器的端到端範例，應另設明確的本機測試環境，並避免使用正式 Profile；不應直接把真實瀏覽器資料納入測試 fixture。
- 每個範例皆可單獨執行，也可使用 `run-all.mjs` 一次驗證。
