# tp-browser 操作手冊

> 適用基準：本地提交 `f885545`，2026-10-31。命令以儲存庫根目錄為起點；本文件區分「可離線檢查」與「會改動使用者環境」。本次文件工作沒有執行安裝器、啟停腳本、Cookie 工具或瀏覽器測試。

相關文件：[架構與已知限制](ARCHITECTURE.md)、[後續修正順序](ROADMAP.md)。

## 先選操作範圍

| 情境 | 可以做什麼 |
|---|---|
| 只允許閱讀程式及新增文件，例如本次任務 | 執行下節的離線檢查；不呼叫 `nodejs`、`start`、`headed`、`restart`、`stop`。 |
| 已核准的專用測試 VM／OS 帳號，沒有真實登入資料 | 可依後續步驟安裝、啟動及測本機合成頁。這些是日後操作說明，不是本次已執行事項。 |
| 與其他人或正式作業共用的主機 | 不直接跑既有啟停腳本；先處理實例歸屬及隔離問題。不同通訊埠不等於隔離。 |

**重要副作用：** `tp-browser nodejs` 必要時自動啟動服務；啟動器會執行 `profile-init.js`，可能複製日常瀏覽器的登入資料。即使腳本只開本機測試頁，也不能據此推定不接觸既有資料。目前沒有「禁止來源匯入」開關；`EGO_LINUX_DATA_DIR` 只影響該工具的目的目錄，不能隔離整套 daemon 或阻止來源掃描。

不要顯示或保存認證值、Cookie、網頁儲存、私人網址、表單輸入、訊息本文或案件資料。本文只提供欄位名稱、路徑用途與本機合成資料範例。

## 一、離線檢查

需要 Node.js `>=22`；不用 `npm install`。本專案沒有 `npm test`、`npm run build` 或 lint 指令，也沒有宣告需安裝的 npm 套件。

### Linux／macOS

```sh
git status --short
git rev-parse --short HEAD
node --version
git ls-files -z '*.js' '*.mjs' | xargs -0 -n 1 node --check
sh -n install.sh scripts/tp-start.sh scripts/tp-stop.sh
node bin/tp-browser.js help
node bin/tp-browser.js version
```

`node --check` 只檢查語法，不執行腳本；`sh -n` 不驗證 PowerShell，也不證明啟停行為正確。`help`、`version` 不讀取認證檔或自動啟動服務。

### Windows PowerShell

```powershell
git status --short
git rev-parse --short HEAD
node --version
git ls-files '*.js' '*.mjs' | ForEach-Object {
    node --check $_
    if ($LASTEXITCODE -ne 0) { throw "JavaScript 語法檢查失敗" }
}
node .\bin\tp-browser.js help
node .\bin\tp-browser.js version
```

這組命令不執行 `.ps1`。安裝或啟動前仍需在相應平台核對 PowerShell 與瀏覽器可用性。

## 二、安裝前置條件

| 項目 | 核對事項 |
|---|---|
| 執行環境 | Node.js `>=22`、已安裝的 Chromium 系瀏覽器。部分包裝命令仍帶 `--experimental-websocket`，不代表可以忽略套件的 Node.js 下限。 |
| 測試隔離 | 使用沒有個人瀏覽器資料的專用 VM／OS 帳號；不要只換 HOME 就宣稱所有平台路徑已隔離。 |
| 通訊埠 | 預設 `9772/9773`，替代 `9774/9775`；冒煙伺服器 `8899`，基準伺服器 `8890`。埠被占用時先判明歸屬，不停止不明行程。 |
| 有頭模式 | 需要可用的圖形桌面；Windows Session 0 的排程器嘗試不保證使用者實際看見視窗。 |
| 安裝影響 | 核對相容命令、技能目錄與自動啟動是否允許變更。現有安裝器沒有逐項停用開關。 |

### macOS／Linux 安裝

只在已確認可承受下列副作用的測試環境中執行：

```sh
sh ./install.sh
export PATH="$HOME/.local/bin:$PATH"
command -v tp-browser
tp-browser version
```

[install.sh](../../install.sh) 會替換資料根下的 `app/` 模組副本，建立 `~/.local/bin/` 命令；若 `/usr/local/bin` 可寫，也會建立連結。它會覆寫多個工具目錄內的 `tp-browser`／`ego-browser` 技能副本及同名命令，**沒有保護既有原生 `ego-browser` 的判斷**。來源不在本地時的下載分支不屬本手冊操作路徑。

安裝器本身不啟動 Unix 服務，也不啟用 systemd。安裝後測試仍應在原始 clone 執行：安裝器只複製 `tests/*.mjs`，未包含冒煙腳本、HTML 及 bench 子目錄；docs 也未遞迴複製。

### Windows 安裝

```powershell
.\install.cmd
```

[install.cmd](../../install.cmd) 轉交 [install.ps1](../../install.ps1)。後者會複製模組到使用者資料根及 `~/ego-linux-install/`，產生 `~/.local/bin`、`~/bin` 的命令包裝、修改使用者 PATH、複製技能，並在可用時建立登入自動啟動 VBS；最後**立即啟動服務**。不能把它當成只複製檔案的操作。

Windows 安裝腳本沒有複製 docs、`package.json`、LICENSE 或 NOTICE；不要假設安裝副本完整。若尚未允許 PATH、自動啟動、技能或登入資料變更，停在離線檢查，不執行安裝器。

## 三、執行與健康檢查

以下只供上述專用測試環境使用。

### 啟動

```sh
tp-start
tp-browser status
tp-browser doctor
```

Unix 成功啟動通常輸出 `TP_READY`，Windows 為 `EGO_READY`；失敗分別可能輸出 `TP_NOT_READY`、`EGO_NOT_READY`。以退出碼及後續健康檢查一起判定，不只看訊息。

替代通訊埠：

```sh
# Linux／macOS
tp-start --alt-port
```

```powershell
# Windows：獨立啟動包裝命令會轉交參數
tp-start -AltPort
```

Windows 也會在預設 CDP 回報 Linux 使用者代理時嘗試切到替代組；Unix 不會自動做相同判斷。CLI 依 `daemon.json` 選擇固定的兩組埠位；不能任意指定其他埠。Windows 的 `tp-browser.cmd start` 分支不轉交額外旗標，需參數時使用 `tp-start`。

`TP_BROWSER_BIN` 可指定測試瀏覽器執行檔，否則啟動器自動尋找；不要用它指向個人正在使用的設定檔。Linux root 啟動路徑會加入 `--no-sandbox`，因此優先使用非 root 的隔離測試帳號。

### 判定是否真的就緒

`tp-browser status` 不自動啟動；回應包含 `ok`、`chrome`、`spaces`。只有 `ok: true` 不足，還需 `chrome: true`。`doctor` 只診斷及列出建議，不自動修復，也不能以它的退出碼單獨作健康閘。

需要只讀探測時，可在已確認歸屬的本機實例使用：

```sh
curl --fail --silent --show-error --max-time 3 http://127.0.0.1:9772/health
```

替代組改用 `9774`。使用 `127.0.0.1` 而非 `localhost`，因 daemon 會檢查 Host；瀏覽器來源的請求也可能因 Origin 被拒。不要為了診斷開放對外綁定、加入公開轉送或放寬驗證。

`spaces` 會列出任務名稱；CDP 分頁列表、`snapshot()`、`events()` 可能含私人資訊。除錯摘要只保留必要的布林狀態、版本、步驟與去識別錯誤分類。

### 有頭／無頭切換

`tp-headed` 請求有頭模式；已存在相符有頭行程時腳本可能直接返回，否則可能關閉並重啟瀏覽器。普通 `tp-start` 在實例已健康時也可能直接返回，**不保證把有頭模式切回無頭**；需要明確重新啟動時，Unix 使用 `tp-start --restart`，Windows 使用 `tp-start -Restart`。

切換前停止自己正在執行的代理腳本，切換後檢查實際視窗及重新取得 TaskSpace／分頁。不要依賴共駕膠囊或 `waitForControl()` 暫停代理；現況尚無可靠的控制權互斥。WSL 的 `--headed` 分支可能轉交 Windows，並複製其本機連線與認證檔，不能當成純 Linux 的無副作用操作。

### 停止

現有 `tp-stop` 會使用廣泛行程匹配；Unix 還會嘗試關閉兩組埠位，Windows 停止腳本則沒有相同的保存步驟。共用主機不要使用它作一般清理指令。

手動以獨立終端啟動的測試伺服器以該終端 `Ctrl+C` 停止；受測試執行器管理的行程只由其記錄的確切 PID／行程控制代碼停止。不要按名稱批次終止，也不要刪除整個資料根或正在使用的設定檔鎖。

systemd 範本是另一條生命週期路徑：固定 `/usr/bin/chromium` 與家目錄安裝位置，且不經完整啟動器。尚未確認服務歸屬與重啟政策前不啟用，也不與啟動器混用。本次沒有變更服務或自動啟動設定。

## 四、本機執行範例

前提是隔離測試實例已健康；另開終端，在 clone 根目錄以前景方式啟動合成測試頁：

```sh
node tests/serve.mjs
```

確認輸出指出 `127.0.0.1:8899`，再於另一終端探測：

```sh
curl --fail --silent --show-error --max-time 3 --output /dev/null http://127.0.0.1:8899/
```

Linux／macOS 批次範例：

```sh
node bin/tp-browser.js nodejs <<'EOF'
const task = await taskSpace(`docs-demo-${Date.now()}`);
const page = task.page('p1');
try {
  await page.goto('http://127.0.0.1:8899/', { waitUntil: 'load' });
  await page.fill('#name', '測試使用者');
  await page.click('#hello');
  const actual = await page.evaluate(() => document.querySelector('#out').textContent);
  if (actual !== 'hello 測試使用者 @ tpe') throw new Error('本機頁面驗收失敗');
  console.log('本機頁面驗收通過');
} finally {
  await task.finish({ keep: [] });
}
EOF
```

這是後續測試範例，不是本次已執行的結果。CLI 只接受 `-e` 或標準輸入；`tp-browser nodejs 檔名` **不會把檔名當腳本讀取**。可用 `node bin/tp-browser.js nodejs < tests/smoke.ego.js`；PowerShell 則用：

```powershell
Get-Content -Raw -Encoding UTF8 .\tests\smoke.ego.js | node .\bin\tp-browser.js nodejs
```

原冒煙腳本含固定 Unix 路徑，這條 PowerShell 命令只示範輸入方式，不代表原測試已具 Windows 可攜性。

`page.evaluate()` 的函式不能捕捉本機閉包；透過單一 JSON 參數傳值。檔案另存需要 daemon 主機上的絕對路徑。`TaskSpace.closePage()` 只解除綁定；要關閉指定分頁用 `page.close()`，要結束自建空間用 `finish({ keep: [] })`。不要對不屬於自己的空間執行清理。

## 五、測試步驟與結果解讀

### 冒煙測試

在完整來源樹、專用 Unix 測試環境執行；先確認 `/tmp/ego-linux-smoke.png`、`/tmp/ego-linux-smoke-dl.txt` 沒有其他人的檔案，且固定名稱的測試 TaskSpace 沒有既存工作。

```sh
node bin/tp-browser.js nodejs < tests/smoke.ego.js
```

伺服器需保持執行。原腳本覆蓋空間、導覽、文字輸入、下拉選單、鍵盤、對話框、帶參數 evaluate、彈窗、截圖、下載、錯誤文字、選擇器等待及分頁清理，共 **23 個檢查**。

完整通過的預期結尾為：

```text
== smoke: 23/23 pass ==
ALL_GREEN
```

必須同時確認退出碼為零、23 項全通過、沒有 `FAIL`／`FAILED:`，且取得完整結尾；`check(false)` 目前只記錄失敗，不設定非零退出碼。未捕捉例外才會由 CLI 轉為非零。缺少結尾、逾時或提早退出都不算通過。

測試可能中途留下分頁、空間或輸出檔；只清理此次實際建立的精確項目。不要把截圖、快照或下載加入儲存庫。既有 23 項沒有測上傳、`page.fetch()`、共駕鎖、vault 復原或跨平台安裝，因此全綠也不代表上述能力正常。

### 觀測資料量基準

另一個前景終端：

```sh
node tests/bench/bench-server.mjs
```

驗證本機回應後，再在來源樹執行：

```sh
curl --fail --silent --show-error --max-time 3 --output /dev/null http://127.0.0.1:8890/p1
node bin/tp-browser.js nodejs < tests/bench/bench-run.ego.js
```

腳本對 `p1` 至 `p10` 逐頁量測，stdout 輸出 JSON，進度寫到 stderr；資料列包含 `snapChars`、`snapLines`、`pngBytes` 等欄位。會寫入 `/tmp/bench-p1.png`、`/tmp/bench-p1.snap.txt` 等十組固定檔案，先確認不會覆蓋既有資料。

此測試不是冒煙驗收，也不直接量測 LLM Token、成本或完整任務耗時。輸出中的 `1440x900` 是程式宣告值，仍要核對實際視窗；畫布案例的內嵌腳本含需確認的 HTML 實體寫法，不能只因取得 PNG 就宣稱畫布繪製成功。

### 本次文件工作的驗證紀錄

| 檢查 | 本次結果 |
|---|---|
| JavaScript／ESM 語法 | 使用 Node.js `v26.7.0` 對 Git 追蹤的 `.js`、`.mjs` 執行 `node --check`，通過。這不是 Node.js 22 最低版本的執行期驗證。 |
| Unix shell 語法 | `sh -n` 檢查安裝、啟動與停止三份腳本，通過；未執行其內容。 |
| CLI 無副作用入口 | 本地 `help`、`version` 正常；版本實際顯示 `0.3.1`。 |
| 一次性離線契約探測 | 以 Node.js 內建 assert／VM 及假 RPC 執行 9 項，9 項符合預期；沒有啟動瀏覽器、讀取登入檔或發出網路請求。 |
| 瀏覽器冒煙／基準 | **未執行**：避免啟動器匯入既有資料、影響共用行程或寫入固定測試路徑。 |
| Windows／macOS 實機 | **未執行**；本次在 Linux 閱讀原始碼與做離線檢查。 |

9 項探測包含 SDK 路由、單參數序列化、關頁語意、截圖回傳型態、按鍵剖析，以及確認四個既有落差：缺少 `Store.findByTargetId()`、上傳標記不相容、fetch 參數不相容、兩個 daemon 路由分岔。**「探測通過」代表觀察符合程式現況，不代表這四個問題已修好，也不等於 23 項冒煙測試通過。** 探測只在標準輸入執行，未新增測試程式檔。

## 六、除錯對照

先記錄提交 SHA、平台、Node.js／瀏覽器版本、實際入口、埠位組及最後成功步驟。優先在合成頁重現，不收集認證檔、Cookie、日常頁面快照或原始 CDP 事件。

| 現象 | 核對及保守處置 |
|---|---|
| 找不到命令 | 先用來源樹 `node bin/tp-browser.js help`；核對 PATH 及實際包裝檔，不覆蓋不明同名命令。 |
| `ok: true`、`chrome: false` | daemon 活著但未掛上瀏覽器；核對瀏覽器是否啟用正確 loopback CDP 埠、選到哪個執行檔、設定檔是否被占用。 |
| CLI 連不到 daemon | 核對使用預設還是替代組；`daemon.json` 可能是過期紀錄。不要靠刪除認證檔修復。 |
| `AuthError` 或 HTTP 403 | 確認 CLI 與 daemon 是同一 OS 使用者及資料根，Host 是 `127.0.0.1` 且沒有瀏覽器 Origin。只核對檔案存在／歸屬，不輸出認證值或放寬驗證。 |
| `/docs` 或 `/showcase` 回 404 | 核對入口相鄰的 `docs/index.html` 是否有安裝；Windows 安裝路徑目前不複製 docs。 |
| 啟動前後行為不同 | 核對直接 `tp-browserd` 或啟動器；兩個 daemon 的復原及關閉路由不同，不能只比命令名稱。 |
| `BrowserNotReady`、`PageClosedError`、`UnknownSpace` | 健康端點只是某時點狀態；瀏覽器重啟可能丟棄空間綁定。重新列出自己的空間並取得新頁面，不沿用舊 target。 |
| `ElementResolutionError` | 選擇器需要唯一匹配；先用合成頁確認範圍、可見性與捲動；重新導覽後重取參照。不要盲目重試可能送出的動作。 |
| `invalid DOM mark` | 現有上傳標記產生器與驗證規則不符，見路線圖第 4 項；不要移除驗證或改點原生選檔視窗繞過。 |
| `page.fetch()` 的 `PageError` | 檢查已知的單參數／雙參數落差；增加 timeout 無法修正。尚未修復前不要將它列為可用下載能力。 |
| 事件等待逾時 | SSE 沒有訂閱就緒握手或重連；先等待再觸發的寫法仍需驗證競態。檢查實際結果，避免重複點擊、上傳或下載。 |
| 對話框後看似卡住 | 在自己的測試分頁使用 `page.info()` 判斷對話框，再 `acceptDialog()`／`dismissDialog()`；不要在已開啟的模態對話框後繼續評估 DOM。 |
| 人類接手但代理仍在動 | 目前沒有控制權閘，且狀態回呼缺方法；先停止自己的代理腳本。UI 文案不能證明代理已暫停。 |
| `reload()` 回空白、`closePage()` 未關頁 | 已知帳本／語意落差；用明確的測試 URL 導覽，或用 `Page.close()` 關閉自己的頁面。 |
| 切換或登出後舊狀態又出現 | profile 匯入、Cookie／storage vault 及刪除同步都需核對。不要自動重跑匯入、清空資料根或使用真實登入態實驗。 |
| `BadPath` | daemon 要求本機絕對路徑且拒絕 `..`；相對路徑範例不適用。`safePath` 不是工作區允許清單。 |

Unix 啟動器把輸出附加到資料根下 `logs/daemon.log`、`logs/chrome.log`；只在受控環境看必要錯誤，日誌可能含網址及其他私人內容。Windows 並未同樣重導向輸出，不能以空 logs 目錄判定 daemon 沒有報錯。沒有內建日誌輪替或完整錯誤分類，亦存在吞掉例外的路徑。

## 七、資料操作與決策點

Cookie 匯入／匯出工具會處理登入態，vault 則是未做應用層加密的 JSON；本次不執行、不複製，也不提供真實內容範例。`resetSiteAuth()` 與共駕「換帳號」具有清除副作用，且可能涵蓋相關網域，不屬只讀除錯步驟。對既有設定檔的備份、移轉、清除與保存期限均需另行決定。

**決策點：** BOB 尚需決定設定檔匯入／保存預設、共駕互斥政策、優先平台及是否另開實作工作。未決前維持文件限定、單實例假設、無真實登入資料的隔離測試，不修改程式或正式服務。詳細選項見[路線圖決策點](ROADMAP.md#決策點)。
