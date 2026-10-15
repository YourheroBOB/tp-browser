# ego-linux — ego-browser 相容的 Linux agent 瀏覽器

在 Linux 上重製 Mac ego lite 的 agent 面向：**同一套 `ego-browser nodejs` CLI 與
`taskSpace()/page()` SDK**，讓既有 ego-browser skill 腳本不改就能在 Linux 節點跑。

- 零 npm 依賴（Node ≥22 內建 WebSocket client／fetch）。
- 底層＝本機 Chromium 的 CDP（DevTools 協定）。
- 傳輸＝localhost HTTP `POST /rpc` ＋ SSE `/events`（daemon 認 token）。
- daemon **只連不生**：Chrome 由 systemd／操作員以 `--remote-debugging-port=9773` 啟動
  （此專案全程零 child_process，見專案 DESIGN.md 的掃描器裁定記錄）。

## 快速開始

```sh
./install.sh                      # 裝到 ~/.local/share/ego-linux/app + ~/.local/bin
systemctl --user enable --now ego-linux-chrome ego-linux-browserd   # 或見下方手動
ego-browser doctor                # 健檢＋印修復指令
```

手動啟動（免 systemd）：

```sh
chromium --headless=new --no-first-run --no-default-browser-check \
  --remote-debugging-port=9773 \
  --user-data-dir=$HOME/.local/share/ego-linux/profile-agent \
  --window-size=1440,900 about:blank &
ego-browserd &
```

systemd user units 在 `scripts/`：
`cp scripts/*.service ~/.config/systemd/user/ && systemctl --user daemon-reload`。
Chrome 路徑不同（如 `/usr/bin/google-chrome-stable`）就改 unit 內 `ExecStart`。

## 使用（與 ego-browser skill 同語法）

```bash
ego-browser nodejs <<'EOF'
const task = await taskSpace("inspect example page");
const page = task.page("p1");
await page.goto("https://example.com");
console.log(await page.snapshot());
await task.finish({ keep: [] });
EOF
```

支援面（第一版）：taskSpace 建立／resume（同名重用）、p1 起、newPage／adopt／release、
tabs、goto/reload、snapshot（ego 格式樹＋ref）、screenshot（寫絕對路徑）、click/dblclick/
hover/dragAndDrop、fill/selectOption/focus/press、keyboard.*、mouse.*、evaluate/fetch、
waitForURL/Selector/Function/LoadState/Timeout/Event(popup/download)、acceptDialog/
dismissDialog、setInputFiles＋waitForFileChooser（全程攔截，不開原生面板）、下載 Download
API、cdp 逃生門（page.cdp／task.cdp）。

已知差異（設計取捨，非 bug）：
- `keyboard.paste()` 在 headless Linux 無原生剪貼簿，退化為 insertText。
- profileId：一個 daemon 掛一台 Chromium；多 profile＝多開（不同 EGO_BROWSERD_PORT／
  EGO_BROWSER_PORT 各配一台 Chrome＋daemon）。
- waitForControl 在無人值守環境立即回 true；handOff 標記空間閒置。
- Xvfb headed 模式：先起 Xvfb、`export DISPLAY=:99`，Chrome 命令去掉 `--headless=new`。

## 架構

```
ego-browser nodejs（CLI，薄客戶端）
  → http://127.0.0.1:9772 /rpc ＋ /events（token 於 ~/.local/share/ego-linux/token）
ego-browserd（daemon：task spaces 帳本 spaces.json、事件推送、路徑護欄 safePath）
  → CDP ws://127.0.0.1:9773（Chromium）
```

模組：`daemon/cdp.js`（CDP client）、`daemon/page-ops.js`（動作實作）、
`daemon/inpage.agent.js`（頁內選擇器引擎＋ego 格式 snapshot 產生器）、
`daemon/store.js`（空間帳本）、`daemon/keys.js`（鍵碼）、`lib/sdk.js`（客戶端 SDK）、
`bin/ego-browser.js`（CLI）。

## 安全

- daemon 只綁 127.0.0.1；token 檔 0600。
- 所有 caller 提供的檔案路徑（screenshot/saveAs/上傳檔）經 `safePath()`：絕對路徑、
  禁 `..`、禁 NUL。
- 檔案選擇走 CDP 攔截（`Page.setInterceptFileChooserDialog`），絕不觸發原生檔案面板。
- 下載落在 daemon 管理目錄，`saveAs()` 才複製到指定絕對路徑。

## 測試

```sh
node tests/serve.mjs &        # 本機測試頁 http://127.0.0.1:8899/
ego-browser nodejs -e '...'   # tests/smoke.mjs 內容
```
