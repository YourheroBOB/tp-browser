# tp-browser 資安與可靠性稽核

## 範圍與限制

本報告只根據本次提供的檔案清單與檔案內容進行靜態檢視；未執行程式、未連線網路服務，也未讀取或複製任何憑證或個人資料。嚴重度反映所提供程式碼可見的風險及其前提，不代表已完成動態驗證。

檔案清單中有多個關鍵實作未提供內容，例如 `daemon/ego-browserd.js`、`daemon/tp-browserd.js`、`daemon/page-ops.js`、`daemon/inpage.agent.js` 與 `lib/sdk.js`。因此，HTTP 認證、RPC 輸入限制、`safePath` 實作、檔案上傳／下載及瀏覽器指令處理等項目無法判定；README 的安全性聲明也不能代替對應程式碼驗證。以下發現限於可見程式碼，不能視為完整的動態或全倉庫稽核。

嚴重度：**高**＝可能造成高影響的執行或機密風險；**中**＝需要特定本機環境、操作方式或併發條件；**低**＝影響較局部。

---

## 發現

### F-01：`nodejs` 功能會以呼叫者權限執行任意 Node.js 程式碼

- **嚴重度：高**
- **位置：** `bin/tp-browser.js:約 160–213`；`bin/ego-browser.js` 對應的 `runNodeJs()`。
- **重現方式：** 以 `nodejs -e` 或 stdin 提供一段只輸出 `typeof process` 的程式，即可觀察程式在一般 Node.js 環境執行，而非瀏覽器沙箱。此執行環境可使用 Node.js API；因此，不可信腳本可能讀寫呼叫者可存取的檔案、啟動程序或連線網路。
- **修補建議：** 將此功能明確界定為「僅執行信任的本機程式碼」。若必須處理不可信程式碼，應使用由作業系統強制隔離的專用帳號／容器及資源限制；不能把 `vm` 或 Worker 當成安全沙箱。可加入避免誤用的明確啟用門檻，但此門檻本身不是隔離措施。

```js
// 僅是防止意外使用的門檻，不是安全沙箱。
if (process.env.TP_BROWSER_NODEJS_POLICY !== 'trusted') {
  throw new Error(
    'nodejs 會以目前 OS 使用者權限執行程式；請僅在信任的隔離環境中明確啟用。'
  );
}
```

### F-02：CDP 除錯端點對本機連線未見認證

- **嚴重度：中；多人共用主機上升為高**
- **位置：** `scripts/tp-start.sh:約 150–190`、`scripts/ego-start.ps1` 啟動 Chromium 的參數區段、`scripts/ego-linux-chrome.service:7`。
- **重現方式：** 在同一台主機查詢 `http://127.0.0.1:9773/json/version`；若瀏覽器正在執行，端點會回傳 CDP 連線資訊。啟動參數只限制綁定 loopback，未顯示對該端點另加認證。此檢查只需觀察回應，不應再對真實使用者瀏覽器執行其他操作。
- **影響：** Loopback 限制可降低區網直接連線風險，但不是本機使用者或本機程序之間的隔離。若其他本機帳號或不受信任程序可連線，可能接觸瀏覽器控制介面及登入中的瀏覽器工作階段。
- **修補建議：** 優先考慮由 daemon 使用 OS 管理的 IPC／pipe（例如 CDP pipe），並限制 pipe ACL；若保留 WebSocket，必須清楚界定為同一 OS 使用者信任邊界，並避免在多人共用主機上暴露。單純改用隨機埠或增加另一個 loopback URL，不能等同存取控制。

```text
# 架構修補方向：改用作業系統控制存取權的 CDP IPC／pipe，
# 並由 daemon 僅向獲授權的本機使用者提供操作介面。
```

### F-03：以 root 啟動時停用 Chromium sandbox

- **嚴重度：高（僅在以 root 執行時成立）**
- **位置：** `scripts/tp-start.sh:146–149`。
- **重現方式：** 在 Linux／macOS 以 root 身分執行啟動腳本，程式會設定 `--no-sandbox` 並將它傳給瀏覽器。這會降低處理不可信網頁內容時的隔離能力；瀏覽器漏洞的影響可能擴大至 root 權限。
- **修補建議：** 預設拒絕以 root 執行，而非自動關閉 sandbox；需要服務部署時，使用專用非特權 OS 帳號。

```sh
if [ "$(id -u 2>/dev/null || echo 1000)" = "0" ]; then
  echo "ERROR: refuse to run browser as root; use a dedicated unprivileged account." >&2
  exit 1
fi
```

### F-04：啟動初始化會自動複製本機瀏覽器的登入資料

- **嚴重度：高**
- **位置：** `tools/profile-init.js:約 118–205`；另見 `scripts/tp-start.sh` 呼叫 `profile-init.js` 的區段及 `scripts/ego-start.ps1` 初始化區段。
- **重現方式：** 在有既存瀏覽器 Profile 的環境執行初始化程式，程式會掃描本機瀏覽器 Profile，並在符合條件時複製登入資料庫、Cookies 資料庫、`Local State` 中的加密設定、Local Storage 與 IndexedDB 至 agent Profile。這不是只複製書籤的操作。
- **影響：** 使用者的登入狀態與其他網站儲存資料會複製至另一個 Profile；目標目錄權限、備份及清除政策會直接影響這些資料的機密性。初始化程式多處吞掉錯誤，也沒有在程式中明確要求使用者同意資料複製。
- **修補建議：** 預設只同步非敏感資料（若使用者選擇）；Cookies、登入資料庫及儲存資料另設明確的 opt-in，並顯示資料類型與目的地。建立 Profile 時明確設定最小權限，且不要在瀏覽器仍開啟時直接複製資料庫檔案。

```js
const syncAuth = process.argv.includes('--sync-auth');

if (syncAuth) {
  // 僅在使用者明確選擇後執行 Cookies／登入資料／站點儲存資料同步。
  // 實作時仍需處理檔案權限、鎖定與一致性。
}
```

### F-05：安裝器從可變動的預設分支取得程式碼，缺少版本固定與完整性驗證

- **嚴重度：中**
- **位置：** `install.sh:25`、`install.ps1:9`。
- **重現方式：** 靜態檢視安裝器中的 `git clone --depth 1` 呼叫；程式未指定不可變 commit、已驗證簽章或預期雜湊。Windows 安裝器後續會啟動複製的服務程式碼。
- **影響：** 安裝結果取決於當時遠端預設分支內容；若來源帳號、分支或傳輸供應鏈遭竄改，使用者可能安裝非預期程式碼。此發現是靜態供應鏈風險，不表示本次有連線或驗證遠端內容。
- **修補建議：** 以已審查的固定版本／commit 下載，並驗證可信任的簽章或雜湊；驗證失敗時中止。不要以「只 clone 最新版本」作為完整性控制。

```sh
EXPECTED_COMMIT="${TP_BROWSER_EXPECTED_COMMIT:?set an independently verified commit}"
git -C "$TMP_CLONE" checkout --detach "$EXPECTED_COMMIT"
# 實際部署還應驗證可信任的簽章或發行檔雜湊；未驗證則應中止。
```

### F-06：Profile 初始化允許環境變數指定任意資料根目錄，且未見目的地 symlink 防護

- **嚴重度：中**
- **位置：** `tools/profile-init.js:7–11` 及 Profile 檔案複製區段。
- **重現方式：** 在只含合成測試檔案的隔離環境中設定 `EGO_LINUX_DATA_DIR` 為測試目錄並執行初始化程式，觀察目的地根目錄由該環境變數決定。若 Profile 目的地已被植入 symlink，常見 `copyFileSync`／`mkdirSync` 路徑操作不會自動證明其最終目的地仍在預期根目錄內。
- **影響：** 在環境變數或 Profile 目錄受不可信呼叫者控制的情境下，可能造成敏感 Profile 資料寫入非預期位置，或透過 symlink 寫入根目錄之外。這不是遠端輸入直接利用的證據；需要本機執行環境／檔案系統受到影響。
- **修補建議：** 將資料根目錄限制在已核准的使用者目錄；對來源與目的地元件檢查 symlink，並在寫入前驗證解析後的真實路徑仍位於允許根目錄下。

```js
import { resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';

const allowedRoot = realpathSync(join(home, '.local', 'share', 'ego-linux'));
const requested = resolve(process.env.EGO_LINUX_DATA_DIR || allowedRoot);

if (requested !== allowedRoot &&
    !requested.startsWith(allowedRoot + sep)) {
  throw new Error('data directory must remain inside the approved root');
}
```

### F-07：Store 持久化遇到 rename 失敗時改為直接覆寫，且跨程序更新沒有協調

- **嚴重度：中；多個 daemon 共用同一檔案時成立**
- **位置：** `daemon/store.js:10–24`。
- **重現方式：** 靜態檢視可見：先寫暫存檔再 rename；rename 失敗後退回直接寫原檔。若程序在直接覆寫期間終止，下一次載入可能遇到截斷或不完整 JSON。`load()` 對 parse 錯誤只記錄後改用新狀態；若隨後持久化，原狀態可能被覆蓋。此檔案亦沒有跨程序鎖；若兩個 daemon 寫入同一 Store，更新可能互相覆蓋。
- **修補建議：** 不要在 rename 失敗時直接覆寫正式檔；設定嚴格權限、加入 schema 驗證與跨程序單一寫入／鎖定策略，並在載入錯誤時保留原檔供復原。

```js
writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' });
try {
  renameSync(tmp, this.file);
} catch (error) {
  try { unlinkSync(tmp); } catch {}
  throw error; // 不退回直接覆寫正式檔
}
```

### F-08：CDP 連線關閉或送出失敗時可能留下計時器與 pending request

- **嚴重度：中**
- **位置：** `daemon/cdp.js:25–38、61–70`。
- **重現方式：** 靜態檢視 `send()` 可見：先將 request 加入 `pending` 並建立 timer，再呼叫 `ws.send()`；沒有明確處理同步送出例外並立即清理該項目。關閉處理會拒絕 pending request 並清空 Map，但未逐一清除其 timer。持續送出命令或反覆中斷連線時，會增加不必要的等待回呼及資源占用。
- **修補建議：** 所有完成、錯誤與 close 路徑都清除 timer；送出失敗時移除 pending；設定最大 pending 數量並在超限時拒絕新請求。

```js
try {
  this.ws.send(JSON.stringify(msg));
} catch (error) {
  clearTimeout(timer);
  this.pending.delete(id);
  reject(error);
}
```

### F-09：啟動器在子程序啟動失敗或 Profile 初始化失敗時可能回報成功或繼續執行

- **嚴重度：中**
- **位置：** `bin/tp-browser.js` 與 `bin/ego-browser.js` 的 `runLauncher()`；`scripts/tp-start.sh` 呼叫 `profile-init.js` 的區段；`tools/profile-init.js` 多處錯誤處理區段。
- **重現方式：** `spawnSync()` 啟動失敗時可能回傳 `status: null` 並設定 `error`；`runLauncher()` 使用 `r.status ?? 0`，會把此情況轉成成功狀態。另，`tp-start.sh` 對 Profile 初始化使用 `|| true`，而初始化內多個複製／寫檔錯誤被吞掉，故初始化未完成時仍會繼續啟動。
- **修補建議：** 檢查 `spawnSync` 的 `error` 及 `status`，以非零狀態反映失敗；初始化結果應可辨識，若必要初始化失敗應停止啟動，若為選用功能則輸出不含敏感值的明確警告。

```js
if (r.error) throw r.error;
if (r.status === null) return 1;
return r.status;
```

```sh
if ! node "$PROFILE_INIT_JS"; then
  echo "ERROR: profile initialization failed" >&2
  exit 1
fi
```

### F-10：腳本輸入無大小上限，執行亦沒有可靠的外部期限

- **嚴重度：中**
- **位置：** `bin/tp-browser.js` 與 `bin/ego-browser.js` 的 `runNodeJs()` stdin 收集與動態 import 區段，約 `160–213`。
- **重現方式：** 傳入持續產生大量資料的 stdin，程式會持續累加 `buf`；傳入不會結束的同步迴圈，程式會一直占用 CLI 執行緒。僅在 import 完成或丟出例外後的清理程式，無法處理同步無限迴圈。
- **修補建議：** 限制 stdin 最大位元組數；需要可取消執行時，將腳本放到可由父程序終止的子程序中，設定明確 wall-clock timeout 與輸出限制。僅使用 `Promise.race()` 不能中斷同步無限迴圈。

```js
const MAX_SCRIPT_BYTES = 1_000_000;
if (Buffer.byteLength(buf, 'utf8') + Buffer.byteLength(d, 'utf8') >
    MAX_SCRIPT_BYTES) {
  reject(new Error('script input exceeds configured limit'));
  process.stdin.destroy();
  return;
}
```

---

## 相依套件與其他稽核觀察

- 提供的 `package.json` 未列出 npm 執行期相依套件，程式宣稱使用 Node.js 內建 API；提供的檔案清單亦未列出 lockfile。這降低 npm 相依樹風險，但不是完整 SBOM 或供應鏈驗證。
- 執行環境仍依賴 Node.js 與外部瀏覽器。安裝器取得程式碼的版本固定問題見 F-05；本次未執行套件或二進位掃描。
- Shell 啟動器以 Node `spawn()` 傳遞瀏覽器參數，而非把整段參數交給 shell；從可見片段未確認到直接由網頁輸入觸發的 shell 命令注入。但 PowerShell／daemon 未提供完整實作，不能據此排除其他命令注入風險。
- daemon、SDK 及頁面操作程式碼未提供；HTTP Host／Origin 驗證、token 常數時間比較、JSON body 上限、輸入驗證、路徑穿越與 symlink 防護、錯誤回應是否洩漏內容，以及 RPC 的 fail-open／fail-closed 行為均列為**未驗證**。
- 報告未引用任何實際 token、密碼、客戶資料或瀏覽器內容；未連線任何正式服務。
