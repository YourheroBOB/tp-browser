# ADR-0005：跨平台啟動器與連接埠配對

- **狀態**：現行設計
- **範圍**：Windows、Linux、macOS 啟動與本機連線

## 背景

核心程式以 JavaScript 共用，但瀏覽器啟動、程序管理與桌面 GUI 行為依作業系統而異。repo 提供 Windows PowerShell 與 Unix shell 啟動腳本。Unix 啟動器以 daemon 與 Chrome 連接埠配對運作；`--alt-port` 可使用另一組連接埠。Windows 啟動器會檢查預設 Chrome 連接埠是否已有 Linux 瀏覽器服務，必要時改用替代配對。

## 決策

- 將平台相關程序啟動與停止邏輯放在各平台啟動腳本中，核心瀏覽器控制仍由共用 JavaScript 模組負責。
- 將 daemon 與 Chrome CDP 連接埠視為一組，並支援預設與替代配對。
- CLI 透過 `daemon.json` 判斷目前使用的配對；健康檢查以 loopback 位址連線。
- 保留 `tp-browser` 與 `ego-browser` 相容命令入口。

## 取捨

- **優點**：可處理 Windows 桌面工作階段、Unix 背景程序與 WSL 等不同平台需求，同時共用大部分核心程式。
- **代價**：啟動行為分散在多份腳本，修改時需要避免平台間參數或生命週期不一致。
- **代價**：替代連接埠選擇與狀態檔必須一致；只改其中一處可能造成 CLI 連不到服務。
- **代價**：相容別名增加入口，但需要維持使用體驗與行為一致。

## 後果

- 修改連接埠時，檢查 daemon、Chrome 啟動參數、CLI 讀取狀態與診斷指令是否同步。
- 修改啟動器時，分別考慮 Windows 與 Unix shell 路徑，並注意 WSL 環境的連接埠共存情況。
- 修改 `bin/tp-browser.js` 或 `bin/ego-browser.js` 時，應確認另一個 CLI 入口是否需要相同變更；`package.json` 將兩者都列為命令入口。
