# 02 · TaskSpace 狀態檔審查（`daemon/store.js`）

`daemon/store.js` 以單一 JSON 檔持久化所有 TaskSpace、分頁標籤與 `targetId` 綁定。它是整個 daemon 中**唯一同步磁碟 I/O** 的位置，因此對延遲與資料安全的影響被放大。

---

## S-01 每次 mutation 都同步全量寫檔 · **P1**

- **位置**：`daemon/store.js` · `persist()`（`writeFileSync(tmp, body)` + `renameSync`），被 `create()`、`nextLabel()`、`setPage()`、`bindPage()`、`addPage()`、`removePage()`、`deleteSpace()` **每一次**呼叫。
- **影響**：
  1. 一次 `page.goto()` 期間通常伴隨多次 title/url 更新（`setPage`），加上 `bindPage`/`nextLabel` → 一次導航可能觸發 **3~5 次完整 JSON 序列化 + 兩次檔案系統操作**。
  2. 成本為 **O(整份 ledger)**：space 與 page 越多，單次寫入越慢；且每次都要 `JSON.stringify(this.data, null, 1)`（含縮排，size 更大）。
  3. 全部是**同步** I/O，會阻塞 event loop —— 也就是阻塞同一時間進來的所有 CDP 訊息處理，形成延遲抖動。
- **建議修法**：
  ```js
  markDirty() {
    this._dirty = true;
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => this.flush(), 250);
    this._flushTimer.unref?.();
  }
  flush() {
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    if (!this._dirty) return;
    this._dirty = false;
    /* 原子寫入（見 S-02） */
  }
  ```
  - 所有 mutation 改呼叫 `markDirty()`；`flush()` 在下列時機強制執行：SIGTERM/SIGINT、daemon 的 `/flush-and-close`、`deleteSpace()`、以及每 30 秒的低頻保底 flush。
  - 縮排改為 `JSON.stringify(this.data)`（無縮排）可再省 20~30% 體積（除錯時用環境變數切回美化）。
- **驗證方式**：`tmp_path` 建 Store → 連續 1,000 次 `setPage` → 以計數 wrapper 包住 `writeFileSync`，斷言寫檔次數 ≤ 5；並用 `performance.now()` 量測單次 mutation 耗時（應由 1~10 ms 降至 < 0.1 ms）。

---

## S-02 rename 失敗時的非原子 fallback · **P1**

- **位置**：`daemon/store.js` · `persist()` 的 `catch { writeFileSync(this.file, body); }`。
- **影響**：`renameSync` 失敗（Windows 上防毒/索引服務短暫鎖檔很常見）時，直接覆寫主檔且**無原子性**——若此時斷電或程序被殺，會留下截斷的 JSON；配合 S-03 就變成「整個 ledger 靜默歸零」。另外失敗時 `${file}.${pid}.tmp` 不會被清掉，長期累積孤兒檔。
- **建議修法**：
  - 失敗時**不要覆寫主檔**：改寫 `${file}.bak` 並記錄 warn，下一輪再重試 rename。
  - 強化原子性：`openSync(tmp,'w',0o600)` → `writeSync` → `fsyncSync` → `closeSync` → `renameSync`（必要時再 fsync 目錄）。
  - `catch` 內 `unlinkSync(tmp)`（以 try 包住）避免孤兒檔。
- **驗證方式**：以 `mock` 讓 `renameSync` 第一次 throw、第二次成功，斷言主檔內容在失敗後**仍為舊內容且可解析**，第二次 flush 後才更新。

---

## S-03 `load()` 解析失敗靜默重建，可能覆蓋可修復的檔案 · **P0**

- **位置**：`daemon/store.js` · `load()` 的 `catch (e) { console.error('... starting fresh:', e.message); }`（`this.data` 保持建構子的空預設值）。
- **影響**：JSON 損壞（S-02 的截斷、磁碟寫滿、外部編輯）時，daemon 以**空 ledger** 啟動；下一次任何 mutation 就 `persist()` **覆蓋掉原檔**——所有 space/分頁/URL/title 永久消失，而且只留一行容易淹沒的 console 訊息。對「單 turn 批次腳本」的使用者是災難級的無聲失敗。
- **建議修法**：
  ```js
  } catch (e) {
    const backup = `${this.file}.corrupt-${Date.now()}`;
    try { renameSync(this.file, backup); } catch {}
    console.error(`[store] ledger unreadable (${e.message}); preserved as ${backup}`);
  }
  ```
  並在 `/health` 回報 `store.recovered: true` + `store.backupPath`，讓 `doctor` 能提示使用者。
- **驗證方式**：`tmp_path` 寫入 `"{ not json"` → 建 Store → 斷言產出 `*.corrupt-*` 備份檔、`load` 未拋錯、且後續 `flush()` 不會覆寫備份檔。

---

## S-04 狀態檔權限未收斂（預設受 umask 影響） · **P1**

- **位置**：`daemon/store.js` · `writeFileSync(tmp, body)` 未指定 `mode`。
- **影響**：ledger 內含 **URL、頁面標題、space 名稱**（即瀏覽行為軌跡）。專案在別處已明確要求 `0600`/`0700`（token、`mkdtempSync`），此處不一致；在共用機器上（專案 README 已提醒多人共用主機需獨立帳號）可能被同機其他使用者讀取。
- **建議修法**：`writeFileSync(tmp, body, { mode: 0o600 })`；rename 後 `chmodSync(this.file, 0o600)`（Windows 上 `chmod` 無效，改為在安裝腳本以 `icacls` 收斂資料夾權限，屬既有機制）。文件補一行「ledger 含瀏覽軌跡」。
- **驗證方式**：`tmp_path` 建立 Store 後 `statSync(file).mode & 0o777 === 0o600`（POSIX）；Windows 上以 `icacls` 輸出人工核對。

---

## S-05 無界成長：`spaces` 與 `labelSeq` 永不清理 · **P1**

- **位置**：`daemon/store.js` · `deleteSpace(id)` 僅 `delete this.data.spaces[id]`，**未刪 `this.data.labelSeq[id]`**；`load()` 無 prune；`state` 欄位有 `'active'` 但沒有終態回收。
- **影響**：Agent 每次任務建一個 space（README 範例即是），常駐數週後 ledger 線性膨脹，**直接放大 S-01 的成本**（每次寫入越來越慢）。`labelSeq` 相對小但同樣單調成長。
- **建議修法**：
  - `deleteSpace()` 同步 `delete this.data.labelSeq[id]`。
  - `load()` 時 prune：`createdAt` 超過 N 天（例如 14 天）且 `state !== 'active'` 或所有 `pages[*].targetId` 皆為 `null` 的 space。
  - 文件化 prune 規則並在 `/health` 回報 `store.spaces` 數量，讓成長可見。
- **驗證方式**：造 500 個逾期的假 space 寫入檔案 → 建 Store → 斷言 prune 後數量符合預期、且 `nextSpaceId` 仍大於所有既有 id（避免 id 碰撞）。

---

## S-06 `nextLabel()` 先消耗序號再回傳 · **P2**

- **位置**：`daemon/store.js` · `nextLabel()` 先 `+1` 並 `persist()` 才回傳 `p${seq}`。
- **影響**：若後續開頁失敗（Chrome 拒絕、逾時），序號已被消耗 → Agent 看到的標籤會跳號（p1→p3），而 Agent 端腳本常以「連續標籤」做推理，跳號會造成誤解與重試錯亂。
- **建議修法**：改為「配置但不落地」——`reserveLabel()` 只回傳候選值，實際 `bindPage`/`addPage` 成功後才 commit 序號；搭配 S-01 的 debounce 天然合併為一次寫入。
- **驗證方式**：模擬 `bindPage` 拋錯，斷言下一次 `reserveLabel()` 仍回傳同一個標籤。

---

## S-07 debounce 後的併發保護（連帶） · **P2**

- **位置**：`daemon/store.js` · `persist()` 的暫存檔名 `${this.file}.${process.pid}.tmp`。
- **影響**：目前因為全同步，同一時間只會有一次寫入；**一旦導入 S-01 的 debounce**，就可能出現「flush 進行中又發生 mutation」或「兩次 flush 交錯」的情境，共用同一個 tmp 檔名會互相覆寫。
- **建議修法**：加 `this._flushing` 旗標與單調序號（tmp 檔名附序號），flush 結束後若 `_dirty` 再排一次；並在 `flush()` 內部完全同步（不做 await），確保不會有兩個 flush 交錯。
- **驗證方式**：單元測試以 `setInterval` 高頻 mutation 的同時觸發 flush，執行 10 秒後斷言檔案始終可解析（以循環讀取 1,000 次驗證）。
