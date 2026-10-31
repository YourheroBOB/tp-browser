# 05 · Cookie 主權與 Profile 資料（Cookies & Profile）

## Q23. 我的登入態（Cookies）存在哪？會不會被上傳到雲端？

- **問題**：擔心 Google／ChatGPT 等登入態外流。
- **原因**：釐清資料流向。
- **解法**：所有登入態 100% 存在本機 `~/.local/share/ego-linux/profile-agent`（同一 profile 供有頭/無頭共用）。daemon 與 Chrome CDP 都只綁 `127.0.0.1`，repo 內沒有任何把 Cookie 傳往外部的程式路徑。跨機遷移（見 Q24）也是你自己匯出檔案、自己搬。
- **相關檔案**：`README.md`、`tools/profile-init.js`、`scripts/tp-start.sh`

## Q24. README 提到的 `tools/cookies-export.ego.js`／`cookies-import.ego.js` 在哪裡？

- **問題**：照 README 操作跨機 Cookie 遷移，卻找不到工具檔。
- **原因**：以本次提供的 repo 快照而言，`tools/` 目錄下**只有** `profile-init.js`；`install.sh` 也只是「有才複製」（`cp "$SRC/tools/"*.js ... 2>/dev/null || true`）。這兩個 cookie 工具在文件中有描述，但未包含在目前的檔案清單中，屬於文件與實際內容的**已知落差**。
- **解法**：先以 `ls tools/` 確認你的 checkout／安裝目錄是否真有這兩支腳本；沒有的話，可等上游補上，或自行以 `page.evaluate`＋CDP `Network.getAllCookies` 類流程實作（輸出檔請設 0600 權限、僅存於本機）。**不建議**把匯出檔放進 repo、commit 或貼到 issue。
- **相關檔案**：`README.md`、`install.sh`、`tools/`（目錄）

## Q25. `tp-start` 之後我的書籤、圖示、密碼自動「搬家」了？

- **問題**：發現 agent profile 裡出現了自己主要瀏覽器的書籤／Favicons / 登入資料，想了解發生了什麼。
- **原因**：`tools/profile-init.js` 會在啟動時掃描本機既有 Chrome／Edge／Brave 等瀏覽器的 profile（跨 Default／Profile 1..5 等），以書籤數量＋Favicons 大小＋Local Storage 大小評分選出最佳來源，並在 **目標缺失或明顯較小** 時複製書籤、Favicons、Login Data、Web Data、Cookies DB（連同 `Local State` 的 `os_crypt` 加解密參數）與 https_* IndexedDB。
- **解法**：這是預設行為，目的在於讓 agent profile 開箱即有你的常用環境。不想同步的話，可跳過 profile-init（啟動腳本是以 `[ -f ... ] && node ... || true` 容錯呼叫）；想強制重新同步可用 `--force`（或 `--sync-auth`）參數手動執行。注意：這支工具會讀取你本機瀏覽器的**登入資料**，請在信任的機器上使用。
- **相關檔案**：`tools/profile-init.js`、`scripts/tp-start.sh`、`scripts/ego-start.ps1`

## Q26. 主要瀏覽器明明已登入，agent profile 卻沒有該網站的登入態？

- **問題**：Cookie／登入資料沒有如預期同步過來。
- **原因**：`profile-init.js` 的同步條件相當保守，例如：來源 Cookies DB 需 > 32KB、目標需 < 64KB 才複製；Local Storage 需目標 < 1.5MB 且 < 來源 30%；IndexedDB 只補「不存在」的 origin。已經長大的 agent profile 不會被覆蓋。
- **解法**：
  1. 最乾淨的做法是直接在 `tp-headed` 開的有頭視窗手動登入一次（Cookie 即寫入共用 profile）。
  2. 或手動執行 `node tools/profile-init.js --force` 強制重同步（會覆蓋目標中較小的資料庫，請先自行備份 profile）。
- **相關檔案**：`tools/profile-init.js`

## Q27. 換一台機器／重灌後，如何帶著登入態走？

- **問題**：需要跨機遷移 profile。
- **原因**：登入態綁定 profile 資料夾（Cookies DB + `Local State` 的 `os_crypt`）。
- **解法**：
  1. 兩台機器先 `tp-stop` 优雅關閉（flush Cookie）。
  2. 把 `~/.local/share/ego-linux/profile-agent` 整個資料夾（含 `Local State`）以你信任的加密管道搬到新機器同位置，權限維持僅本人可讀寫（0700/0600 或 Windows icacls）。
  3. 新機器 `tp-start`。
  4. Windows ↔ 跨 OS 搬移時，`os_crypt` 的 DPAPI 金鑰綁定原機器/原帳號，可能解不開——跨 OS 建議改用 Cookie 匯出/匯入流程（見 Q24 的現況限制），或在目標機 `tp-headed` 重新登入一次最省事。
- **相關檔案**：`tools/profile-init.js`、`scripts/tp-stop.sh`、`README.md`
