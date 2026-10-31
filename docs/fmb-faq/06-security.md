# 06 · 安全與連線邊界（Security）

## Q28. daemon 的 token 是什麼？放在哪？怎麼用？

- **問題**：HTTP API 需要認證，不知道憑證從哪來。
- **原因**：daemon 對需認證端點以常數時間比較（`crypto.timingSafeEqual`）驗證 token，檔案位於 `~/.local/share/ego-linux/token`（權限 600）。
- **解法**：一般使用者**不需要**碰它——CLI 會自動讀取。自行呼叫 HTTP API 時以 `x-tp-token` 或 `x-ego-token` 標頭帶入。文件與測試中永遠用假值示例：

  ```bash
  curl -H 'x-tp-token: FAKE_VALUE_FOR_TEST' http://127.0.0.1:9772/rpc -d '...'
  ```

  請勿把真實 token 寫進文件、腳本、log 或 commit。
- **相關檔案**：`bin/ego-browser.js`（`readToken`）、`daemon/ego-browserd.js`、`docs/fmb-api/README.md`

## Q29. 為什麼從區網／遠端機器連不上 9772？

- **問題**：從另一台電腦 curl `http://<主機IP>:9772/health` 連線被拒。
- **原因**：**刻意設計**。daemon 與 Chrome CDP 都強制綁 `127.0.0.1`（`--remote-debugging-address=127.0.0.1`），HTTP 層還會驗證 `Host` 標頭必須是 `127.0.0.1` 並拒絕帶 `Origin` 的跨站請求，以杜絕區網探測、DNS Rebinding 與瀏覽器端 CSRF。
- **解法**：不要試圖放寬綁定。遠端操作請改用 SSH 通道（例如 `ssh -L 9772:127.0.0.1:9772 user@host`）再於本機存取；並注意 token 仍需保密。
- **相關檔案**：`daemon/ego-browserd.js`、`scripts/tp-start.sh`、`README.md`（資安加固）

## Q30. 多人共用的機器上用 tp-browser 安全嗎？

- **問題**：同一台 OS 主機有多個帳號，會不會互相看到對方的瀏覽器資料？
- **原因**：daemon 綁 loopback、資料目錄設 0700/0600（Windows 用 icacls 限縮到當前使用者），但**同一 OS 帳號**下的使用者彼此沒有隔離；不同 OS 帳號下 loopback 埠位也可能互相占用。
- **解法**：本工具的安全邊界是**單一使用者個人電腦或專屬開發工作站**。多人主機請每人使用獨立 OS 帳號，並留意 9772–9775 埠位的占用衝突（可用 `--alt-port` 但僅有一組備援）。
- **相關檔案**：`README.md`（安全邊界提示）、`install.sh`、`install.ps1`

## Q31. 檔案上傳／下載／截圖的路徑會不會被惡意網頁利用？

- **問題**：擔心 `..` 路徑穿越或符號連結攻擊。
- **原因**：了解既有防護範圍。
- **解法**：daemon 端對所有截圖、下載與上傳路徑做 `safePath`（`realpathSync.native`）真實路徑解析，擋掉 `..` 穿越與 symlink 逃逸；檔案上傳的 DOM 標記另以 `/^ego-\d+$/` 正則校驗，防止網頁竄改 `window.__egoAgent` 注入。開發者自行擴充檔案相關功能時，務必沿用 `safePath`，不要直接信任頁面提供的路徑字串。
- **相關檔案**：`daemon/ego-browserd.js`、`daemon/page-ops.js`、`README.md`（資安加固）

## Q32. 發現疑似漏洞或想自我檢查，有什麼資源？

- **問題**：需要安全自查清單或已知風險清單。
- **原因**：repo 內已有安全文件。
- **解法**：閱讀 `docs/fmb-security/AUDIT.md`（稽核）與 `CHECKLIST.md`（檢查清單）；供應鏈與版本風險見 `docs/fmb-upgrade/02-risk-register.md`。回報問題時**切勿**附上真實 token、cookie、客戶或案件資料。
- **相關檔案**：`docs/fmb-security/AUDIT.md`、`docs/fmb-security/CHECKLIST.md`、`docs/fmb-upgrade/02-risk-register.md`
