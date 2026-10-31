# 08 · Windows 原生版疑難排解（Windows-specific）

## Q38. 透過 SSH／OpenSSH 連進 Windows 執行 `tp-headed`，本機桌面看不到視窗？

- **問題**：SSH 工作階段（Session 0）啟動的 headed 視窗沒出現在使用者桌面。
- **原因**：Windows 服務型 SSH 工作階段不在互動桌面 session；直接 `Start-Process` 會開在 Session 0 的不可見桌面。
- **解法**：`scripts/ego-start.ps1` 已內建處理：偵測 `$CurrentSessionId -eq 0` 時，寫一個 `launch-headed-gui.ps1` 並透過 `schtasks /Create ... /IT` + `/Run` 以互動工作（Interactive Token）在桌面 session 開視窗，之後刪除排程；另有 fallback 直接 `Start-Process`。若仍看不到，確認目標機**有使用者已登入的互動桌面**（無人登入的 headless server 沒有桌面可顯示，只能用無頭模式）。
- **相關檔案**：`scripts/ego-start.ps1`、`STATE.md`

## Q39. 從 Python `subprocess.run(..., capture_output=True)` 或管線環境啟動，程式卡死？

- **問題**：遠端自動化呼叫啟動腳本後一直等不到返回。
- **原因**：`Start-Process` 的子程序繼承了標準輸出管線；父程序（如 Python）等管線關閉，子程序（常駐 daemon/Chrome）又永遠不關，形成死結。
- **解法**：無頭啟動已改用 **WMI `Win32_Process.Create`**（`Invoke-CimMethod`）建立程序，完全脫離父程序管線（見 `STATE.md` 工程突破第 4 點）。若你自己寫包裝程式，避免用會繼承管線的方式 spawn 常駐程序，或改用 `--headless` 流程。
- **相關檔案**：`scripts/ego-start.ps1`、`STATE.md`

## Q40. Chrome 起不來，log 提到 SingletonLock 或 profile 被占用？

- **問題**：啟動失敗，profile 資料夾內有 `SingletonLock`／`SingletonCookie`／`SingletonSocket` 殘留。
- **原因**：上一個使用該 `profile-agent` 的瀏覽器程序沒干净結束（或仍有程序活著），Chrome 以 singleton 機制拒絕第二個實例。
- **解法**：正常流程中 `ego-start.ps1`／`tp-start.sh` 會先停程序、sleep、再刪三個 Singleton 檔。手動處理：先 `tp-stop`，確認沒有命令列含 `profile-agent` 的 chrome/msedge 程序，再刪 `~/.local/share/ego-linux/profile-agent/` 下的 `Singleton*` 三檔，重跑 `tp-start`。
- **相關檔案**：`scripts/ego-start.ps1`、`scripts/tp-start.sh`

## Q41. 開機沒有自動啟動 TP 瀏覽器？

- **問題**：重開機後 daemon／Chrome 沒有自己起來。
- **原因**：`install.ps1` 會在使用者 Startup 資料夾建立 `tp-browser-autostart.vbs`，以隱藏視窗執行 `ego-start.ps1`。若安裝時 Startup 資料夾不可寫、防毒攔截 VBS，或事後被刪除，就不會自啟。
- **解法**：檢查 `shell:startup` 內是否有 `tp-browser-autostart.vbs`；沒有就重跑 `.\install.cmd` 或手動重建。被防毒/政策擋 VBS 的環境，可改用工作排程器自行設定。手動啟動隨時可用 `tp-start`。
- **相關檔案**：`install.ps1`、`scripts/ego-start.ps1`

## Q42. Windows 上 `ego-stop`／`tp-stop` 會不會關到我日常用的 Chrome／Edge？

- **問題**：擔心批次停程序誤傷日常瀏覽器。
- **原因**：`scripts/ego-stop.ps1` 的篩選是「執行檔名為 node/chrome/msedge/brave **且** 命令列含 `ego-browserd.js` 或 `ego-linux*profile-agent`」兩個條件同時成立。
- **解法**：日常瀏覽器使用預設 user data dir、命令列不含 `profile-agent`，不會被命中，屬安全。唯一要注意的是：若你**手動**用 `--user-data-dir=...ego-linux\profile-agent` 開過視窗，它會被視為 TP 瀏覽器程序而被停止。
- **相關檔案**：`scripts/ego-stop.ps1`
