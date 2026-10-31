# ADR-0002：以本機 daemon 作為 CLI、SDK 與瀏覽器之間的邊界

- **狀態**：現行設計
- **範圍**：CLI、SDK、daemon、瀏覽器通訊

## 背景

CLI 的註解指出，它不直接啟動瀏覽器程序來執行 Agent 操作，而是透過 HTTP 與 SSE 和 daemon 通訊。`bin/tp-browser.js` 的 `nodejs` 子命令會載入 `lib/sdk.js`、建立 RPC 用戶端，並提供 TaskSpace 與頁面相關全域介面。daemon 再透過 CDP 與瀏覽器互動。

## 決策

採用分層通訊路徑：

1. CLI 接收命令或 stdin 腳本，並處理啟動器、健康檢查等入口工作。
2. SDK 將工作腳本操作轉換為 daemon 可處理的請求，並接收推送事件。
3. daemon 管理瀏覽器連線與工作狀態，透過 CDP 操作瀏覽器。
4. 瀏覽器提供頁面執行環境與 CDP 事件。

HTTP/RPC 用於命令請求，SSE 用於事件推送；CDP 使用 Node.js 內建 WebSocket。

## 取捨

- **優點**：CLI 與瀏覽器生命週期分離；可在一次 `nodejs` 腳本中完成多步操作；SDK 不必自行管理瀏覽器程序。
- **代價**：增加本機 daemon、HTTP/RPC 與事件串流的生命週期管理；需要處理 daemon 尚未就緒、瀏覽器斷線與請求逾時。
- **代價**：跨層功能修改時，必須維持 CLI、SDK、daemon 與 CDP 之間的契約一致。

## 後果

- 新增 Agent 可呼叫的能力時，先追蹤 SDK 呼叫路徑與 daemon 的 RPC 處理，再選擇最小範圍的修改位置。
- 修改事件時，應確認產生事件的一方、SSE 接收端與等待事件的 SDK 行為。
- 修改啟動或健康檢查時，應分清 CLI 的啟動器工作與 daemon 的瀏覽器連線工作。
- 本 ADR 描述高階資料流；daemon 路由與 SDK 細節應以 `daemon/tp-browserd.js`、`lib/sdk.js` 的目前實作為準。
