# tp-browser 資安與可靠性稽核檢查清單

本清單根據本次提供的程式碼片段作成。**已檢視**只代表完成靜態閱讀，不代表通過動態測試或完整驗證。

## 已檢視

- [x] `package.json` 的 Node.js 版本與 npm 相依宣告。
- [x] CLI `nodejs` 執行邊界、stdin 收集及錯誤處理。
- [x] Linux／macOS 啟動器的 shell 參數傳遞與 root sandbox 設定。
- [x] 瀏覽器啟動使用 loopback CDP 端點的配置。
- [x] Profile 初始化對 Cookies、登入資料與站點儲存資料的複製行為。
- [x] Store JSON 載入、寫入、rename fallback 與跨程序併發風險。
- [x] CDP client 的 pending request 與 timer 清理方式。
- [x] 安裝器取得程式碼時是否固定版本。
- [x] `spawnSync()` 結果及 Profile 初始化失敗的處理方式。
- [x] 沒有執行外部網路請求，沒有讀取或輸出實際憑證／個資。

## 未驗證：需取得完整程式碼或在隔離環境測試

- [ ] `daemon/ego-browserd.js`、`daemon/tp-browserd.js`：HTTP Host／Origin 驗證、認證、CSRF、防重放、路由授權與錯誤回應。
- [ ] daemon 與 SDK：RPC method／params 驗證、JSON body 大小限制、請求期限、併發上限及拒絕服務防護。
- [ ] `daemon/page-ops.js`、`lib/sdk.js`：`safePath`、路徑穿越、symlink／TOCTOU、上傳／下載及截圖路徑限制。
- [ ] `daemon/inpage.agent.js`：DOM 標記驗證、頁面內容與控制指令的信任邊界。
- [ ] daemon 與 `daemon/cdp.js` 整合：CDP WebSocket URL 來源驗證、連線目的地限制、斷線後重試與 pending 清理。
- [ ] Windows 啟動及安裝流程：命令列 quoting、程序終止範圍、檔案 ACL、安裝路徑 symlink 與失敗回復。
- [ ] POSIX／Windows Profile 資料的實際檔案權限、資料庫一致性、初始化的使用者同意與復原流程。
- [ ] 多 daemon 共用 Store 時的鎖定、原子性、資料競爭與 schema 驗證。
- [ ] 固定版本後的 SBOM、相依與瀏覽器二進位盤點；不連線正式服務的離線掃描。
- [ ] 合成資料測試：畸形 JSON、超大輸入、錯誤路徑、symlink、啟動失敗、CDP 斷線及逾時。
- [ ] 多平台可靠性測試：Node.js 支援版本、Windows／Linux／macOS 的啟動、停止、權限與併發情境。

## 執行狀態

- 本次僅做靜態檢視，未執行測試或動態驗證。
- 未建立、讀取或寫入 repo 以外的測試資料；未連線正式服務。
