# 日誌／指標／告警中的敏感欄位清單（紅機制規格）

> 本工具使用者為法律專業人士，瀏覽器工作流常涉及案件資料；本檔為**最高優先級**約束。
> 三層防線：**(1) allowlist 優先 → (2) denylist key 過濾 → (3) regex 樣式紅機制 + 長度截斷**。

## 0. 總則

1. **允許清單優先**：先定義「可記欄位」（見 `events-and-fields.md` §2/§4），其餘預設丟棄。
2. **不確定就不記**：任何無法立即判定安全的欄位，不要記錄。
3. 紅機制命中時記 `redaction.hit` 事件（只記欄位名與類型，**不記原值**）。

## 1. Denylist A — 憑證與密鑰（絕對禁止）

**Key（不分大小寫、子字串比對）**：
`token`、`x-tp-token`、`x-ego-token`、`authorization`、`cookie`、`set-cookie`、`password`、`passwd`、`secret`、`api_key`、`apikey`、`access_key`、`private_key`、`os_crypt`、`encrypted_key`、`credential`、`bearer`、`session`、`signature`、`nonce`（值）。

**Header**：`Authorization`、`Cookie`、`Set-Cookie`、`Proxy-Authorization` 一律不記。

**樣式規則**：
- 測試用假值一律使用 `FAKE_VALUE_FOR_TEST`；**禁用**看起來真實的前綴（如 `sk-`、`ghp_`、`xox` 等）。
- 偵測到疑似真實格式的密鑰樣式 → 記 `redaction.hit{type:"secret_like"}`，絕不回顯。

## 2. Denylist B — Cookie 與登入態（絕對禁止）

- `cookies.json` 的任何內容；第三方網站的任何 Cookie／Session 值。
- Chrome `Login Data`、`Login Data For Account`、`Web Data` 的任何欄位。
- `Local State` 的 `os_crypt`。
- 跨機遷移流程（cookies 匯出／匯入）沿線的所有日誌。

## 3. Denylist C — 個人與案件資料（絕對禁止）

- **LINE 訊息內文**（任何片段、任何長度）。
- **案件當事人姓名、客戶名稱、案號、法院文書字號**。
- 書狀／筆錄／判決內容；**頁面正文、DOM 快照、`snapshot()`／`evaluate()` 的回傳值**。
- 表單輸入值、`daemon/inpage.agent.js` 轉發的任何頁面文字。
- `daemon/keys.js` 處理的**按鍵文字**（`keyDescriptor` 的 `text` 欄位可能是密碼或個資）——只記按鍵數量。
- 使用者批次腳本內容（`nodejs` heredoc 原文）。
- Pattern：email、電話（`09xxxxxxxx`／`+886…`）、身分證字號、統一編號（8 位）、住址。

## 4. Denylist D — 路徑與 URL（高風險）

- **絕對路徑**（`/home/...`、`C:\Users\...`）：只記 basename 或 `sha256(path)[:12]`。
  - 修正現況：`tools/profile-init.js` 目前會印 `Synced ... from: <絕對路徑>`（inventory A3），必須改為只印 count。
- **URL**：只記 `urlOrigin`（scheme+host）；path 記 `sha256(path)[:12]`；**query / fragment / userinfo 一律丟棄**（query 常帶 token 或案件關鍵字）。
- CDP `wsUrl`：不記。
- 檔案操作（screenshot/download/upload）：只記 `kind`、`bytes`、`violation`、basename。

## 5. Denylist E — 業務識別（高風險）

- `space.name`：使用者自訂字串，**可能是案號或案名** → 只記 `spaceId`（數字）。
- `targetId` / `sessionId`：高基數 + 可關聯到具體分頁 → 預設不記；debug 層級可記 hash。
- `trace_id`：可記（隨機、無業務語意）。
- 書籤／Favicons／IndexedDB 同步的來源資訊：只記 count 與位元組。

## 6. Regex 樣式（最後防線；命中替換為 `[REDACTED:type]`）

| type | 概念 pattern | 說明 |
|---|---|---|
| `secret_like` | token/cookie/key 關鍵字附近的 `\b[A-Za-z0-9_\-]{32,}\b` | 長 base64/hex 串 |
| `jwt` | `eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+` | |
| `email` | 標準 email | |
| `phone` | `09\d{8}`、`\+886\d{9}` | |
| `national_id` | 字母 + 9 位（身分證字樣） | |
| `url_query` | URL 字串中的 `\?[^\s]*` | 整段移除 |

regex 只是最後防線；**主要防衛靠 allowlist**，不可依賴 regex 完整性。

## 7. 長度與開關

- 字串欄位上限 256 字元，超出截斷為 `…(truncated,N)`；`msg` 上限 128。
- `TP_LOG_SENSITIVE=1`：明確開啟「含頁面內容」的除錯日誌，事件須標記 `sensitive:true`。**預設關閉**；僅本機、僅除錯、需 BOB 政策核准（見決策事項）。

## 8. 指標 label 限制

- label 只能是固定 enum：`route`、`method`、`result`、`reason`、`state`、`kind`、`action`、`instance`、`version`、`binary`。
- Denylist A–E 的任何值**不得**成為 label 或指標值。

## 9. 告警內容限制

- 只帶：`alert`、`severity`、`instance`、`value`、`ts`、`hint`（固定文案）。
- 不帶 URL、`space.name`、錯誤訊息原文、頁面內容（見 `alerts.md` §4）。

## 10. 測試規範（供未來實作）

- 一律使用 `FAKE_VALUE_FOR_TEST`；禁用真實格式前綴。
- 必備 **redaction canary** 測試：把 Denylist A–E 各樣態餵給 logger，斷言輸出不含原值。
- 測試不得連網、不得讀寫 repo 以外路徑（用 `tmp_path`／`tempfile`／`mkdtempSync(tmpdir())`）。

## 11. 送出前檢核表（每個工程師／Agent 每次動日誌前）

- [ ] 新欄位是否可能含 token／cookie／密碼？
- [ ] 是否可能含頁面內容、腳本原文、按鍵文字？
- [ ] URL 是否已剝除 query／fragment？路徑是否已去除絕對值？
- [ ] space 相關是否只用 `spaceId`（數字）？
- [ ] 指標 label 是否都在允許 enum 內？
- [ ] 字串是否經過長度截斷？
- [ ] 是否已在 `events-and-fields.md` 事件目錄中登記？
