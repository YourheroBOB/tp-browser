# 03 · 有頭／無頭切換與人工登入（Headed vs Headless / Co-Riding）

## Q12. 無頭模式連 Perplexity / ChatGPT 被 Cloudflare Turnstile 擋下來？

- **問題**：Agent 在背景無頭模式下造訪特定網站時觸發人機驗證頁。
- **原因**：Headless Chrome 的 `Sec-CH-UA` Client Hints 會洩漏 `"HeadlessChrome"` 品牌字樣，且 `navigator.webdriver` 為 true，容易被 CDN 防護判定為自動化。
- **解法**：
  1. tp-browser 已在 `daemon/page-ops.js` 內建緩解：透過 CDP `Network.setUserAgentOverride` 讀取 `Browser.getVersion`，把 brands 中的 `"HeadlessChrome"` 換成 `"Google Chrome"`，並注入 `navigator.webdriver = false`。先確認你的版本含此修正。
  2. 若仍被擋（Cloudflare 驗證碼、2FA），這正是 **TaskSpace 人機共乘**的設計場景：執行 `tp-headed` 開啟有頭視窗，由人類手動通過驗證，完成後 `tp-start` 切回無頭，Cookie 保留在同一個 `profile-agent`。
- **相關檔案**：`daemon/page-ops.js`、`STATE.md`（工程突破第 2 點）、`scripts/tp-start.sh`

## Q13. 在 `tp-headed` 視窗登入後，切回無頭模式登入態會保留嗎？

- **問題**：擔心 headed → headless 切換會掉登入。
- **原因**：兩種模式共用同一個 `~/.local/share/ego-linux/profile-agent` 使用者資料夾，切換時 daemon 會先呼叫 `/flush-and-close` 把 Cookie 與 storage 刷寫進 profile 再關閉瀏覽器。
- **解法**：不需要額外操作；正確順序是「在 headed 完成登入 → 執行 `tp-start`（會優雅關閉並以無頭重啟同一 profile）」。若登入態仍消失，檢查是否有第二個程式同時占用該 profile（見 Singleton 鎖問題，Q36）。
- **相關檔案**：`scripts/tp-start.sh`、`scripts/ego-start.ps1`、`tools/profile-init.js`

## Q14. 在 WSL2 裡執行 `tp-headed`，開出來的卻是 Windows 的 Chrome 視窗？

- **問題**：WSL2 內執行 headed 卻委派給 Windows 桌面瀏覽器。
- **原因**：這是**刻意設計**。`tp-start.sh` 偵測到 `/proc/version` 含 microsoft（即 WSL2）且要求 `--headed` 時，會尋找 `/mnt/c/Users/*/.local/share/ego-linux/scripts/ego-start.ps1` 並透過 PowerShell 委派 Windows 原生版開 GUI 視窗，事後再把 Windows 側的 `daemon.json`／`token` 複製回 Linux 側資料目錄並設 600 權限。
- **解法**：屬正常行為。若你真的想在 WSL2 內開 Linux GUI 瀏覽器（例如搭配 Xvfb/VNC 的部署），請自行以 `TP_BROWSER_BIN` 與 X 環境啟動，不走 `tp-headed` 的 WSL2 委派路徑。
- **相關檔案**：`scripts/tp-start.sh`

## Q15. 遇到 2FA／簡訊驗證碼，Agent 流程該怎麼設計？

- **問題**：自動化登入卡在需要人類輸入驗證碼的步驟。
- **原因**：2FA 本質上無法（也不應）完全自動化。
- **解法**：採「人機共乘」流程——Agent 以無頭進行到登入頁 → 人工執行 `tp-headed` 在同 profile 完成登入與 2FA → `tp-start` 切回無頭 → Agent 重試原本操作，登入態已在 profile 內。Agent 腳本不應嘗試讀取或記錄任何驗證碼、密碼內容。
- **相關檔案**：`README.md`（TaskSpace 段落）、`scripts/tp-start.sh`

## Q16. 重複執行 `tp-headed` 會把我正在看的有頭視窗關掉嗎？

- **問題**：擔心再次啟動會殺掉現有視窗與分頁。
- **原因**：啟動腳本有「保護既有互動視窗」的判斷：若 daemon 健康**且**（Linux/macOS）process 清單中該 profile 的瀏覽器命令列**不含** `--headless`／（Windows）存在 `--tp-interactive-gui=1` 的有頭程序，就直接印 `TP_READY ... mode=headed` 退出，不會重啟。
- **解法**：直接再跑一次 `tp-headed` 是安全的。若你**想**強制重啟，加上 `--restart`（Windows `-Restart`）。
- **相關檔案**：`scripts/tp-start.sh`、`scripts/ego-start.ps1`
