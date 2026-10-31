# 02 · 啟動、埠位與健康檢查（Startup & Ports）

## Q7. `tp-start` 最後印出 `TP_NOT_READY`（Windows 為 `EGO_NOT_READY`），怎麼排查？

- **問題**：啟動腳本等到逾時仍無法達成健康狀態。
- **原因**：可能依序是：(1) 瀏覽器執行檔沒找到；(2) daemon 起了但 Chrome 沒在期限內回應 CDP；(3) 埠位被佔用；(4) Profile 被 Singleton 鎖卡住。
- **解法**：
  1. 先看 daemon 與 Chrome 的 log：`~/.local/share/ego-linux/logs/daemon.log`、`logs/chrome.log`。
  2. 手動驗證 Chrome CDP 是否回應：`curl http://127.0.0.1:9773/json/version`。
  3. 執行 `tp-browser doctor`，依指示修復。
  4. 若懷疑殘留鎖檔，刪除 `profile-agent/SingletonLock`、`SingletonCookie`、`SingletonSocket` 後重試（`tp-start.sh` 正常流程也會自動清）。
- **相關檔案**：`scripts/tp-start.sh`、`scripts/ego-start.ps1`、`bin/ego-browser.js`（`doctor`）

## Q8. 9773 埠已被占用（例如 WSL2 內的 Linux 版 Chrome），如何並存？

- **問題**：Windows 原生版與 WSL2 Linux 版同機使用時埠位衝突。
- **原因**：預設 daemon 用 9772、Chrome CDP 用 9773；WSL2 `networkingMode=mirrored` 會讓兩邊共用埠位空間。
- **解法**：使用 `--alt-port` 切到備援埠位 **9774／9775**。Windows 的 `ego-start.ps1` 會在偵測到 9773 上的 Chrome 是 Linux 版時**自動**改用 9774/9775；也可手動指定 `tp-start --alt-port`（或 PowerShell `-AltPort`）。CLI 端會讀 `~/.local/share/ego-linux/daemon.json` 中的 `port`／`chromePort` 自動跟隨。
- **相關檔案**：`scripts/tp-start.sh`、`scripts/ego-start.ps1`、`bin/ego-browser.js`

## Q9. `tp-browser status` 顯示 `{"ok":true,"chrome":false}` 是什麼意思？

- **問題**：daemon 活著，但 `chrome` 欄位是 false。
- **原因**：daemon 已啟動，但尚未成功連上 Chrome 的 CDP WebSocket。daemon 會持續重試（約每 3 秒一次）。
- **解法**：通常是 Chrome 還沒起來或 CDP 埠不對。等幾秒後再查一次；若一直 false，檢查 Chrome 是否真的以 `--remote-debugging-port=9773`（或 9775）啟動，並確認 `curl http://127.0.0.1:9773/json/version` 有回應。
- **相關檔案**：`daemon/ego-browserd.js`、`bin/ego-browser.js`（`status`／`doctor`）

## Q10. `tp-stop` 之後感覺沒停乾淨，或反過來把不該關的程式關了？

- **問題**：停不掉殘留程序，或擔心影響自己日常的瀏覽器。
- **原因**：停止腳本的比對條件是**命令列同時符合**瀏覽器執行檔名（node/chrome/msedge/brave）且命令列含 `ego-browserd.js`／`tp-browserd.js` 或 `ego-linux*profile-agent`。你個人日常開的瀏覽器（用預設 profile）命令列不含 `profile-agent`，不會被命中。
- **解法**：
  - Linux/macOS：`tp-stop` 會先呼叫 `/flush-and-close`（9772 與 9774 都試）优雅刷寫 Cookie 再 `pkill`。
  - 若仍有殘留，可用 `ps ax -o command= | grep profile-agent` 找出 pid 自行處理；Windows 可用工作管理員搜尋命令列含 `profile-agent` 的程序。
  - 反之，若你**手動**用 `--user-data-dir=.../profile-agent` 啟動過瀏覽器，下次 `tp-stop` 會把它關掉——這是預期行為。
- **相關檔案**：`scripts/tp-stop.sh`、`scripts/ego-stop.ps1`

## Q11. Linux 上想用 systemd 常駐而不是 `tp-start`，怎麼設定？

- **問題**：希望開機自動帶起無頭 Chrome 與 daemon。
- **原因**：repo 附了兩份 systemd **user** unit 範本。
- **解法**：

  ```bash
  cp scripts/*.service ~/.config/systemd/user/
  systemctl --user enable --now ego-linux-chrome ego-linux-browserd
  ```

  注意：unit 內路徑假設程式位於 `~/.local/share/ego-linux/app/`（即 `install.sh` 的安裝位置）、Chromium 在 `/usr/bin/chromium`；環境不同請自行修改 unit 檔。root 或容器環境需注意 Chrome sandbox（`tp-start.sh` 以 root 執行時會自動加 `--no-sandbox`，systemd unit 不會）。
- **相關檔案**：`scripts/ego-linux-chrome.service`、`scripts/ego-linux-browserd.service`、`scripts/tp-start.sh`
