# 01 — 資產、信任邊界與資料流

本檔建立後續 STRIDE 分析的基底：先確認「有什麼值得保護」（A）、「信任在哪裡切斷」（TB）、「東西怎麼流動」（DF），最後列出「攻擊者可以從哪裡開始」（入口表）。

## 1. 系統元件與部署形態

```text
                       +---------------------------+
                       |        網際網路 / 網站       |
                       +-------------+-------------+
                                     |
                       (TB1) 不可信內容邊界
                                     |
+------------------+      CDP(WS)   +---------------------------+
|  瀏覽器（Chrome /  |<--------------|  daemon (browserd)         |
|  Edge / Chromium） |  127.0.0.1:   |  HTTP + SSE, 127.0.0.1:    |
|  profile-agent/    |   9773/9775  |   9772/9774                |
+---------+---------+   (TB3)       +------+--------------+-----+
          |                                |              |
          | 使用者資料落地                   | (TB4) token  | (TB5) 檔案系統
          v                                v              v
   profile-agent/{Cookies,        CLI / SDK（bin/*.js,   DATA_DIR/
   Login Data, Local Storage,     lib/sdk.js）           {token, daemon.json,
   IndexedDB, Local State}              |                 store.json, logs/,
                                        | (TB6)           cookies.json,
                                        v                 workspace}
                                 LLM 代理 / Agent 腳本
                                 （tp-browser nodejs）

  跨邊界：TB7 WSL2 ↔ Windows 主機；TB8 SSH Session 0 ↔ 互動桌面 Session 1；
          TB9 安裝來源 ↔ 家目錄與 agent skills 目錄；TB10 同機其他 OS 使用者 ↔ loopback 埠
```

## 2. 資產清單（A）

| ID | 資產 | 位置 | 洩漏/篡改後果 | 目前保護 | 證據 |
|---|---|---|---|---|---|
| `A1` | 主控 bearer token | `~/.local/share/ego-linux/token` | 取得即等於取得整個代理瀏覽器控制權（導航、讀 cookie、下載、上傳） | 檔案權限（依 `C6`）、常數時間比對（`C3`） | `[CODE]` CLI 讀取該檔 |
| `A2` | agent profile 的登入態 | `profile-agent/Default/{Cookies, Local Storage, IndexedDB}` | 全站帳號接管（含 `HttpOnly` session） | 作業系統檔案權限 | `[CODE]` profile 路徑與同步邏輯可見 |
| `A3` | **母瀏覽器**的已存密碼與解密金鑰 | `profile-agent/Default/{Login Data, Login Data For Account, Web Data}` + `profile-agent/Local State`（`os_crypt`） | 等同「母瀏覽器所有網站密碼」可被離線解密 | 無額外保護 | `[CODE]` `tools/profile-init.js` 明文複製 |
| `A4` | 任務帳本（TaskSpace 狀態） | `store.json`（`daemon/store.js` 寫入） | 洩漏瀏覽過的 URL/標題（可能含案件、客戶、健康、金融資訊）；篡改 `targetId` 可讓代理操作到錯誤頁面 | 依賴 `DATA_DIR` 目錄權限，**檔案本身未設定 `0600`** | `[CODE]` |
| `A5` | 代理腳本與其輸出 | 經 stdin/`-e` 傳入 → 暫存 `$TMPDIR/tp-run-*/script.mjs`（`0600`） | 內含提示與擷取內容；SIGKILL 時不會被清掉 | `mkdtempSync`（`0700`）+ `0600` | `[CODE]` |
| `A6` | 工作區檔案（截圖、下載、上傳來源） | 由腳本相對路徑決定 | 覆寫任意檔案（若路徑檢查有縫）、外流下載物 | `C4` `safePath` | `[DOC]`/`[HYP]` |
| `A7` | CDP 端點 | `127.0.0.1:9773` / `9775` | **無任何認證**；可 `Network.getAllCookies`、任意導航、注入腳本 | 僅 loopback 綁定（`C1`） | `[CODE]` 啟動旗標 |
| `A8` | daemon HTTP/SSE | `127.0.0.1:9772` / `9774` | 讀寫任務狀態、觸發關閉 | `C2`+`C3`（`/rpc`），但 shell 腳本顯示存在**無 token 端點** | `[CODE]` 腳本以無 token 方式呼叫 `/flush-and-close`、`/health` |
| `A9` | 寫給 LLM 代理的指示檔 | `~/.claude/skills/tp-browser/SKILL.md`、`~/.agents/skills/...`、`~/.codex/skills/...`、`~/.gemini/config/skills/...` | 被改寫即等於在未來每個代理 session 植入指令 | 無簽章、無完整性檢查 | `[CODE]` `install.sh`、`install.ps1` |
| `A10` | 安裝來源與安裝產物 | GitHub repo、`~/.local/bin/*`、`/usr/local/bin/*`（可寫時） | 供應鏈替換 → 任意程式碼 | 無 pin、無 checksum | `[CODE]` |
| `A11` | 作業系統工作階段 | Windows Session 0（SSH）/ Session 1（互動桌面）、排程工作 `TooPowerBrowserHeaded` | 從非互動 session 於使用者桌面執行程式 | 無（設計即如此） | `[CODE]` `scripts/ego-start.ps1` |
| `A12` | 證據完整性（擷取結果） | snapshot / screenshot / `text()` 輸出 | 若無雜湊與時戳，事後無法證明未被修改 | 無 | `[CODE]`（未見任何雜湊/時戳機制） |
| `A13` | 可用性（任務進行中的瀏覽器狀態） | daemon + 瀏覽器行程 | 中斷即需重跑長時間任務 | 無 | `[CODE]` |
| `A14` | 使用者的既有登入狀態本身 | 網站端 session | 被登出、被風控標記 | 部分靠反偵測旗標 | `[CODE]`/`[DOC]` |

## 3. 信任邊界（TB）

| ID | 邊界 | 跨越的資料 | 邊界是否被程式碼「強制」 | 備註 |
|---|---|---|---|---|
| `TB1` | 網頁內容 ↔ 代理推理 | 頁面文字、DOM、下載物 | **否** | 頁面文字會原樣進入 LLM 上下文（`[CODE]`：`p.text()`/`evaluate` 直接回傳） |
| `TB2` | 頁面主世界 ↔ 注入腳本世界 | DOM 標記 `@N`、`window.__egoAgent` | 部分（`C5` 正則校驗） | `[DOC]` |
| `TB3` | 瀏覽器 ↔ CDP 埠 | 完整瀏覽器控制權 | 僅「loopback」 | **無身分驗證**（`[CODE]`） |
| `TB4` | CLI/SDK ↔ daemon | RPC、SSE 事件 | 是（token，`C3`） | 但存在無 token 端點（`[CODE]`） |
| `TB5` | daemon ↔ 檔案系統 | 路徑、檔案內容 | 部分（`C4`） | 細節需以程式碼覆核（`[HYP]`） |
| `TB6` | LLM 代理 ↔ 本機執行環境 | 任意 Node.js 程式碼 | **否**（設計即全權） | `[CODE]` `runNodeJs()` 直接 `import()` |
| `TB7` | WSL2 Linux ↔ Windows 主機 | token、`daemon.json`、埠 | 否 | `[CODE]` `tp-start.sh` 會把 Windows 端 token 複製進 WSL 家目錄 |
| `TB8` | SSH Session 0 ↔ 互動桌面 Session 1 | GUI 啟動指令 | 否（刻意打通） | `[CODE]` `schtasks /IT` |
| `TB9` | 安裝來源 ↔ 家目錄／全域 bin／agent skills | 可執行檔與代理指示 | 否 | `[CODE]` `curl ... | bash` 支援、`git clone --depth 1`（未 pin） |
| `TB10` | 同機其他 OS 使用者 ↔ loopback 埠 | 若無防火牆隔離則完全相通 | 否 | loopback 在 Linux/Windows 上**不是 per-user 隔離**（`[CODE]` 架構事實） |

> `TB10` 是本模型最容易被誤解的一點：`C1`（loopback 綁定）只阻擋「來自網路的連線」，對「同一台機器上的其他行程或其他 OS 使用者」沒有效果。`README.md` 已提示多使用者主機需使用獨立 OS 帳號，但獨立帳號**不會**阻擋對 `127.0.0.1:9773` 的連線。

## 4. 資料流（DF）

| ID | 路徑 | 內容 | 跨越邊界 | 風險摘要 |
|---|---|---|---|---|
| `DF1` | 網站 → 瀏覽器渲染程序 → `page-ops`/`inpage.agent` → daemon → CLI → stdout → LLM | 頁面文字、DOM、檔案 | `TB1`、`TB4`、`TB6` | 提示注入；敏感內容外送第三方 LLM（`I-05`） |
| `DF2` | LLM/使用者 → CLI stdin → `$TMPDIR/tp-run-*/script.mjs` → `import()` | 任意程式碼 | `TB6`、`TB5` | 全權執行；暫存殘留（`I-07`） |
| `DF3` | daemon ↔ 瀏覽器 CDP | 全瀏覽器控制、cookie 讀寫 | `TB3` | 端點無認證（`I-01`） |
| `DF4` | CLI ↔ daemon HTTP/SSE | RPC + token | `TB4` | token 是否進 URL 查詢字串（`I-04`，`[HYP]`） |
| `DF5` | `profile-init.js` → `profile-agent/Default/*` | Bookmarks、Favicons、Cookies、**Login Data**、**Local State `os_crypt`**、Local Storage、IndexedDB | 母瀏覽器 → agent profile | 憑證集中化（`I-03`）；覆蓋競態（`T-08`） |
| `DF6` | daemon → `store.json` / `logs/*.log` / `workspace/*` | 任務狀態、日誌、截圖、下載 | `TB5` | 權限與內容敏感度（`T-02`、`I-06`） |
| `DF7` | WSL2 `tp-start.sh` ← Windows `~/.local/share/ego-linux/{token,daemon.json}` | 認證憑證 | `TB7` | 跨 OS 共用同一 bearer（`I-09`） |
| `DF8` | `install.sh`/`install.ps1` → `~/.local/bin`、`/usr/local/bin`、`~/.{claude,agents,codex,gemini}/skills` | 可執行檔 + 代理指示 | `TB9` | 供應鏈與代理行為植入（`T-06`、`E-04`、`S-05`） |
| `DF9` | `ego-start.ps1` → `launch-headed-gui.ps1` → `schtasks /IT` | PowerShell 腳本 + 排程工作 | `TB8` | Session 0→1 執行橋接（`E-03`） |
| `DF10` | 使用者手動 `tp-browser nodejs < tools/cookies-export.ego.js`（`README`/`SKILL` 指示） | 從**當前工作目錄**讀取的檔案 | `TB6` | 該檔案在 repo 中不存在 → CWD 內容被執行（`T-11`） |

## 5. 攻擊面入口表（攻擊者可以從哪裡開始）

| 起點 | 可觸及的資產 | 需要的先決條件 | 對應威脅 |
|---|---|---|---|
| 被瀏覽的網頁（含第三方 iframe、廣告、下載物） | `A5`、`A6`，間接 `A1`、`A2`（透過提示注入） | 代理訪問該頁 | `S-04`、`T-05`、`E-02` |
| 同機其他 OS 使用者／其他行程 | `A2`（透過 CDP）、`A13`、`A4` | 能連 `127.0.0.1` | `I-01`、`D-01`、`D-02` |
| 同機同使用者的惡意行程 | 全部 | 已在使用者權限下執行 | `S-01`、`I-02`、`T-01`、`T-02` |
| 供應鏈（repo、clone 來源、Skill 檔） | `A9`、`A10`、`A11` | 使用者執行安裝或更新 | `T-06`、`S-05`、`E-04` |
| 工作目錄內容（`tools/*.ego.js` 不存在） | `A1`、`A2`、`A5` | 代理照文件執行 | `T-11` |
| LLM 代理本身（幻覺或被誘導） | `TB6` 之後的一切 | 代理可執行 shell | `E-02`、`T-05` |
| 系統日誌／事件記錄的旁觀者 | profile 路徑、旗標、啟動參數 | 讀取系統日誌 | `I-06`（低） |

## 6. 資產 × 邊界對照（用於檢查「防護是否放在正確的一側」）

| 資產 | 主要跨越邊界 | 防護目前放在哪一側 | 是否足夠 |
|---|---|---|---|
| `A1` token | `TB4`、`TB7` | CLI 讀檔 + daemon 比對 | 部分（端點涵蓋不全、跨 OS 共用、無輪替） |
| `A2` 登入態 | `TB3`、`TB5` | 作業系統檔案權限 | 不足（CDP 無認證可繞過檔案權限） |
| `A3` 母瀏覽器密碼 | `TB5` | 無 | 不足（預設複製，且含解密金鑰） |
| `A5` 代理腳本 | `TB6` | 暫存檔權限 | 不足（無執行期權限限制） |
| `A9` Skill 指示 | `TB9` | 無 | 不足（等同未簽章程式碼） |
| `A12` 證據 | `TB5` | 無 | 不足（無雜湊/時戳） |
