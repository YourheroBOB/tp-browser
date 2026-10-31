# ADR-0001：使用 Node.js 原生能力與 CDP

- **狀態**：現行設計
- **範圍**：執行環境、瀏覽器通訊

## 背景

專案需要跨 Windows、Linux 與 macOS 控制 Chromium 系瀏覽器，同時維持小型執行環境與精簡安裝流程。`package.json` 指定 Node.js `>=22`，未列出 npm runtime dependencies；`daemon/cdp.js` 說明其 CDP 通訊使用 Node.js 內建 WebSocket，並採用 flat session protocol。

## 決策

- 以 ESM JavaScript 作為主要實作形式。
- 以 Node.js 內建能力處理執行環境所需的功能；瀏覽器控制透過 Chrome DevTools Protocol（CDP）。
- 以 Node.js 22 以上作為正式執行環境基線，不將外部自動化框架列為必要依賴。

## 取捨

- **優點**：依賴樹與安裝負擔小；CDP 直接提供瀏覽器原生控制介面；較容易共用跨平台的核心程式。
- **代價**：需要自行負責 CDP 請求、事件、session 與錯誤處理；使用者必須準備相容的 Node.js 與 Chromium 系瀏覽器。
- **代價**：Node.js 版本差異可能影響內建 API 支援；低於指定版本的環境不應視為受支援基線。

## 後果

- 修改 CDP 通訊時，先確認 `daemon/cdp.js` 的連線、請求逾時、事件與 session 行為，避免在高層模組重複實作另一套傳輸。
- 新增依賴前，應評估是否能用 Node.js 內建能力完成，以及對零依賴定位和安裝方式的影響。
- 測試應使用本機測試頁與瀏覽器，不應依賴正式網站或外部服務。
