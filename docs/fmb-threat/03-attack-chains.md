# 03 — 攻擊鏈（Attack Chains）

單一威脅的影響有限；本檔把 `02` 的條目組成可實際操作的鏈，標明**前提**、**步驟**、**偵測點**、**阻斷點**。每條鏈都標示證據等級，`[CODE]` 表示步驟中的關鍵環節已由可見程式碼證實。

---

## AC-1：同一台機器的另一個使用者 → 全部登入態（無需 token）

| 項目 | 內容 |
|---|---|
| 前提 | 多使用者主機（或同一使用者下的另一個惡意行程）；`P1` 前提失效 |
| 步驟 | 1. `GET http://127.0.0.1:9773/json/list` 取得頁面 target<br>2. 取 `webSocketDebuggerUrl`<br>3. `Network.getAllCookies` → 取得含 `HttpOnly` 的 session<br>4. 帶到自己的環境重放 |
| 影響 | `A2` 全數洩漏；對使用者而言是「所有網站同時被登入」 |
| 偵測點 | CDP 連線數異常；`/json/list` 被非 daemon 呼叫（目前無日誌，等於**不可偵測**） |
| 阻斷點 | `M-07`（改 pipe 或不開 TCP）；`M-11`（連線稽核） |
| 證據 | `[CODE]` 啟動旗標與 CDP 無認證之架構事實 |

---

## AC-2：惡意網頁 → 提示注入 → 本機程式碼 → 憑證外送

| 項目 | 內容 |
|---|---|
| 前提 | 代理被要求處理攻擊者可控的頁面內容（討論區、履歷、商品描述、PDF 轉出的文字皆可） |
| 步驟 | 1. 頁面內含指令式文字<br>2. 代理 `p.text()` 取得<br>3. 代理產生下一段 `tp-browser nodejs` 腳本<br>4. 腳本讀 `~/.local/share/ego-linux/token` 與 `profile-agent/Default/Cookies`，或直接經 CDP 抓 cookie<br>5. 外送到攻擊者端點 |
| 影響 | `A1`+`A2`+`A3`；且可寫入 `~/.claude/skills/` 形成**跨 session 持久化** |
| 偵測點 | 代理腳本中出現 `fetch` 到非任務網域、出現 `readFileSync` 指向 `ego-linux`（需 `M-01`/`M-11` 才可偵測） |
| 阻斷點 | `M-01`（Node 權限模型 + 敏感路徑拒絕）、`M-06`（不複製密碼庫）、輸出圍籬 |
| 證據 | `[CODE]` `runNodeJs()` 無任何政策檢查 |

> 這條鏈是**唯一不需要任何本地權限或實體接觸**的完整入侵路徑，因此在 `04` 中列為第一優先。

---

## AC-3：供應鏈 — 從安裝命令到未來每個代理 session

| 項目 | 內容 |
|---|---|
| 前提 | 使用者執行 1-line 安裝（`curl ... | bash` 或 `install.cmd`），或 clone 了被替換的來源 |
| 步驟 | 1. 安裝腳本自 GitHub `git clone --depth 1`（未 pin）<br>2. 複製檔案到 `~/.local/share/ego-linux/app`<br>3. 將 `SKILL.md` 覆寫到 `~/.claude/skills/tp-browser/`、`~/.agents/skills/`、`~/.codex/skills/`、`~/.gemini/config/skills/`<br>4. 之後每個代理 session 讀到被植入的指示 |
| 影響 | `A9`、`A10`；等同在「代理的作業系統」層植入後門，且使用者不會在程式碼審查中看到 |
| 偵測點 | `SKILL.md` 的內容雜湊變化；安裝時的 commit sha 紀錄（目前都沒有） |
| 阻斷點 | `M-10`（pin commit + sha256 + 安裝 skill 需 `--with-skills` 明示） |
| 證據 | `[CODE]` `install.sh`／`install.ps1` |

---

## AC-4：憑證集中化 — 一個目錄解鎖母瀏覽器

| 項目 | 內容 |
|---|---|
| 前提 | 使用者曾執行過 `tp-start`（會呼叫 `profile-init.js`），且母瀏覽器有已存密碼 |
| 步驟 | 1. `profile-init.js` 依「書籤數 + favicon 大小 + Local Storage 大小」選出最豐富的母 profile<br>2. 複製 `Bookmarks`／`Favicons`／`Login Data`／`Login Data For Account`／`Web Data`／`Cookies`／`Local State`（含 `os_crypt`）<br>3. 攻擊者只要取得 `A5` 的執行能力（見 AC-2）或讀到該目錄，即可離線解密 |
| 影響 | 由「已登入網站」升級為「所有存過密碼的網站」 |
| 偵測點 | 目錄中出現 `Login Data`（可用啟動時檢查並提示） |
| 阻斷點 | `M-06`（預設不同步憑證類檔案） |
| 證據 | `[CODE]` `tools/profile-init.js` |

---

## AC-5：無認證端點 → 任務中斷 / 蒐證失敗

| 項目 | 內容 |
|---|---|
| 前提 | 本機任一惡意行程；或 `http://` 來源頁面；或經 DNS rebinding 的頁面 |
| 步驟 | 1. `GET http://127.0.0.1:9772/flush-and-close`（無需 token，`curl` 預設 GET）<br>2. 代理瀏覽器 flush cookie 後關閉<br>3. 長時間任務（例如多輪問答、逐頁蒐證）全數作廢 |
| 影響 | `A13` 可用性；對蒐證情境是「紀錄中斷且無從證明中斷原因」 |
| 偵測點 | 目前無 |
| 阻斷點 | `M-02`（所有狀態變更端點需 token，且僅接受 POST） |
| 證據 | `[CODE]` `scripts/tp-start.sh`、`scripts/tp-stop.sh` 的呼叫方式 |

> 網頁面觸發的可行性受瀏覽器限制（混合內容、Private Network Access 對 public→loopback 的限制），因此評為「低–中」；**本機行程則為「高」且幾乎無成本**。

---

## AC-6：冒牌 daemon → 騙走 token 並偽造頁面內容

| 項目 | 內容 |
|---|---|
| 前提 | `127.0.0.1:9772` 未被真 daemon 佔用（例如 daemon 當掉、`daemon.json` 遺失、或埠被改為非 9774 的值） |
| 步驟 | 1. 惡意行程監聽 9772，`/health` 回 `{"ok":true,"chrome":true}`<br>2. 使用者或代理執行 `tp-browser nodejs`<br>3. CLI 送出 `x-tp-token: <A1>`<br>4. 惡意行程取得 token，並可回傳任意 `/rpc` 結果（讓代理「看到」不存在的頁面內容） |
| 影響 | `A1` 洩漏 + 結果完整性被破壞（代理基於假資料做決策） |
| 偵測點 | 目前無 |
| 阻斷點 | `M-05`（埠白名單 + instance id 握手 + 埠不符即中止，不回退） |
| 證據 | `[CODE]` `readPort()`／`ensureRunning()` |

---

## AC-7：root + `--no-sandbox` → 網頁即 root

| 項目 | 內容 |
|---|---|
| 前提 | 以 root 執行 `tp-start`（容器、CI runner、雲端開發機、`sudo` 誤用） |
| 步驟 | 1. `tp-start.sh` 偵測 `id -u == 0` 後自動加 `--no-sandbox`<br>2. 瀏覽器渲染程序失去沙箱<br>3. 惡意頁面利用任一渲染程序漏洞即可執行任意程式碼，權限為 **root** |
| 影響 | 主機完全淪陷（不限於使用者資料） |
| 偵測點 | `id -u` 為 0 時應即拒絕（目前反而是放行） |
| 阻斷點 | `M-03`（拒絕 root，或需 `TP_ALLOW_ROOT=1` 明示） |
| 證據 | `[CODE]` `scripts/tp-start.sh`：`if [ "$(id -u ...)" = "0" ]; then SANDBOX_FLAG="--no-sandbox"` |

---

## AC-8：文件引導 → 從工作目錄執行攻擊者檔案

| 項目 | 內容 |
|---|---|
| 前提 | 代理照 `README.md`／`SKILL.md` 執行 `tp-browser nodejs < tools/cookies-export.ego.js`；該檔案在 repo 中**不存在**（`tools/` 僅有 `profile-init.js`） |
| 步驟 | 1. 代理在使用者 CWD（可能是 `~/Downloads` 或某個 clone 來的專案）執行該命令<br>2. shell 從 CWD 找到同名檔案（若存在）<br>3. 該內容被當成代理腳本執行 |
| 影響 | `A1`/`A2`（腳本以使用者權限執行，且使用者以為在跑官方工具） |
| 偵測點 | 檔案不存在時應**失敗**而非「找到別的」；可加「來源必須在 `APP_DIR` 內」檢查 |
| 阻斷點 | `M-10`（補齊檔案或移除文件指引）＋ 於 Skill 中明確要求用絕對路徑 |
| 證據 | `[CODE]` `tools/` 檔案清單與 `runNodeJs()` 的輸入來源 |

---

## 10. 法律實務情境專節（本專案的特殊風險面）

> 本章不涉及任何具體個資或案件內容，僅討論**流程與證據**層面的結構性風險。

### 10.1 證據完整性（`A12`）

以代理批次擷取網頁內容（`snapshot`、`innerText`、`screenshot`）作為日後主張事實的素材時，目前流程缺少：

1. **來源證明**：未固定記錄最終 URL、`document.URL`、HTTP 狀態、`Chrome` 版本與 `User-Agent`。
2. **時戳**：僅有檔案系統 mtime，可被 `touch` 任意改寫。
3. **內容雜湊**：無 sha256，無法證明檔案未被替換。
4. **不可覆寫性**：同名截圖直接覆寫（`T-10`），且無 append-only 清單。
5. **可重現性說明**：專案刻意使用反偵測旗標（`--disable-blink-features=AutomationControlled`、UA 覆寫、`navigator.webdriver=false`），使「代理所見」與「一般使用者所見」可能不同；這一點在需要說明取得過程時必須能講清楚。

**建議**（詳見 `M-11`）：新增 `tp-browser evidence` 子命令，輸出 `{url, finalUrl, capturedAt(ISO+時區), chromeVersion, ua, sha256(payload), prevHash}` 的清單檔，並把該清單本身也串成雜湊鏈。這不解決「網頁內容是否為真」，但解決「我們擷取到的東西是否被改過」。

### 10.2 跨案／跨客戶污染（`A2`、`A4`）

目前 `tp-browser` 只有一個資料目錄（`~/.local/share/ego-linux`）與一個 agent profile。若同一台機器上處理不同案件／不同客戶：

- `store.json` 的 TaskSpace 會混在一起（含 URL 與標題）。
- 瀏覽器的自動填入、站內「最近使用帳號」、SSO 快取會跨案沿用，可能**把 A 案的登入態帶進 B 案的查詢**。
- `p.resetSiteAuth()` 只清單一站，不是案件級隔離。

**建議**（`M-12`）：讓 CLI 與 daemon 一致支援 `--data-dir`（目前只有 `profile-init.js` 理會 `EGO_LINUX_DATA_DIR`，`bin/*.js` 硬編路徑，見 `T-09`），並在文件明示「一案一 profile」為建議做法。

### 10.3 保密義務與第三方傳輸（`I-05`）

`p.text()` 與 `evaluate()` 的結果會經 stdout 進入 LLM 上下文，也就是**離開本機**。對於受保密義務拘束的內容（客戶溝通、第三人個資、對話紀錄），使用者需要一個明確的「紅旗」提示與可行的替代方案（例如只回傳結構化欄位、或在本地模型情境下操作）。技術上可做的最小步是：在 `SKILL.md` 與 `doctor` 輸出中加入一段固定警告，並在 `p.text({maxChars})` 之類的呼叫超過門檻時於 stderr 印出提示。

### 10.4 使用條款與對造風險

反偵測旗標與 UA 覆寫會讓服務方無法辨識自動化行為。對使用者而言，這可能是**民事（違反服務條款）**與**舉證（對方主張取得方式不正當）**兩方面的風險，屬於產品定位層面的決策，而非程式碼缺陷。建議在 `README.md` 與 `SKILL.md` 加註一行風險告知（由專案所有者決定措辭，見 `04` 決策點 D-5）。
