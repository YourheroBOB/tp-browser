# 04 · 啟動成本與 profile 初始化（`tools/profile-init.js`）

`tools/profile-init.js` 在**每次** `tp-start`／`ego-start` 都會被同步執行（`scripts/tp-start.sh` 的 `[ -f "$PROFILE_INIT_JS" ] && node "$PROFILE_INIT_JS"`，`scripts/ego-start.ps1` 的 `& $NodeBin $ProfileInitJs`）。它同時是本專案**啟動延遲的主要來源**與**最敏感的行為**（碰觸使用者日常瀏覽器的憑證資料庫）。

---

## I-01 每次啟動都全機掃描瀏覽器 profile 並同步複製大目錄 · **P1**

- **位置**：`tools/profile-init.js` · `addRoot()`（對每個 User Data 根目錄 `readdirSync` 全部子目錄）、`dirSize()`（逐檔 `statSync`）、`IndexedDB` 的 `cpSync(..., { recursive: true })`、`Local Storage` 的逐檔 `copyFileSync`。
- **影響**：使用者本機的 Chrome/Edge/Brave User Data 常有數個 profile、Local Storage 與 IndexedDB 合計數百 MB 到數 GB。這段是**同步**執行且發生在 daemon 與 Chrome 啟動之間，直接拉長 `TP_READY` 時間（實務上從數秒到數十秒），也讓 `tp-start` 看起來像「卡住」。在 SSD 上大量小檔 `statSync` 尤其傷。
- **建議修法**：
  1. 加 marker `$PROFILE_DIR/.tp-profile-init.json`，內容記錄來源 profile 的 `mtimeMs` + 檔案大小摘要；來源未變且 marker 存在時**直接跳過整個掃描**（最快路徑 < 50 ms）。
  2. 分級：預設只做必要項（`Preferences` 的書籤列設定、`Bookmarks`），Favicons/Login Data/Cookies/Local Storage/IndexedDB 改由 `--sync-auth`／`--force` 顯式觸發（與 I-02 的決策綁在一起）。
  3. 大型目錄同步改為 `fs.promises` + `pipeline`，或設定大小上限（例如 > 200 MB 只記錄警告並跳過）。
  4. 若仍要同步，改為在 daemon 啟動**之後**、以低優先度背景執行（不阻塞 `TP_READY`）。
- **驗證方式**：在 `tmp_path` 造一個含 5,000 個小檔的假 User Data 樹，量測 `node tools/profile-init.js` 首次與第二次（marker 生效）耗時，斷言第二次 < 200 ms；並量測 `time tp-start --restart` 前後差異（三次取中位數）。

---

## I-02 預設複製憑證資料庫（`Login Data`、`Cookies`、`Local State` os_crypt） · **P0（行為/安全）**

- **位置**：`tools/profile-init.js` · `for (const dbName of ['Login Data', 'Login Data For Account', 'Web Data'])` 與 `srcCookies`/`dstCookies` + `srcLs.os_crypt` 複製區塊（無條件、非 `--force` 才做）。
- **影響**：
  1. **一致性風險**：來源瀏覽器很可能正在執行，直接 `copyFileSync` 一個開啟中的 SQLite DB 會複製到半寫入狀態，可能在 `profile-agent` 端造成 SQLite 損毀（Chrome 啟動後可能丟棄或重建），反而讓登入態消失。
  2. **範圍風險**：預設就把使用者日常瀏覽器的登入憑證資料庫與加密金鑰（`Local State` 的 `os_crypt`）複製一份到 agent profile，是「預設開啟」的高敏感行為；若 agent profile 被匯出/備份/共享，等於連帶外洩。
  3. 專案核心賣點是「Cookie 100% 本機自持」，此行為應由使用者明確選擇，而非預設。
- **建議修法**（需 BOB 決策，見 D-01）：
  - 預設**不複製**憑證類檔案；`--sync-auth` 才執行，並在輸出明確說明影響。
  - 複製前後比對來源檔的 `size`/`mtimeMs`，不一致就跳過並記 warn（避免半寫入副本）。
  - 先寫到 `*.tmp` 再 `rename`，避免留下半個 DB。
  - 文件（README/SKILL）補一段「本工具會/不會存取哪些檔案」。
- **驗證方式**：以 `tmp_path` 造兩個假 DB（內容使用 `FAKE_VALUE_FOR_TEST`），模擬「複製中來源變動」→ 斷言跳過且輸出警告；預設模式執行後斷言 `Login Data`/`Cookies` **未被建立**（`--sync-auth` 才建立）。

---

## I-03 全檔大量 `try {} catch {}` 靜默吞錯 · **P1**

- **位置**：`tools/profile-init.js` 幾乎每個複製區塊（例如 `try { copyFileSync(...) } catch {}`、`try { cpSync(...) } catch {}`）。
- **影響**：書籤/登入態沒同步成功時，使用者**完全沒有訊息**；後續只會覺得「登入態怎麼不見了」。這也是效能問題的隱形來源：失敗但被重試的目錄會在每次啟動重掃。
- **建議修法**：統一累積 `warnings: string[]`（只放檔名與錯誤碼，**絕不放內容**），結束時輸出一行摘要（例如 `[profile-init] 3 warnings (see --verbose)`）；`--verbose` 才逐條列出。
- **驗證方式**：讓 `copyFileSync` 對其中一個檔案 throw（以唯讀目錄或 mock），斷言輸出含警告摘要與計數，且不含任何檔案內容。

---

## I-04 `addRoot()` 產生重複候選，重複計算書籤與目錄大小 · **P2**

- **位置**：`tools/profile-init.js` · `const subs = new Set(['Default', 'Profile 1', ...]); for (const entry of readdirSync(baseDir)) subs.add(entry);`，之後對每個 sub 檢查 `Bookmarks` 與 `AccountBookmarks` 各推入一個 candidate。
- **影響**：同一個 profile 可能被推入 2 次（`Bookmarks` + `AccountBookmarks`），且固定清單與 `readdirSync` 重疊；後續 `countBookmarks`／`fileSize`／`dirSize` 全部重跑，放大 I-01 的成本。
- **建議修法**：以 `bmFile` 為 key 對 `candidates` 去重（`new Map()`），並在選擇 `bestCandidate` 時同時記錄兩個來源檔，避免重複 stat。
- **驗證方式**：在 `tmp_path` 造一個含 `Bookmarks` 與 `AccountBookmarks` 的 profile，斷言 `candidates.length === 1`（或加上計數斷言 `countBookmarks` 只被呼叫一次／profile）。

---

## I-05 強制覆寫 Chrome 的 `exit_type`/`exited_cleanly` · **P3**

- **位置**：`tools/profile-init.js` · `prefs.profile.exit_type = 'Normal'; prefs.profile.exited_cleanly = true;`（每次都寫）。
- **影響**：若上一次是真的崩潰，這裡會抹掉 Chrome 的崩潰標記，使 session restore 行為與診斷資訊失真（也讓「為什麼我的分頁不見了」更難追）。
- **建議修法**：只在 `prefs.profile` 不存在時寫入預設值；已存在時保留原值。
- **驗證方式**：先在 `Preferences` 寫入 `exit_type: 'Crashed'`，執行 `profile-init.js`，斷言值仍為 `'Crashed'`。

---

## 附帶：啟動路徑的整體時間分佈（建議量測）

| 階段 | 目前 | 備註 |
|---|---|---|
| 停止舊程序（`pkill` + `sleep 1.0` + `sleep 0.6`） | ≈ 1.6 s 固定 | L-05 改 pidfile 後可縮短且更安全 |
| `profile-init.js` | 數秒 ~ 數十秒（隨使用者資料量） | I-01 加 marker 後應 < 0.2 s（熱啟動） |
| daemon 監聽 | 未知（待看 `ego-browserd.js`） | L-07 改輪詢 |
| Chrome 啟動 + CDP 可用 | 1~5 s | 受磁碟與擴充功能影響 |
| daemon attach + `/health` 綠燈 | 輪詢上限 10~12 s | L-09 移除迴圈內 CIM 可少 1 s 以上 |
