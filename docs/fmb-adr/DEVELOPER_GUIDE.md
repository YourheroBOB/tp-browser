# tp-browser 新進開發者上手指南

本指南整理專案入口、主要模組、概念資料流與常見修改路徑。開始修改前，請以 repo 當前原始碼為準；尤其是本指南所提及但本次文件內容未完整呈現的 daemon 與 SDK 細節。

## 1. 專案概覽

tp-browser 是以 ESM JavaScript 實作的本機瀏覽器控制工具。核心以 Node.js 原生能力與 Chrome DevTools Protocol（CDP）連接 Chromium 系瀏覽器。CLI 提供命令列介面與 `nodejs` 腳本入口；本機 daemon 管理瀏覽器連線與工作狀態；SDK 提供 TaskSpace、頁面與互動操作介面。

執行環境基線為 Node.js `>=22`。`package.json` 未列出 npm runtime dependencies。

## 2. 模組地圖

| 路徑 | 職責 |
|---|---|
| `package.json` | ESM 套件資訊、Node.js 版本基線與 CLI 命令入口。 |
| `bin/tp-browser.js` | `tp-browser` CLI、健康檢查、診斷與 `nodejs` 腳本執行入口。 |
| `bin/ego-browser.js` | 相容命令入口；修改 CLI 行為時，檢查它與 `tp-browser.js` 是否需要同步。 |
| `lib/sdk.js` | CLI 腳本使用的 SDK 與 daemon 用戶端介面。修改 SDK 前，追蹤其 RPC 與事件呼叫路徑。 |
| `daemon/tp-browserd.js` | daemon 入口；HTTP/RPC、健康狀態與瀏覽器連線流程的主要檢查位置。 |
| `daemon/ego-browserd.js` | 相容 daemon 入口；確認其與 `tp-browserd.js` 的實際共用或差異方式。 |
| `daemon/cdp.js` | CDP WebSocket 用戶端、請求配對、事件通知、session 與逾時處理。 |
| `daemon/store.js` | TaskSpace 與頁面標籤帳本的 JSON 載入、更新與持久化。 |
| `daemon/page-ops.js` | 頁面操作相關實作；新增頁面能力時應追蹤 SDK 到此處的呼叫鏈。 |
| `daemon/keys.js` | 鍵名、修飾鍵與按鍵組合至 CDP 欄位的對應。 |
| `daemon/inpage.agent.js` | 頁面內 Agent 支援程式；修改注入行為時，注意頁面執行環境與 daemon 的邊界。 |
| `scripts/tp-start.sh`、`scripts/tp-stop.sh` | macOS/Linux 的啟動、停止與背景程序管理。 |
| `scripts/ego-start.ps1`、`scripts/ego-stop.ps1` | Windows 的啟動、停止與程序管理。 |
| `tools/profile-init.js` | Profile 初始化及可能的本機瀏覽器資料同步。執行前先確認影響範圍。 |
| `tests/` | 本機測試頁、服務與 smoke/benchmark 腳本。使用前確認其執行方式與輸出位置。 |
| `skills/tp-browser/SKILL.md` | Agent 使用方式與 SDK 操作範例。若公開介面有變動，檢查是否需更新。 |

## 3. 概念資料流

一般 `tp-browser nodejs` 工作流程可概括如下：

1. CLI 從 `-e` 參數或 stdin 取得腳本，檢查本機 daemon 健康狀態；必要時呼叫平台啟動器。
2. CLI 建立 SDK 用戶端，將 TaskSpace 與頁面操作轉成 daemon 請求，並訂閱事件推送。
3. daemon 接收本機請求，管理工作空間與頁面 target，並將瀏覽器操作交由 CDP 用戶端執行。
4. CDP 用戶端透過 WebSocket 將命令送至瀏覽器，並將回覆與事件交回 daemon。
5. 結果沿 SDK 與 CLI 路徑回到工作腳本；TaskSpace 狀態則由 Store 保存，供後續檢查或重新連結。

這是高階概念流程。各 RPC 名稱、事件格式、重試策略與頁面操作的實際分工，應以 `lib/sdk.js` 與 daemon 目前實作為準。

## 4. 常見修改路徑

### 新增或調整 Agent 可用的 SDK 方法

1. 在 `lib/sdk.js` 找到現有相近介面與 RPC 呼叫方式。
2. 確認 daemon 是否已有對應操作；若沒有，再沿 daemon 的 RPC 處理路徑新增。
3. 若操作需要 CDP，沿用既有 CDP 用戶端與 session 處理方式。
4. 更新 Skill 文件或其他使用範例，並以本機測試頁驗證，不依賴正式網站。

### 新增或調整頁面操作

1. 從 SDK 方法追蹤至 daemon 的頁面操作處理。
2. 檢查 `daemon/page-ops.js` 中既有操作的逾時、錯誤與結果轉換方式。
3. 若操作涉及鍵盤輸入，確認 `daemon/keys.js` 的鍵名及修飾鍵對應。
4. 確認跨平台差異是否屬於啟動器責任，避免將平台專屬邏輯塞入共用頁面操作。

### 修改 TaskSpace 或頁面生命週期

1. 檢查 `daemon/store.js` 的建立、標籤序號、綁定、移除與刪除行為。
2. 追蹤 daemon 如何將 Store 中的 target 重新連結至瀏覽器。
3. 考慮瀏覽器重啟、target 消失、JSON 格式舊版或損毀等情況。
4. 不要將 Store 的持久化記錄誤當成頁面內容或瀏覽器本身的完整備份。

### 修改啟動、停止或連接埠

1. 分別檢查 Windows PowerShell 與 macOS/Linux shell 腳本。
2. 確認 daemon 與 CDP 連接埠配對、替代連接埠狀態以及 CLI 的狀態讀取相互一致。
3. 檢查 daemon 是否先於瀏覽器啟動，以及停止時是否處理既有程序與 Profile 鎖。
4. 修改任一 CLI 別名時，檢查另一個入口及安裝腳本的引用。

### 修改本機檔案或 Profile 行為

1. 先查明資料來源、目的地與覆寫條件，特別注意 `tools/profile-init.js` 可能讀取或同步本機瀏覽器 Profile。
2. 不要在測試中使用開發者的日常 Profile。
3. 測試輸出與文件不得包含登入資料、Cookie、網頁私密內容或其他使用者資料。
4. 檔案路徑處理應遵循 daemon 既有的限制與安全檢查，不要新增任意路徑讀寫能力。

## 5. 常見陷阱

- **Node.js 版本**：專案以 Node.js 22 以上為基線；不要假設較舊版本具備相同的內建 WebSocket 行為。
- **Windows ESM 路徑**：Windows 路徑不能一律當作一般 `import()` 字串；CLI 使用 `pathToFileURL()` 載入暫存腳本，修改時要保留跨平台路徑處理。
- **雙 CLI 入口**：`tp-browser.js` 與 `ego-browser.js` 都是套件命令入口；修改一方前先確認另一方是否獨立實作或需要同步。
- **共用 Profile**：有頭與無頭模式共用 Agent Profile。不要同時啟動兩個使用同一 Profile 的瀏覽器程序。
- **Profile 可能含敏感資料**：避免複製、提交、列印或截圖其中的使用者資料。
- **TaskSpace 不等於頁面仍存在**：Store 保存的是可重新連結的記錄；瀏覽器 target 消失後，記錄必須按實際狀態處理。
- **連接埠成對變更**：只更新 daemon 或 Chrome 的其中一個連接埠，可能令 CLI 健康檢查與操作失敗。
- **SSE 會影響程序結束**：CLI 註解指出事件串流可能讓 Node.js event loop 保持存活；修改腳本生命週期時，確認串流清理與結束行為。
- **啟動器是平台專屬層**：Unix shell 與 Windows PowerShell 使用不同的程序管理方式；修改時不能只依賴單一平台的測試結果。
- **安全說明需對照實作**：README 描述了本機服務的安全要求；新增路由或檔案操作時，需在 daemon 原始碼確認檢查確實套用。

## 6. 測試與驗證原則

- 使用 repo 內的本機測試頁與本機服務驗證瀏覽器互動；不要讓測試連線正式服務。
- 先閱讀測試腳本的輸出路徑與啟動方式；不要假設測試只會在 repo 內讀寫。
- 需要假授權值時使用 `FAKE_VALUE_FOR_TEST` 這類明顯假字串。
- 不以真實帳號、登入狀態、Cookie 或敏感網頁內容作為 fixture。
- 本次文件整理未執行 runtime、browser 或 smoke 測試；文件內容不能替代實作驗證。
