# 專案_LinuxAgentBrowser_1151015 STATE（TP 瀏覽器：Linux + Windows 全平台版）

- **更新日期**：1151017（2026-10-17）
- **雲端正本 Repo**：`https://github.com/YourheroBOB/ego-linux`
- **對應 Linear 卡片**：`HQ-1628`、`HQ-1629`
- **本輪進度摘要**：完成 **Windows 原生版 TP 瀏覽器（`ego-win` / `ego-linux` 跨平台版 + `toopowerchat`）** 研發、一鍵安裝器（`install.ps1` / `install.cmd`）與常駐啟動器（`scripts/ego-start.ps1`、`scripts/ego-stop.ps1`），並於兩台 Windows 11 核心主機（`rog`、`pc-win`）實機部署及通過 23/23 全功能冒煙與 `toopower_run.py` 15KB 長文附件端到端實測。

---

## 一、 全節點（5 台 Linux + 2 台 Windows 原生）部署與實測現況（1151017）

| 節點 | OS / 架構 | Node / Browser | 服務與連接埠埠號 | Health Check | 23/23 冒煙 (`smoke.ego.js`) | `toopower_run.py` 15KB 附件端到端 |
|---|---|---|---|---|---|---|
| **`rog` (Windows)** | Windows 11 `10.0.26200` AMD64 | Node `v24.20.0` / Chrome `155.0.8059.85` | WMI 背景無頭 + Startup 自啟 (`:9772` / `:9773`) | `{"ok":true,"chrome":true}` | ✅ 23/23 PASS (2,848 ms) | ✅ `rc=0` (16,475 ms) |
| **`pc-win` (Windows)** | Windows 11 `10.0.26300` AMD64 | Node `v24.19.0` / Chrome `155.0.8059.41` | WMI 背景無頭 + Startup 自啟 (`:9774` / `:9775`，與 WSL2 鏡像網路雙軌並存) | `{"ok":true,"chrome":true}` | ✅ 23/23 PASS (3,122 ms) | ✅ `rc=0` (16,675 ms) |
| **`claw` (Linux)** | Ubuntu 24.04 x86_64 | Node `v24.18.0` / Chrome `150` | `systemd --user`（Xvfb `:99` 有頭 + VNC，`:9772` / `:9773`） | `{"ok":true,"chrome":true}` | ✅ 23/23 PASS (2,525 ms) | ✅ `rc=0` (16,209 ms) |
| **`gb1` (Linux)** | Debian 13 x86_64 | Node `v26.7.0` / Chrome `154` | `ego-start` + `/workspace` 還原包 (`:9772` / `:9773`) | `{"ok":true,"chrome":true}` | ✅ 23/23 PASS (2,613 ms) | ✅ `rc=0` (16,310 ms) |
| **`gb2` (Linux)** | Debian 13 x86_64 | Node `v20.19.2` / Chrome `151` | `ego-start` + `/workspace` 還原包 (`:9772` / `:9773`) | `{"ok":true,"chrome":true}` | ✅ 23/23 PASS (2,451 ms) | ✅ `rc=0` (16,306 ms) |
| **`abacus` (Linux)** | Ubuntu 24.04 x86_64 | Node `v24.21.0` / Chrome `151` | `ego-start` 常駐 (`:9772` / `:9773`) | `{"ok":true,"chrome":true}` | ✅ 23/23 PASS (2,706 ms) | ✅ `rc=0` (16,258 ms) |
| **`pc` (WSL2 Linux)** | Ubuntu 24.04 WSL2 x86_64 | Node `v24.21.0` / Chrome `155` | `systemd --user` (`--no-sandbox`，`:9772` / `:9773`) | `{"ok":true,"chrome":true}` | ✅ 23/23 PASS (2,800 ms) | ✅ `rc=0` (16,387 ms) |

---

## 二、 Windows 原生版核心工程突破（1151017）

1. **ESM `file://` URL 動態載入修正（`bin/ego-browser.js`）**：
   - Windows 下 Node.js ESM `import('C:\\...')` 會拋出 `ERR_UNSUPPORTED_ESM_URL_SCHEME (Received protocol 'c:')`；改為 `import(pathToFileURL(tmp).href)`，並自動剝除 PowerShell 管線常見之 UTF-8 BOM (`\uFEFF`)。
2. **WSL2 `networkingMode=mirrored` 雙軌連接埠共存機制（`daemon/ego-browserd.js`、`bin/ego-browser.js`、`lib/sdk.js`、`scripts/ego-start.ps1`）**：
   - 當同一台實體機（如 `pc`）同時運行 WSL2 Linux 版（占用 `127.0.0.1:9772/9773`）與 Windows 原生版時，`ego-start.ps1` 自動偵測 `9773` 的 `User-Agent` 是否為 Linux，自動將 Windows 原生版切換至 `--alt-port`（`9774` daemon / `9775` Windows Chrome）並寫入 `daemon.json`，讓 Windows 原生 CLI 與 WSL2 Linux CLI 各走各的原生瀏覽器與原生檔案系統路徑，零衝突並存。
3. **WMI `Win32_Process.Create` 零管線繼承背景常駐（`scripts/ego-start.ps1`）**：
   - 解決 Windows OpenSSH (`sshd`) 與 Python `subprocess.run(..., capture_output=True)` 下 `Start-Process` 子程序繼承標準輸出管線導致等待卡死的問題；無頭模式統一透過 WMI `Win32_Process.Create` 脫離父程序管線常駐，並註冊 Windows Startup 開機自動啟動（`tp-browser-autostart.vbs`）。
4. **支援有頭 GUI 登入與無頭常駐無縫切換（`ego-headed` / `ego-start`）**：
   - 在 Windows 上執行 `ego-headed`（或 `tp-headed`）即可用同一個 `profile-agent` 資料夾開啟可見的 Chrome/Edge 桌面視窗供人工登入各家 AI 網站；登入完畢後執行 `ego-start`（或 `tp-start`）即切回背景無頭模式，Cookie 與登入態 100% 保留。
   - 停止腳本 `ego-stop`（`scripts/ego-stop.ps1`）精準比對 `CommandLine` 含 `ego-browserd.js` 或 `profile-agent` 之程序，絕不誤殺使用者個人開啟的 Chrome/Edge 視窗。
5. **`toopower_run.py` Windows 原生相容與自我修復（Self-Healing）**：
   - 修正 Windows `cp950` 預設編碼導致 UTF-8 輸出崩潰問題（強制 UTF-8 解碼與 `sys.stdout.reconfigure`）。
   - 修正 `NamedTemporaryFile` 未關閉 `stdin` 檔案代碼即呼叫 `os.unlink()` 導致 Windows `WinError 32` 鎖檔問題。
   - 內建 Windows 健康檢查與 `ego-start.ps1` 自動喚醒（Self-Healing）。

---

## 三、 驗收紀錄（本機/實機驗收 vs 已上雲讀回）

- **本機與遠端實機驗收（1151017）**：
  - `rog`（Windows 11 `BobAlly`）：`tp-browser doctor` -> `daemon 127.0.0.1:9772: ok (chrome attached: true)`、`chrome 127.0.0.1:9773: ok (Chrome/155.0.8059.85)`；`smoke.ego.js` **23/23 PASS (`ALL_GREEN`, 2,848 ms)**；外部真頁 `example.com` (1,147 chars) & `news.ycombinator.com` (33,285 chars) 通過；`toopower_run.py` 15KB 附件端到端 **`rc=0` (16,475 ms)**。
  - `pc-win`（Windows 11 `BOB`）：`tp-browser doctor` -> `daemon 127.0.0.1:9774: ok (chrome attached: true)`、`chrome 127.0.0.1:9775: ok (Chrome/155.0.8059.41)`；`smoke.ego.js` **23/23 PASS (`ALL_GREEN`, 3,122 ms)**；外部真頁 `example.com` (1,147 chars) & `news.ycombinator.com` (33,285 chars) 通過；`toopower_run.py` 15KB 附件端到端 **`rc=0` (16,675 ms)**。
  - `pc`（WSL2 Linux `BOB`）：`ego-browser status` -> `:9772` 維持 `{"ok":true,"chrome":true}`，與 Windows 原生版雙軌無干擾。
- **已上雲讀回**：
  - GitHub 私有庫：`https://github.com/YourheroBOB/ego-linux`（`main` 分支同步推送並經 `git ls-remote origin main` 讀回驗證）。
