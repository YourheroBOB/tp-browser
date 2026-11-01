# tp-browser 審查問題清單（fmb-review）

> 靜態審查結果。行號以本次提供內容計。類別覆蓋：正確性、併發、錯誤處理、可讀性、可測試性、相依風險（另列資安／文件一致性）。  
> 詳細逐檔涵蓋範圍見 [`02-coverage.md`](./02-coverage.md)。

## A. 問題總表

| ID | 檔案:行號 | 嚴重度 | 類別 | 問題 | 建議 |
|---|---|---|---|---|---|
| F-01 | `daemon/store.js:12-16` | 高 | 正確性／錯誤處理 | `load()` 直接把 JSON 指派給 `this.data`，不驗證形狀；載入 `{}`／`null`／陣列會讓 `list()/create()` 等拋 `TypeError` | 與預設值 merge 並逐欄型別檢查，非法即回落空 ledger 並記log |
| F-02 | `daemon/store.js:73` | 中 | 正確性 | `deleteSpace(id)` 只刪 `spaces[id]`，未刪 `labelSeq[id]`；ledger 回收後 `labelSeq` 永久增長 | `deleteSpace` 一併 `delete this.data.labelSeq[id]` |
| F-03 | `daemon/store.js:28` | 中 | 併發／可測試性 | `list()` 回傳內部物件參照，呼叫端可直接改 ledger 而不經 `persist()` | 回傳深拷貝；或至少在文件標明「唯讀契約」 |
| F-04 | `daemon/store.js:17-27` | 高 | 錯誤處理／併發 | `persist()` 在 `renameSync` 失敗時直接 `writeFileSync(this.file, body)`，屬非原子寫入，崩潰可能留下半份 JSON；fallback 拋錯會讓已改的記憶體狀態與磁碟不一致 | 移除直接寫 final path 的 fallback；跨裝置時改用 `copyFileSync` 再 `unlinkSync` tmp，並把失敗向上拋 |
| F-05 | `daemon/store.js`（類別整體） | 高 | 併發 | 無跨程序鎖；若 9772／9774 兩個 daemon 共用同一 store 檔，會 last-writer-wins 丟失更新 | 單一寫入者契約，或 `${file}.lock` 目錄鎖＋pid 僵鎖復原 |
| F-06 | `daemon/store.js:55-66` | 低 | 可讀性／正確性 | `bindPage()` 與 `addPage()` 主體完全相同；`bindPage` 會靜默覆寫既有分頁 | 整併為一方法並以參數表達語意（bind 既存失敗／add 禁止重複） |
| F-07 | `daemon/store.js:30-54` | 低 | 可讀性／正確性 | `create()` 不驗證 `name/profileId`；`setPage()` 對不存在 label 靜默 no-op，錯誤被吞 | 明確拋錯或回傳布林；輸入做基本型別檢查 |
| F-08 | `daemon/store.js`（schema） | 中 | 正確性 | 無 `lastUsedAt`、無 `clearActiveTarget()`；reaper 只能用 `createdAt` 判閒置，且無法清 `activeTargetId` | 加 `lastUsedAt`（寫入點更新）與 `clearActiveTarget()`，reaper 改以 `lastUsedAt ?? createdAt` |
| F-09 | `daemon/cdp.js:31-36`、`77-85` | 中 | 錯誤處理 | `ws.onclose` 雖 reject pending，但**未 `clearTimeout(p.timer)`**，timer 仍會續跑拖住事件循環；`once()` 未訂閱 close，斷線時只能等逾時 | close 時一併清 timer；`once()` 以 `done` 旗標＋`onClose` 立即 reject |
| F-10 | `daemon/cdp.js:59-68` | 低 | 錯誤處理 | `send()` 先檢查 `readyState !== 1` 再於 executor 內 `ws.send`；兩者之間連線可能已關閉，`ws.send` 拋錯路徑未包裝 | 在 executor 內 `try { ws.send(...) } catch (e) { reject(e) }`，並於送出新 id 前再檢查一次 |
| F-11 | `daemon/cdp.js:25-39` | 低 | 錯誤處理 | 若 `onclose` 在 `onopen`/`onerror` 之前觸發，`connect()` 可能直到 timeout 才 settle | 以 `settled` 旗標保證 resolve/reject 只發生一次；close 亦呼叫 reject |
| F-13 | `daemon/keys.js:2` | 中 | 正確性 | `ControlOrMeta` 恆對應 `Control (2)`；macOS 上使用者預期是 `Meta/Command` | 依 `process.platform === 'darwin'` 解析為 `Meta`，其餘為 `Control` |
| F-14 | `daemon/keys.js:41-49` | 低 | 正確性 | 單字元路徑：`'A'` 未帶 Shift、標點（如 `:`）`code` 為 `null`，CDP 行為依版本而異 | 大寫字母於 dispatch 端補 `Shift`；標點補 `code`（`Colon`/`Semicolon` 等）或明確文件化限制 |
| F-15 | `daemon/keys.js:55-62` | 低 | 可讀性 | `parseChord()` 允許 main 為修飾鍵（如僅 `"Control"`），未正規化大小寫 | 正規化修飾鍵；main 為修飾鍵時明確定義為單擊修飾鍵 |
| F-16 | `fmb_feature2/cli.js:25-32` | 中 | 錯誤處理／可測試性 | `buildPlan()` 未驗證 `spaces`/`liveTargetIds` 為陣列；`now` 未檢查 `Number.isFinite`，`NaN` 會污染閒置判定 | 補型別與有限數檢查，錯誤訊息可被測試斷言 |
| F-17 | `fmb_feature2/cli.js:35-45` | 低 | 錯誤處理 | 以 `readFileSync(0)` 讀 stdin；TTY 無管線時行為依平台而異 | 文件化「僅供管線輸入」；或偵測 `process.stdin.isTTY` 提早回 usage |
| F-18 | `install.sh:25` | 高 | 相依風險 | 遠端一鍵安裝 `git clone --depth 1` **預設分支**，來源浮動且無 checksum | 固定 `--branch "${TP_BROWSER_REF:-vX.Y.Z}"` 並校驗 tarball/`install.sh` SHA256 |
| F-19 | `install.sh:33-45` | 中 | 相依風險／錯誤處理 | 先 `rm -rf "$APP_DIR/..."` 再逐個 `cp`；`cp` 中途失敗會留下不完整 runtime（`set -e` 直接退出） | 安裝到 `$APP_DIR.next.$$` 完成後原子替換，失敗保留舊版 |
| F-20 | `install.sh:40` | 中 | 正確性 | 只 `cp "$SRC/tests/"*.mjs`，未複製 `tests/smoke.ego.js` 等非 `.mjs`；README 的 `tp-browser nodejs < tests/smoke.ego.js` 在安裝後環境會失敗 | 改為複製整個 `tests/`，或在文件標明冒煙腳本僅存在 repo |
| F-21 | `install.sh:88-98` | 低 | 相依風險／正確性 | 自動把 `SKILL.md` 覆寫進多個 agent skill 根目錄的 `tp-browser`／`ego-browser`，可能覆蓋使用者既有檔 | 覆寫前備份或僅在不存在時安裝；提供 opt-out |
| F-22 | `install.sh`（整體） | 低 | 相依風險 | 未檢查 Node 版本即建立 `--experimental-websocket` wrapper；與 `engines >=22` 契約不一致 | 安裝前以 `node -e` 檢查 major ≥ 22（或明確宣告 Node 20 相容路徑） |
| F-23 | `scripts/tp-start.sh:118-122` | 中 | 資安／正確性 | 以 `id -u = 0` 判斷並加 `--no-sandbox`；root 跑 Chromium 擴大被攻破後的影響 | 預設拒絕 root；以 `TP_ALLOW_ROOT=1` 明確覆寫（需 BOB 決策） |
| F-24 | `scripts/tp-start.sh:163-165` | 中 | 資安／錯誤處理 | `chmod 600 token/daemon.json` 只在等到 `chrome:true` 後執行；daemon 剛建立 token 到 chmod 之間有寬鬆權限時間窗 | daemon 端建立 token 時即以 `0o600` 寫入；啟動器在 spawn daemon 後立即輪詢 chmod |
| F-25 | `scripts/tp-start.sh:129-176` | 中 | 錯誤處理／可測試性 | `spawn_detached()` 以 `node -e` 非同步 spawn 且完全不處理失敗；等待逾時只印 `TP_NOT_READY` 並退出，已啟動的 daemon/Chrome 成孤兒，無 supervisor | spawn 結果回報為非零退出；逾時路徑清理或至少輸出 PID 與 log 路徑；常駐依賴 systemd 時應在 unit 層 `Restart=` |
| F-26 | `scripts/tp-start.sh`（整體） | 中 | 併發 | 無重入保護；兩個 `tp-start` 並發會互相 `pkill`／重 spawn | 以 `flock` 對 `$DATA_DIR/start.lock` 取鎖（不可用時降級為提示） |
| F-27 | `scripts/tp-start.sh:66-75` | 低 | 正確性 | headed 保留判斷用 `ps ax -o command=`，macOS/部分環境不相容；`grep -qv -- "--headless"` 在空輸入時語意易誤讀 | 以 `/health` 擴充回報目前模式，或改用可移植的行程查詢 |
| F-28 | `install.ps1:9-45`、`47-95` | 中 | 相依風險／正確性 | 同時安裝到 `$DataDir` 與未使用的 `$InstallDir`；非原子 `Remove-Item`＋`Copy-Item`；未建立 `tp-browserd`/`ego-browserd` wrapper（README 有宣稱） | 移除冗餘 `$InstallDir`；temp＋原子替換；補 daemon `.cmd` wrapper |
| F-29 | `package.json:3`、`README.md`（前置需求） | 中 | 相依風險／可測試性 | `package.json` `0.3.0` vs CLI `version` `0.3.1`；`engines >=22` 與 README「Node 20 + 旗標」路徑不一致 | 單一版本來源；收斂 Node 支援契約（建議最低 22） |
| F-30 | `README.md`（跨機 Cookie 段落） | 高 | 正確性／文件 | README 引用 `tools/cookies-export.ego.js`／`tools/cookies-import.ego.js`，但 repo `tools/` 僅有 `profile-init.js` | 補工具（預設 `0600`＋跨機加密）或立即修正 README，避免對外承諾跳票 |
| F-31 | 未提供內容模組（見 `02-coverage.md`） | 高 | 可測試性／相依風險 | README／docs 宣稱的 Host/Origin 驗證、`timingSafeEqual`、`safePath`、`/^ego-\d+$/` 等資安控制，其程式未在本次內容中，無法靜態確認 | 補合成測試（畸形 JSON、超大 body、斷線、逾時、symlink、併發）後再宣稱通過 |

## B. 建議修法程式片段

> 以下片段為「最小可行修法」示例，可直接作為 PR 雛型；實際整合前請補對應測試。

### B.1 `Store` 形狀驗證與清理（F-01、F-02、F-03、F-06、F-07）

```js
// daemon/store.js（片段）
static defaults() { return { nextSpaceId: 1, labelSeq: {}, spaces: {} }; }

load() {
  this.data = Store.defaults();
  try {
    if (!existsSync(this.file)) return;
    const raw = JSON.parse(readFileSync(this.file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    if (Number.isInteger(raw.nextSpaceId) && raw.nextSpaceId > 0) this.data.nextSpaceId = raw.nextSpaceId;
    if (raw.labelSeq && typeof raw.labelSeq === 'object' && !Array.isArray(raw.labelSeq)) this.data.labelSeq = raw.labelSeq;
    if (raw.spaces && typeof raw.spaces === 'object' && !Array.isArray(raw.spaces)) this.data.spaces = raw.spaces;
  } catch (e) {
    console.error('[ego-browserd] store load failed, starting fresh:', e.message);
  }
}

list() { return Object.values(this.data.spaces).map((s) => structuredClone(s)); }

deleteSpace(id) {
  delete this.data.spaces[id];
  delete this.data.labelSeq[id]; // F-02：避免 labelSeq 只增不減
  this.persist();
}
```

### B.2 `persist()` 原子性與跨程序鎖（F-04、F-05）

```js
// daemon/store.js（片段）：不做「直接寫 final path」的非原子 fallback
persist() {
  mkdirSync(dirname(this.file), { recursive: true });
  const tmp = `${this.file}.${process.pid}.tmp`;
  const body = JSON.stringify(this.data, null, 1);
  try {
    writeFileSync(tmp, body, { mode: 0o600 });
    try {
      renameSync(tmp, this.file);
    } catch (e) {
      if (e && (e.code === 'EXDEV' || e.code === 'EPERM')) {
        copyFileSync(tmp, this.file); // 仍非原子，但避免半份寫入 final path
        unlinkSync(tmp);
      } else {
        throw e;
      }
    }
  } catch (e) {
    throw new Error(`store persist failed for ${this.file}: ${e.message}`);
  }
}

// 跨程序鎖（概念）：成功表示取得鎖；僵鎖以 pid 復原
// function acquireLedgerLock(file) {
//   const dir = `${file}.lock`;
//   try { mkdirSync(dir); writeFileSync(`${dir}/pid`, String(process.pid)); return true; }
//   catch { /* 讀 pid，若程序已不存在則 rmSync(dir, {recursive:true,force:true}) 後重試一次 */ return false; }
// }
```

### B.3 `Cdp` 生命週期（F-09、F-10、F-11）

```js
// daemon/cdp.js（片段）
ws.onclose = () => {
  if (this.closed) return;
  this.closed = true;
  for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('CDP connection closed')); }
  this.pending.clear();
  for (const fn of this.closeHandlers ?? []) fn();
};

send(method, params = {}, { sessionId, timeout = 30000 } = {}) {
  if (this.closed || !this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('CDP connection closed'));
  const id = ++this.id;
  const msg = { id, method, params };
  if (sessionId) msg.sessionId = sessionId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out after ${timeout}ms`)); }, timeout);
    this.pending.set(id, { resolve, reject, timer, method });
    try {
      if (this.closed || !this.ws || this.ws.readyState !== 1) throw new Error('CDP connection closed');
      this.ws.send(JSON.stringify(msg));
    } catch (e) {
      this.pending.delete(id);
      clearTimeout(timer);
      reject(e);
    }
  });
}

export const once = (cdp, method, { sessionId, timeout = 30000 } = {}) =>
  new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn) => { if (done) return; done = true; clearTimeout(timer); off(); offClose(); fn(); };
    const timer = setTimeout(() => finish(() => reject(new Error(`${method} event timed out after ${timeout}ms`))), timeout);
    const off = cdp.onEvent((ev) => {
      if (ev.method !== method) return;
      if (sessionId && ev.sessionId !== sessionId) return;
      finish(() => resolve(ev.params));
    });
    const offClose = cdp.onClose(() => finish(() => reject(new Error('CDP connection closed'))));
  });
```

### B.4 `keys` 跨平台語意（F-13、F-14）

```js
// daemon/keys.js（片段）
const IS_MAC = process.platform === 'darwin';
export function modifierBit(name) {
  if (name === 'ControlOrMeta') return IS_MAC ? MODIFIERS.Meta : MODIFIERS.Control;
  return MODIFIERS[name] ?? 0;
}

// dispatch 端遇到 keyDescriptor 回傳 /[A-Z]/ 單字元時，補上 Shift：
// const d = keyDescriptor('A');
// const mods = /[A-Z]/.test(d.key) ? [modifierBit('Shift')] : [];
// await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: mods.reduce((a,b)=>a+b,0), ...d });
```

### B.5 CLI 輸入驗證（F-16）

```js
// fmb_feature2/cli.js（片段）
const { spaces, liveTargetIds, now, policy, protect } = payload;
if (!Array.isArray(spaces)) throw new Error('spaces must be an array');
if (!Array.isArray(liveTargetIds)) throw new Error('liveTargetIds must be an array');
if (now !== undefined && !Number.isFinite(now)) throw new Error('now must be a finite number');
return planReap({
  spaces,
  liveTargetIds,
  now: now === undefined ? Date.now() : now,
  policy: policy ?? {},
  protect: protect ?? [],
});
```

### B.6 安裝器與啟動器（F-18、F-19、F-20、F-22、F-23、F-24、F-26）

```sh
# install.sh（片段）：固定版本＋checksum、原子安裝、完整 tests、Node 閘
REF="${TP_BROWSER_REF:-v0.3.0}"
git clone --depth 1 --branch "$REF" https://github.com/YourheroBOB/tp-browser.git "$TMP_CLONE"
# 建議再加：echo "<expected-sha256>  $TMP_CLONE/install.sh" | sha256sum -c -

NEW="$APP_DIR.next.$$"
rm -rf "$NEW"; mkdir -p "$NEW"
cp -R "$SRC/bin" "$SRC/daemon" "$SRC/lib" "$SRC/scripts" "$SRC/tools" "$SRC/tests" "$SRC/skills" "$NEW"/
rm -rf "$APP_DIR"; mv "$NEW" "$APP_DIR"   # 原子替換，失敗保留舊版

node -e 'const [m]=process.versions.node.split(".").map(Number); if(m<22){console.error("ERROR: Node.js >= 22 required");process.exit(1)}'
```

```sh
# scripts/tp-start.sh（片段）：token 即時收權、root 保護、重入鎖
if [ "$(id -u 2>/dev/null || echo 1000)" = "0" ] && [ "${TP_ALLOW_ROOT:-0}" != "1" ]; then
  echo "ERROR: refuse to launch Chrome as root; set TP_ALLOW_ROOT=1 to override" >&2
  exit 1
fi

if command -v flock >/dev/null 2>&1; then
  exec 9>"$DATA_DIR/start.lock"
  flock -n 9 || { echo "TP_BUSY"; exit 0; }
fi

spawn_detached "$LOGS_DIR/daemon.log" node --experimental-websocket "$DAEMON_JS" || { echo "TP_DAEMON_SPAWN_FAILED" >&2; exit 1; }
i=0; while [ $i -lt 20 ]; do
  [ -f "$DATA_DIR/token" ] && { chmod 600 "$DATA_DIR/token" "$DATA_DIR/daemon.json" 2>/dev/null || true; break; }
  sleep 0.1; i=$((i + 1))
done
```

### B.7 Windows 安裝器補 daemon wrapper 與原子化（F-28）

```powershell
# install.ps1（片段）：補 tp-browserd / ego-browserd wrapper
$DaemonCmd = @'
@echo off
node --experimental-websocket "%USERPROFILE%\.local\share\ego-linux\daemon\ego-browserd.js" %*
'@
foreach ($dir in @($LocalBin, $HomeBin)) {
  Set-Content -Path (Join-Path $dir "ego-browserd.cmd") -Value $DaemonCmd -Encoding Ascii
  Set-Content -Path (Join-Path $dir "tp-browserd.cmd")  -Value $DaemonCmd -Encoding Ascii
}
# 建議同步：改為「複製到暫存目錄→驗證→原子替換」，並移除未使用的 $InstallDir 冗餘安裝。
```
