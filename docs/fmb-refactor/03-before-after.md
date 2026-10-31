# 03 — 關鍵片段重構前後對照

> 所有對照皆為**計畫示意**，尚未套用。原則：行為保持、公開介面不變、輸出字串不變。
> 「重構前」片段逐字取自本輪快照提供的檔案內容。

## §1 `daemon/store.js`：`bindPage`／`addPage` 去重（Batch 1）

### 重構前（逐字）

```js
  bindPage(spaceId, label, targetId, openedBy = 'agent') {
    const s = this.get(spaceId);
    if (!s) throw new Error(`unknown space ${spaceId}`);
    s.pages[label] = { targetId, openedBy, title: '', url: '' };
    this.persist();
  }
  addPage(spaceId, label, targetId, openedBy = 'agent') {
    const s = this.get(spaceId);
    if (!s) throw new Error(`unknown space ${spaceId}`);
    s.pages[label] = { targetId, openedBy, title: '', url: '' };
    this.persist();
  }
```

### 重構後

```js
  // 內部單一實作；bindPage / addPage 為語意別名，公開簽名不變。
  _upsertPage(spaceId, label, targetId, openedBy) {
    const s = this.get(spaceId);
    if (!s) throw new Error(`unknown space ${spaceId}`);
    s.pages[label] = { targetId, openedBy, title: '', url: '' };
    this.persist();
  }
  bindPage(spaceId, label, targetId, openedBy = 'agent') {
    this._upsertPage(spaceId, label, targetId, openedBy);
  }
  addPage(spaceId, label, targetId, openedBy = 'agent') {
    this._upsertPage(spaceId, label, targetId, openedBy);
  }
```

**行為保持驗證**：Batch 0 的等價測試——同一序列操作（`create` → `bindPage` → `addPage`）在新舊版本產生的 ledger JSON `diff` 為空；`list()`／`get()` 結果相同。
**附帶（同批）**：`nextLabel` 加註解「`labelSeq` 於 `create` 時為 1（對應 `p1`）；本方法先遞增再回傳，首次回傳 `p2`」——不改正確但反直覺的歷史語意（D6），由 characterization test 固定。

---

## §2 `tools/profile-init.js`：SQLite sidecar 清理去重（Batch 2）

### 重構前（三處近似重複之一，逐字）

```js
      try {
        for (const ext of ['-journal', '-wal', '-shm']) {
          try { if (existsSync(dstDb + ext)) unlinkSync(dstDb + ext); } catch {}
        }
        copyFileSync(srcDb, dstDb);
      } catch {}
```

（同型迴圈另出現於 Favicons 同步與 Cookies 同步。）

### 重構後

```js
// 複製 SQLite 檔前先移除目的端的 journal/wal/shm sidecar，避免新舊 sidecar 混用毀損。
// 回傳 true/false，讓上層能記錄「哪個 DB 同步成功」，取代純靜默的 catch {}。
function copySqliteFile(src, dst) {
  try {
    for (const ext of ['-journal', '-wal', '-shm']) {
      try { if (existsSync(dst + ext)) unlinkSync(dst + ext); } catch {}
    }
    copyFileSync(src, dst);
    return true;
  } catch {
    return false;
  }
}
```

三個呼叫端改為 `copySqliteFile(srcDb, dstDb)`，條件判斷（`forceSync || dstSz < srcSz * 0.5` 等）**原樣保留在呼叫端**。
**行為保持驗證**：以 `tmp_path` 假 profile 樹（假 SQLite 佔位檔＋預置 sidecar 檔）對新舊版本跑同一場景，比較最終檔案樹與檔案內容完全一致。

---

## §3 `scripts/tp-start.sh`：Chrome 旗標單源（Batch 4）

### 重構前（兩分支各一份完整旗標清單，逐字節錄）

```sh
if [ "$HEADED" -eq 1 ]; then
  # shellcheck disable=SC2086
  spawn_detached "$LOGS_DIR/chrome.log" "$BROWSER_BIN" $SANDBOX_FLAG \
    --no-first-run --no-default-browser-check \
    --remote-debugging-address=127.0.0.1 \
    --remote-debugging-port="$CHROME_PORT" \
    --user-data-dir="$PROFILE_DIR" \
    --window-size=1440,900 \
    --disable-blink-features=AutomationControlled \
    --disable-background-timer-throttling \
    --disable-backgrounding-occluded-windows \
    --disable-renderer-backgrounding \
    --noerrdialogs --disable-popup-blocking --disable-quic \
    "http://127.0.0.1:$DAEMON_PORT/newtab"
else
  # shellcheck disable=SC2086
  spawn_detached "$LOGS_DIR/chrome.log" "$BROWSER_BIN" --headless=new $SANDBOX_FLAG \
    --no-first-run --no-default-browser-check \
    ...（與上完全相同，僅多 --disable-extensions、URL 為 about:blank）
fi
```

### 重構後

```sh
# 所有旗標皆不含空白，未加引號的 $CHROME_COMMON_FLAGS 展開結果與重構前逐字相同。
CHROME_COMMON_FLAGS="--no-first-run --no-default-browser-check \
--remote-debugging-address=127.0.0.1 \
--remote-debugging-port=$CHROME_PORT \
--user-data-dir=$PROFILE_DIR \
--window-size=1440,900 \
--disable-blink-features=AutomationControlled \
--disable-background-timer-throttling \
--disable-backgrounding-occluded-windows \
--disable-renderer-backgrounding \
--noerrdialogs --disable-popup-blocking --disable-quic"

if [ "$HEADED" -eq 1 ]; then
  # headed：開啟 daemon 的 /newtab，交給人類通過 Cloudflare / 2FA
  # shellcheck disable=SC2086
  spawn_detached "$LOGS_DIR/chrome.log" "$BROWSER_BIN" $SANDBOX_FLAG $CHROME_COMMON_FLAGS \
    "http://127.0.0.1:$DAEMON_PORT/newtab"
else
  # headless 專屬差異：--headless=new、--disable-extensions、about:blank
  # shellcheck disable=SC2086
  spawn_detached "$LOGS_DIR/chrome.log" "$BROWSER_BIN" --headless=new $SANDBOX_FLAG $CHROME_COMMON_FLAGS \
    --disable-extensions about:blank
fi
```

**行為保持驗證**：在新舊腳本各加臨時一行 `printf '%s\n' "$BROWSER_BIN" $SANDBOX_FLAG <旗標> <URL>`（驗畢移除），同環境執行 diff 為空；注意 `--user-data-dir=$PROFILE_DIR` 原本有引號、單源後靠「路徑不含空白」假設——若 `HOME` 含空白會改變行為，驗證時**必須**以含空白的 `$HOME` 情境額外測一輪，不符則該旗標保留獨立引號變數（`--user-data-dir="$PROFILE_DIR"` 不併入通用字串）。
**輸出凍結**：`TP_READY (...)`／`TP_INDICATORS: ...` 一字不改。

---

## §4 停止邏輯共用（Batch 3）

### 重構前：`scripts/tp-stop.sh`（逐字節錄）與 `scripts/tp-start.sh` 內嵌同型段落

```sh
# tp-stop.sh
curl -fsS --max-time 3 "http://127.0.0.1:9772/flush-and-close" >/dev/null 2>&1 || true
curl -fsS --max-time 3 "http://127.0.0.1:9774/flush-and-close" >/dev/null 2>&1 || true
sleep 1.0
pkill -f "ego-browserd.js" 2>/dev/null || true
pkill -f "tp-browserd.js" 2>/dev/null || true
pkill -f "$PROFILE_DIR" 2>/dev/null || true
echo "TP_STOPPED"
```

`tp-start.sh` 的 restart 路徑另有：`pkill` 三行 + `sleep 0.6` + `rm -f Singleton{Lock,Cookie,Socket}` + 呼叫 `profile-init.js`。

### 重構後：`scripts/lib/tp-common.sh`（新增）

```sh
# scripts/lib/tp-common.sh — tp-start / tp-stop 共用常數與程序管理（POSIX sh）
TP_DAEMON_PORT_DEFAULT=9772
TP_CHROME_PORT_DEFAULT=9773
TP_DAEMON_PORT_ALT=9774
TP_CHROME_PORT_ALT=9775
TP_DATA_DIR="${EGO_LINUX_DATA_DIR:-$HOME/.local/share/ego-linux}"

# 停止 daemon 與 agent Chrome。DAEMON_PORT 允許傳入（含 alt port）。
tp_flush_and_kill() {
  DAEMON_PORT="${1:-$TP_DAEMON_PORT_DEFAULT}"
  curl -fsS --max-time 3 "http://127.0.0.1:$DAEMON_PORT/flush-and-close" >/dev/null 2>&1 || true
  sleep 1.0
  pkill -f "ego-browserd.js" 2>/dev/null || true
  pkill -f "tp-browserd.js" 2>/dev/null || true
  pkill -f "$TP_DATA_DIR/profile-agent" 2>/dev/null || true
}
```

`tp-stop.sh` 與 `tp-start.sh` 改為 `. "$(dirname "$0")/lib/tp-common.sh"` 後呼叫；`TP_STOPPED`／`TP_READY` 輸出留在各自腳本（前綴不統一，見決策點）。
**已知殘留耦合（如實記錄，不在本批解）**：`pkill -f` 仍比對檔名（C4）；改用 PID 檔屬行為增強，列決策點。

---

## §5 版本號單源（Batch 5）

### 重構前

- `package.json`：`"version": "0.3.0"`
- CLI `version` 指令：輸出 `0.3.1`（字串來源在 `bin/*.js`，**[PENDING]** 未見內容；`docs/fmb-api/README.md` 已記載此漂移）

### 重構後（示意，實作時依 `bin/*.js` 實際結構調整）

```js
// 讀取單一真相來源，杜絕 0.3.0 / 0.3.1 漂移
import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const VERSION = pkg.version; // CLI version / doctor 等輸出一律引用
```

**行為改變（刻意且需核可）**：`version` 輸出從 `0.3.1` 變為 `0.3.0`——這是**修正**漂移而非重構，屬 D3 決策點；若 BOB 希望對外版本是 `0.3.1`，則改為把 `package.json` 昇到 `0.3.1`，二擇一，不允許兩處各自維護。
**驗證**：`node -e "console.log(require('./package.json').version)"`（ CommonJS 讀法僅驗證用；專案為 ESM）與 CLI 輸出一致；`docs/fmb-api/README.md` 的版本描述同步。

---

## §6 log 前綴常數化（Batch 1）

### 重構前（逐字）

```js
// daemon/store.js
} catch (e) { console.error('[ego-browserd] store load failed, starting fresh:', e.message); }
```

```js
// daemon/cdp.js（handler 例外隔離處）
catch (e) { console.error('[ego-browserd] handler error:', e); }
```

### 重構後

```js
// daemon/store.js 頂部
// log 前綴集中為常數；「值」維持現狀（不改任何日誌輸出），
// 未來統一命名時只改這一處（另案，見 docs/fmb-observability/）。
const LOG_TAG = '[ego-browserd]';
```

**行為保持驗證**：測試中攔截 `console.error`，斷言訊息字串與重構前逐字相同。
**刻意不做**：直接改成 `[tp-browserd]`——那是可觀測行為變更（C7／D8），與 observability 計畫一併決策。

---

## §7 `spawn_detached` 抽成可測工具（Batch 3）

### 重構前（`tp-start.sh` 內嵌，逐字節錄）

```sh
spawn_detached() {
  LOG_FILE="$1"
  shift
  node -e '
    import("node:child_process").then(({ spawn }) => {
      import("node:fs").then(({ openSync }) => {
        const out = openSync(process.argv[1], "a");
        const child = spawn(process.argv[2], process.argv.slice(3), {
          detached: true,
          stdio: ["ignore", out, out]
        });
        child.unref();
      });
    });
  ' "$LOG_FILE" "$@"
}
```

問題：以字串內嵌 Node 程式、`process.argv` 索引傳參、無法 `node --check`、無法單元測試、錯誤路徑（`openSync` 失敗）靜默。

### 重構後（`scripts/lib/spawn-detached.js`，新增）

```js
#!/usr/bin/env node
// scripts/lib/spawn-detached.js — 以 detached 模式背景執行指令，stdout/stderr 附加到 log 檔。
// 用法：node spawn-detached.js --log <file> -- <cmd> [args...]
import { openSync } from 'node:fs';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const logIdx = args.indexOf('--log');
const cmdIdx = args.indexOf('--');
if (logIdx === -1 || cmdIdx === -1 || cmdIdx < logIdx + 2) {
  console.error('usage: spawn-detached.js --log <file> -- <cmd> [args...]');
  process.exit(2);
}
const logFile = args[logIdx + 1];
const cmd = args.slice(cmdIdx + 1);
if (!cmd.length) { console.error('spawn-detached: empty command'); process.exit(2); }

let out;
try { out = openSync(logFile, 'a'); } catch (e) {
  console.error(`spawn-detached: cannot open log ${logFile}: ${e.message}`);
  process.exit(2);
}
const child = spawn(cmd[0], cmd.slice(1), { detached: true, stdio: ['ignore', out, out] });
child.unref();
```

shell 端：`spawn_detached() { node "$SCRIPT_LIB_DIR/spawn-detached.js" --log "$1" -- "${@:2}"; }`（或 POSIX 下 `shift` 後 `"$@"`）。
**行為保持驗證**：新舊版各啟動一個短命的 `node -e "setTimeout(()=>{},200)"` 寫 log 到 `mktemp -d`，比較 log 內容與 parent 退出後 child 存活時序；`node --check` 可跑；錯誤路徑（log 檔不可開）現在有明確退出碼 2——**這是可觀測行為的小幅改善（原為靜默無限等待風險），在 PR 中明列**。
**注意**：`scripts/lib/` 需同步進安裝器複製清單（見 02-batches.md Batch 3）。
