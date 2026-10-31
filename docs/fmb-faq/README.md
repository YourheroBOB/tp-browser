# tp-browser FAQ 與疑難排解（fmb-faq）

> **文件狀態**：疑難排解參考文件，僅新增，未修改任何既有程式或文件。  
> **內容基準**：以本 repo 預設分支內容快照為依據（`README.md`、`STATE.md`、`bin/`、`daemon/`、`scripts/`、`tools/`、`lib/`、`tests/`、`install.*`、`fmb_feature2/` 等）。  
> **安全邊界**：本文不含任何實際 token、金鑰、密碼、客戶資料、訊息內文或案件資料；示例憑證一律使用 `FAKE_VALUE_FOR_TEST`。

本目錄從**使用者**（安裝、啟動、登入、日常操作）與**開發者**（腳本、API、測試、維運）兩個角度，整理 tp-browser 最常見的問題與疑難排解。每題包含：**問題、原因、解法、相關檔案**。

## 文件索引

| 文件 | 主題 | 適合對象 |
|---|---|---|
| [`01-install-and-environment.md`](./01-install-and-environment.md) | 安裝、Node 版本、瀏覽器偵測、PATH | 使用者／開發者 |
| [`02-startup-and-ports.md`](./02-startup-and-ports.md) | 啟動失敗、埠位衝突、健康檢查、停止服務 | 使用者／開發者 |
| [`03-headed-vs-headless.md`](./03-headed-vs-headless.md) | 有頭／無頭切換、Cloudflare、人工登入 | 使用者 |
| [`04-agent-scripting.md`](./04-agent-scripting.md) | `tp-browser nodejs` 腳本常見錯誤 | 開發者 |
| [`05-cookies-and-profile.md`](./05-cookies-and-profile.md) | Cookie 主權、Profile 初始化、資料同步 | 使用者／開發者 |
| [`06-security.md`](./06-security.md) | Token 認證、loopback 限制、權限 | 開發者／維運 |
| [`07-taskspace-ledger.md`](./07-taskspace-ledger.md) | TaskSpace ledger 膨脹與回收（reaper） | 開發者／維運 |
| [`08-windows-troubleshooting.md`](./08-windows-troubleshooting.md) | Windows 原生版專屬疑難 | 使用者／維運 |
| [`09-testing.md`](./09-testing.md) | 冒煙測試、整合測試與測試邊界 | 開發者 |

## 快速導診

| 症狀 | 先看 |
|---|---|
| 裝完打 `tp-browser` 沒反應 | 01（PATH／Node 版本） |
| `TP_NOT_READY` / `EGO_NOT_READY` | 02（啟動與埠位） |
| 網站被 Cloudflare 擋、需要 2FA | 03（tp-headed 人機共乘） |
| `nodejs` 腳本拋 ESM／BOM／逾時錯誤 | 04 |
| 登入態不見／Cookie 沒同步 | 05 |
| 遠端機器連不上 daemon | 06（loopback 是刻意設計） |
| `tp-browser spaces` 一堆殭屍分頁 | 07 |
| SSH 進 Windows 看不到有頭視窗 | 08 |
| 想跑 23/23 冒煙測試 | 09 |

## 共通第一步

遇到任何問題，先跑：

```bash
tp-browser doctor     # 完整環境健檢與修復指引
tp-browser status     # daemon 與 Chrome 連線狀態
```

`doctor` 會分別檢查 daemon（127.0.0.1:9772 或 9774）與 Chrome CDP（127.0.0.1:9773 或 9775），並印出對應平台的修復指令。
