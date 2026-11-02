# 02 — 個人資料類別、儲存位置與流向

## 0. 前提

本工具為單機本機軟體：daemon 與 CDP 皆綁 `127.0.0.1`，`tp-browser` 自身（就本輪已提供的程式碼而言）不做任何對外傳輸。**但「本機儲存」不等於「沒有個資處理」**，且有一個由使用模式引入的重要對外流向（見第 3 節）。

## 1. 資料類別與儲存位置盤點

以下均以 `~/.local/share/ego-linux/`（Windows 為 `%USERPROFILE%\.local\share\ego-linux\`）為根。權限現況：`DATA_DIR` 設 `0700`（`install.sh`、`tp-start.sh`）、`token`／`daemon.json` 設 `0600`、`cookies.json` 匯出時 `0600`（README 宣稱；對應 `tools/cookies-export.ego.js` 不在本輪快照內，標**未驗證**）；Windows 端 `icacls` 限當前使用者。

| # | 資料 | 個資法類別（§2 例示） | 產生／寫入者 | 位置 | 機敏度 |
|---|---|---|---|---|---|
| 1 | 登入態 Cookies（含 HttpOnly Session） | 網路活動紀錄／帳號識別 | 瀏覽器運行；`tools/profile-init.js` 從使用者主瀏覽器**初始複製** | `profile-agent/Default/Network/Cookies`（或舊位置） | 高（等同帳號控制權） |
| 2 | 已存密碼資料庫 `Login Data`／`Login Data For Account` | 帳號、密碼（間接） | `tools/profile-init.js` 從主瀏覽器**複製**（來源 OS 加密） | `profile-agent/Default/` | 極高 |
| 3 | `Web Data`（自動填表：住址、電話、部分付款資訊） | 姓名、聯絡方式、財務 | 同上，**複製** | `profile-agent/Default/` | 極高 |
| 4 | `Local State` 的 `os_crypt` 金鑰材料 | 加密金鑰（機敏保安資料） | `tools/profile-init.js` **連同 Cookies 一起複製**，使複製過來的加密資料在新 profile 可被解密 | `profile-agent/Local State` | 極高 |
| 5 | 書籤、Favicons、Local Storage、IndexedDB（https_* origins） | 網路活動／站點本地資料（可能含第三人個資） | `tools/profile-init.js` 複製＋日常瀏覽累積 | `profile-agent/Default/` | 中高 |
| 6 | 瀏覽軌跡 ledger（空間名、分頁 `title`、`url`、`createdAt`） | 網路活動紀錄（可能含案件主題） | `daemon/store.js` 每次 `create`／`setPage` 寫入 | Store JSON（daemon 資料目錄） | 中高 |
| 7 | daemon／Chrome 日誌 | 網路活動、本機路徑、錯誤內容 | `console.*` 重定向（`spawn_detached` 以 append 開檔） | `logs/daemon.log`、`logs/chrome.log` | 中（詳見 `04-log-leak-fields.md`） |
| 8 | daemon 認證 token、`daemon.json` | 機敏保安資料 | daemon 啟動 | 資料根目錄 | 高 |
| 9 | Cookie 匯出檔 `cookies.json` | 同 #1，且為**可搬運的明文彙整** | 匯出工具（README 宣稱；檔案未在快照內，未驗證） | 資料根目錄，0600 | 極高 |
| 10 | Agent 擷取的頁面內容（DOM、對話紀錄、文件） | 視內容而定，可能含**第三人／當事人個資** | `page.evaluate`／`snapshot` 等（`lib/sdk.js`、`page-ops.js`，部分未驗證） | 記憶體＋由 Agent 腳本決定寫入位置 | 視來源而定，可能極高 |
| 11 | 安裝足跡（SKILL.md 複製到 `~/.claude`、`~/.agents`、`~/.codex` 等） | 非個資，屬組態 | `install.sh`／`install.ps1` | 多個 agent 設定目錄 | 低（但屬「未明示即寫入使用者目錄」的行為，宜提示） |

## 2. 產生／流入路徑

```
使用者主瀏覽器 profile ──(profile-init.js 主動掃描、評分、複製)──▶ profile-agent
                                                              │（#1–#5 未經明示同意即完成）
使用者的瀏覽與登入行為 ─────────────────────────────────────▶ profile-agent（日常累積）
agent 工作流（taskSpace/page 操作）─────────────────────────▶ store ledger（#6）
daemon／瀏覽器執行 ────────────────────────────────────────▶ logs（#7）
```

`tools/profile-init.js` 的掃描範圍含 Google Chrome、Edge、Brave、Chromium、Comet（macOS）等使用者全部本機 profile，並以「書籤數＋Favicons 大小＋LocalStorage 大小」評分挑出**資料最豐富的一個**做為複製來源。此「挑最大」策略在合規上是反向的：**它最大化了被複製的個資量**。

## 3. 流出／對外流向

1. **（工具自身）無對外傳輸**：本輪提供的程式碼中，唯一的網路請求皆為 `127.0.0.1` 的 health／CDP／flush 端點；`daemon/*` 未完整提供，標**未驗證**，建議以「零對外連線」為正式驗收條件補測。
2. **（使用模式，最重要）**：README 示範的工作流是把 `page.evaluate`／`snapshot` 擷取的頁面內容（如 AI 服務的對話紀錄）交給外部 LLM API（模型服務商）做分析。此時**頁面內容中的個人資料（含對話中的第三人資料、案件資料）即跨境流出本機**。工具不傳，但預設賣點（「Token 狂省的批次擷取」）正是圍繞此流程設計。
3. **（跨機遷移）**：`cookies.json` 匯出／匯入工作流把登入態變成可攜檔案；檔案離開原機後的控管不在工具掌握內。
4. **（repo 文件）**：`STATE.md` 與驗收報告記錄了內部主機環境與工作連結（本文件不複製其內容）；若 repo 轉公開或被授權者存取，屬組織內部中繼資料外露。

## 4. 當事人範圍

- **主要當事人**：使用者本人（其帳號、密碼、瀏覽紀錄）。
- **次要當事人**：被擷取頁面內容中的第三人（對話對象、網頁中的當事人、案件關係人）。**工具的設計沒有為這一層當事人提供任何告知或最小化機制**，這是 §19／§5 層面的主要缺口。
