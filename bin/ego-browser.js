#!/usr/bin/env node
// tp-browser / ego-browser — CLI for TooPower Browser (Windows / Linux / macOS).
// `tp-browser nodejs` (or `ego-browser nodejs`) runs a Node.js script with the taskSpace()/page() SDK.
// Script code arrives via -e or stdin (heredoc) — never from argv file paths —
// and this CLI never spawns processes: it talks HTTP+SSE to tp-browserd / ego-browserd.
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const DATA_DIR = join(homedir(), '.local', 'share', 'ego-linux');
const TOKEN_FILE = join(DATA_DIR, 'token');
const DAEMON_JSON = join(DATA_DIR, 'daemon.json');

function osBuildTag() {
  if (process.platform === 'win32') return 'tp-win / ego-win';
  if (process.platform === 'darwin') return 'tp-mac / ego-mac';
  return 'tp-linux / ego-linux';
}

function resolveScript(unixName, winName) {
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const candidates = process.platform === 'win32'
    ? [join(DATA_DIR, 'scripts', winName), join(DATA_DIR, 'app', 'scripts', winName), join(repoRoot, 'scripts', winName)]
    : [join(DATA_DIR, 'app', 'scripts', unixName), join(DATA_DIR, 'scripts', unixName), join(repoRoot, 'scripts', unixName)];
  return candidates.find((p) => existsSync(p)) || candidates[0];
}

// 啟動器結果 → CLI exit code：只有「真的正常結束」才採用它的退出碼。
// spawnSync 在被 signal 終止時 status === null 且 signal 有值；spawn 失敗（例如 ENOENT）
// 時 status 也是 null 但 error 有值。舊寫法 `r.status ?? 0` 會把這兩種失敗都當成成功，
// 讓 `ego-browser stop` / `start` 回 0，自動化流程因此誤判「已停止／已啟動」。
function launcherExitCode(r, label) {
  if (r.error) {
    console.error(`tp-browser: failed to run launcher ${label}: ${r.error.message}`);
    return 1;
  }
  if (r.signal) {
    console.error(`tp-browser: launcher ${label} was terminated by signal ${r.signal}`);
    return 1;
  }
  if (r.status === null || r.status === undefined) {
    console.error(`tp-browser: launcher ${label} ended without an exit status`);
    return 1;
  }
  return r.status;
}

function runLauncher(mode = 'start', extraArgs = [], quietStdout = false) {
  const stdio = quietStdout ? ['ignore', process.stderr, process.stderr] : 'inherit';
  if (process.platform === 'win32') {
    const script = resolveScript('tp-start.sh', mode === 'stop' ? 'ego-stop.ps1' : 'ego-start.ps1');
    const psArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script];
    if (mode === 'headed') psArgs.push('-Headed');
    if (mode === 'restart') psArgs.push('-Restart');
    for (const a of extraArgs) {
      if (a === '--headed' || a === '-Headed' || a === 'headed') psArgs.push('-Headed');
      else if (a === '--restart' || a === '-Restart' || a === 'restart') psArgs.push('-Restart');
      else if (a === '--alt-port' || a === '-AltPort') psArgs.push('-AltPort');
      else if (a === '--edge' || a === '-Edge' || a === 'edge') psArgs.push('-Edge');
      else if (a === '--chrome' || a === '-Chrome' || a === 'chrome') psArgs.push('-Chrome');
    }
    const r = spawnSync('powershell.exe', psArgs, { stdio });
    return launcherExitCode(r, script);
  } else {
    const script = resolveScript(mode === 'stop' ? 'tp-stop.sh' : 'tp-start.sh', 'ego-start.ps1');
    const shArgs = [script];
    if (mode === 'headed') shArgs.push('--headed');
    if (mode === 'restart') shArgs.push('--restart');
    shArgs.push(...extraArgs);
    const r = spawnSync('/bin/sh', shArgs, { stdio });
    return launcherExitCode(r, script);
  }
}

function readToken() {
  if (!existsSync(TOKEN_FILE)) throw new Error(`no token at ${TOKEN_FILE}; is tp-browserd running?`);
  return readFileSync(TOKEN_FILE, 'utf8').trim();
}
// daemon.json 由啟動器寫下「這台機器實際使用的埠號」。合法埠的唯一定義：
// 1–65535 的整數。除此之外（字串、null、0、負數、小數、超界）一律視為沒寫。
function isPortNumber(value) {
  return Number.isInteger(value) && value > 0 && value <= 65535;
}
function readPort() {
  // 允許以 TP_DAEMON_PORT 明確指定 daemon 埠：未設定時行為與以往完全相同（9774 或 9772）。
  // 這讓測試能把假 daemon 綁在 OS 指派的臨時埠上，不必和真的 daemon 搶 9772／9774。
  const envPort = Number(process.env.TP_DAEMON_PORT);
  if (isPortNumber(envPort)) return envPort;
  if (existsSync(DAEMON_JSON)) {
    // 舊寫法只認 9774，其餘一律回落 9772：一旦埠號來自 --alt-port、WSL2 雙軌或部署自訂值
    // （例如 Windows 節點的 18802），status 就會對著錯的埠喊 not reachable 並以 exit 2 結束。
    // 讀到合法的整數埠就直接採用，對既有 9772／9774 兩種情況結果完全相同。
    try {
      const p = JSON.parse(readFileSync(DAEMON_JSON, 'utf8')).port;
      if (isPortNumber(p)) return p;
    } catch {}
  }
  return 9772;
}
function readChromePort() {
  if (existsSync(DAEMON_JSON)) {
    // 同 readPort：只認 9775 會讓 doctor 在換埠後去探 9773（錯的埠）並印出誤導的修復指令。
    // 讀到合法的整數埠就直接採用，對既有 9773／9775 兩種情況結果完全相同。
    try {
      const p = JSON.parse(readFileSync(DAEMON_JSON, 'utf8')).chromePort;
      if (isPortNumber(p)) return p;
    } catch {}
  }
  return 9773;
}
function daemonBase(port) {
  // 舊寫法只認 9774，其餘一律導回 9772；一旦埠號來自 TP_DAEMON_PORT 就會打錯位址。
  // 直接採用傳入的埠，對既有 9772／9774 兩種情況結果完全相同。
  return `http://127.0.0.1:${port}`;
}
function chromeVersionUrl(chromePort) {
  // 舊寫法把 9775 以外的埠一律導回 9773，doctor 因此永遠探錯埠。
  // 直接使用傳入的埠，對既有 9773／9775 兩種情況結果完全相同。
  return `http://127.0.0.1:${chromePort}/json/version`;
}

async function health(port) {
  try {
    const r = await fetch(`${daemonBase(port)}/health`, { signal: AbortSignal.timeout(2500) });
    return await r.json();
  } catch { return null; }
}

function explicitDaemonPort() {
  const v = Number(process.env.TP_DAEMON_PORT);
  return Number.isInteger(v) && v > 0 && v <= 65535;
}
async function ensureRunning() {
  let port = readPort();
  let h = await health(port);
  if (h && h.ok && h.chrome) return { port, h };
  // TP_DAEMON_PORT 明確指定時不自動跑啟動器：tp-start.sh 只會在預設的 9772/9773（或 --alt-port 的
  // 9774/9775）起 daemon 與一個 detached 的 Chrome，根本不會用到這個埠。舊寫法在健康檢查一失敗
  // （假 daemon 被負載拖過 2.5 秒、或測試刻意模擬 daemon 不在）就照跑，於是每次都在隔離 HOME 下
  // 多開一個佔 9773 的無頭 Chrome，測試結束刪掉 HOME 後成為孤兒，累積上百個把整台機器拖垮。
  if (explicitDaemonPort()) return { port, h };
  // 啟動器的退出碼一定要往上傳。舊寫法把 runLauncher() 的回傳值直接丟掉，於是
  // 「瀏覽器根本沒起來」（未安裝 Chrome/Chromium、profile 損壞、埠被占用、腳本不存在…）
  // 在下游被一律改寫成「tp-browserd is not reachable … 請先執行 tp-start」＋ exit 2：
  // 使用者被叫去重跑一個剛剛才失敗的指令，自動化也拿不到真正的失敗碼。
  const launcherExit = runLauncher('start', [], true);
  port = readPort();
  h = await health(port);
  return { port, h, launcherExit };
}

async function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0] || 'help';

  if (sub === 'start' || sub === '--start') { process.exitCode = runLauncher('start', argv.slice(1)); return; }
  if (sub === 'headed' || sub === '--headed' || sub === '-Headed') { process.exitCode = runLauncher('headed', argv.slice(1)); return; }
  if (sub === 'restart' || sub === '--restart') { process.exitCode = runLauncher('restart', argv.slice(1)); return; }
  if (sub === 'stop' || sub === '--stop') { process.exitCode = runLauncher('stop', argv.slice(1)); return; }
  if (sub === 'nodejs') return runNodeJs(argv.slice(1));
  if (sub === 'status' || sub === 'spaces') {
    const port = readPort();
    const h = await health(port);
    if (!h) { console.error(`tp-browserd is not reachable on 127.0.0.1:${port}.`); console.error(`Start it: tp-start  (or: tp-headed)`); process.exitCode = 2; return; }
    console.log(JSON.stringify(h, null, 1));
    if (sub === 'spaces') console.log(JSON.stringify(await rpcCmd(port, 'space.list'), null, 1));
    return;
  }
  if (sub === 'doctor') return doctor();
  if (sub === 'skill') {
    const p1 = join(dirname(dirname(fileURLToPath(import.meta.url))), 'skills', 'tp-browser', 'SKILL.md');
    const p2 = join(DATA_DIR, 'app', 'skills', 'tp-browser', 'SKILL.md');
    const p3 = join(DATA_DIR, 'skills', 'tp-browser', 'SKILL.md');
    const found = [p1, p2, p3].find((p) => existsSync(p));
    if (found) console.log(readFileSync(found, 'utf8'));
    else console.log('See https://github.com/YourheroBOB/tp-browser/blob/main/skills/tp-browser/SKILL.md');
    return;
  }
  if (sub === 'version' || sub === '--version' || sub === '-V') { console.log(`TooPower Browser (tp-browser) 0.3.1 [${osBuildTag()} — 強到沒朋友]`); return; }
  if (sub === 'help' || sub === '--help' || sub === '-h') { console.log(usageText()); return; }
  // 未知子命令（打錯字、拼錯的旗標，例如 `tp-browser statsu`）：舊寫法與 `help` 共用同一個
  // console.log，把 usage 印到 stdout 後以 exit 0 結束。自動化（`tp-browser statsu && next`、
  // CI、Agent shell）因此把「這個指令根本不存在」當成執行成功，後續才在拿不到輸出時另外除錯。
  // 這裡把「使用者明確要求說明」與「指令無法辨識」分成兩條路：
  //   help/--help/-h/無參數 → usage 到 stdout、exit 0（維持原行為）
  //   其他未知值            → usage 到 stderr、exit 2
  // 訊息只含使用者自己輸入的子命令字串，不帶環境變數、路徑或其他內容。
  console.error(usageText());
  console.error(`tp-browser: unknown command "${sub}" (see: tp-browser help)`);
  process.exitCode = 2;
}

function usageText() {
  return `TooPower Browser / tp-browser (${osBuildTag()} — 強到沒朋友)
usage:
  tp-browser nodejs -e 'code'       run an agent script (-e) or pipe one via stdin/heredoc (auto-starts if needed)
  tp-browser start                  start headless background browser (alias: tp-start / ego-start)
  tp-browser headed                 open visible GUI browser window for human login/Co-Riding (alias: tp-headed / ego-headed)
  tp-browser stop                   stop browser & daemon (alias: tp-stop / ego-stop)
  tp-browser status                 daemon + chrome health
  tp-browser spaces                 list task spaces
  tp-browser doctor                 diagnose and print fix commands
  tp-browser skill                  print the AI Agent SKILL.md guide
  tp-browser version                print version and platform build`;
}

function daemonPath() { return join(dirname(dirname(fileURLToPath(import.meta.url))), 'daemon', 'ego-browserd.js'); }

async function rpcCmd(port, method, params) {
  const tok = readToken();
  const res = await fetch(`${daemonBase(port)}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-tp-token': tok, 'x-ego-token': tok },
    body: JSON.stringify({ id: 1, method, params: params || {} }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(`${j.error?.name}: ${j.error?.message}`);
  return j.result;
}

async function doctor() {
  const port = readPort();
  const chromePort = readChromePort();
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  console.log(`== TooPower Browser (${osBuildTag()}) doctor ==`);
  const h = await health(port);
  console.log(`daemon  127.0.0.1:${port}: ${h ? `ok (chrome attached: ${h.chrome})` : 'NOT RUNNING'}`);
  if (!h) {
    console.log(`  fix: tp-start   # or: node "${daemonPath()}"`);
  }
  let chromeOk = false;
  try { const r = await fetch(chromeVersionUrl(chromePort), { signal: AbortSignal.timeout(2500) }); const v = await r.json(); chromeOk = true; console.log(`chrome  127.0.0.1:${chromePort}: ok (${v.Browser})`); } catch { console.log(`chrome  127.0.0.1:${chromePort}: NOT REACHABLE`); }
  if (!chromeOk) {
    if (isWin || isMac) {
      console.log(`  fix (${isWin ? 'Windows' : 'macOS'} headless or headed agent profile):`);
      console.log('    tp-start            # start headless background TP Browser');
      console.log('    tp-headed           # start headed GUI TP Browser (for human login)');
    } else {
      console.log('  fix (Linux headless or headed agent profile):');
      console.log('    tp-start            # or start chromium manually:');
      console.log('    mkdir -p ~/.local/share/ego-linux/profile-agent');
      console.log('    chromium --headless=new --no-first-run --no-default-browser-check \\');
      console.log(`      --remote-debugging-address=127.0.0.1 --remote-debugging-port=${chromePort} \\`);
      console.log('      --user-data-dir=$HOME/.local/share/ego-linux/profile-agent --window-size=1440,900 about:blank &');
    }
  }
  if (h && !h.chrome) console.log('  daemon is up but Chromium not attached; it retries every 3s once chrome answers.');
}

// ── thrown 值安全格式化 ──────────────────────────────────────────────
// 使用者腳本可以 throw 任何東西（null、undefined、字串、物件），不一定是 Error。
// 舊寫法直接讀 `e.name` / `e.message`：
//   * `throw null` / `throw undefined` → catch 區塊自己再丟 TypeError，
//     process.exit() 永遠到不了；只要腳本留下計時器或 SDK 已開 SSE 串流，CLI 就卡住不結束。
//   * `throw 'boom'` → 只印出「Error: undefined」，真正的原因不見了。
// 下面幾個函式保證「格式化本身不會拋錯」，catch 區塊因此一定能走到 process.exit(1)。
function describeThrown(value) {
  try {
    if (value instanceof Error) {
      const name = typeof value.name === 'string' && value.name.trim() ? value.name : 'Error';
      let message = '';
      try {
        message = typeof value.message === 'string' ? value.message : String(value.message ?? '');
      } catch { message = ''; }
      return message ? `${name}: ${message}` : name;
    }
    if (value === null) return 'Error: null';
    if (value === undefined) return 'Error: undefined';
    if (typeof value === 'string') return value.trim() ? `Error: ${value}` : 'Error: (empty string was thrown)';
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint' || typeof value === 'symbol') {
      return `Error: ${String(value)}`;
    }
    return `Error: ${describeThrownObject(value)}`;
  } catch {
    return 'Error: (unprintable thrown value)';
  }
}

function describeThrownObject(value) {
  try {
    const json = JSON.stringify(value);
    if (typeof json === 'string' && json.length > 0) {
      return json.length > 2000 ? `${json.slice(0, 2000)}…` : json;
    }
  } catch {}
  try {
    const text = String(value);
    if (text && text !== '[object Object]') return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
  } catch {}
  try { return Object.prototype.toString.call(value); } catch {}
  return '(unserializable object)';
}

function thrownStack(value) {
  try {
    if (value === null || typeof value !== 'object') return '';
    const stack = value.stack;
    if (typeof stack !== 'string' || stack === '') return '';
    return stack.split('\n').slice(1, 4).join('\n');
  } catch {
    return '';
  }
}

// ── 暫存執行目錄清理（fan-out w9/s08）────────────────────────────────
// `nodejs` 子指令會把使用者腳本寫進 mkdtempSync() 產生的 tp-run-XXXX/script.mjs 再動態 import。
// 這份檔案是「腳本原文」，可能帶帳密、token 或內網網址；舊寫法只在 finally 裡 rmSync，
// 而使用者腳本只要在 import 期間同步呼叫 process.exit()，Node 不會展開堆疊、finally 永不執行，
// 暫存目錄就永久留在 TMPDIR，而且每次執行都多留一份。
// 'exit' 事件在 process.exit() 與正常結束時都會觸發，且該階段只允許同步工作，rmSync 正好合用。
function removeTmpRunDir(dir) {
  if (!dir) return;
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

async function runNodeJs(args) {
  let code = null;
  if (args[0] === '-e') {
    // `-e` 少了腳本字串時，舊寫法把 undefined 靜靜變成空腳本：先透過 ensureRunning() 去連
    // 甚至啟動／重啟整個瀏覽器，再「成功」執行一支什麼都不做的腳本，使用者只看到 exit 0。
    // 改成在連線／啟動任何東西之前就回報用法錯誤。
    if (args.length < 2) {
      console.error('tp-browser nodejs: -e requires a script string, e.g. -e "console.log(1)"');
      console.error('tp-browser nodejs: or pipe the script via stdin / heredoc');
      process.exit(2);
    }
    code = args[1];
  } else {
    code = await new Promise((resolve, reject) => {
      let buf = '';
      if (process.stdin.isTTY) { console.error('tp-browser nodejs: pass -e "code" or pipe a heredoc'); process.exit(2); }
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (d) => { buf += d; });
      // 少了這行，stdin 讀取失敗（EPIPE／EIO／Windows 上已關閉的管線）不會觸發 'end'，
      // 這個 Promise 永遠不 settle，CLI 就卡在事件迴圈裡永遠不結束。
      process.stdin.on('error', reject);
      process.stdin.on('end', () => resolve(buf));
    }).catch((e) => {
      try { console.error(`tp-browser nodejs: failed to read the script from stdin: ${describeThrown(e)}`); } catch {}
      process.exit(2);
    });
  }
  code = String(code || '').replace(/^﻿/, '');

  // 空腳本（`nodejs < /dev/null`、只含空白的 heredoc、變數展開失敗的管線、`-e ''`）不是有效任務。
  // 舊寫法會照樣往下走 ensureRunning()：沒有 daemon 時甚至會去跑啟動器「重啟整個瀏覽器」，
  // 最後「成功」執行一支什麼都不做的腳本並回 exit 0，使用者因此無法分辨
  // 「腳本真的沒做事」與「內容根本沒送進來」（例如 heredoc 被截斷）。
  // 這與上面 `-e` 缺字串的處理同一原則：在接觸任何 daemon／瀏覽器之前就以用法錯誤結束。
  if (!code.trim()) {
    console.error('tp-browser nodejs: the script is empty; pass -e "code" or a non-empty heredoc/pipe');
    process.exit(2);
  }

  const { port, h, launcherExit } = await ensureRunning();
  if (!h || !h.ok) {
    // 啟動器已明確失敗（非 0）時，真正的原因剛被它印在 stderr 上。此時要照實回報
    // 並沿用啟動器的退出碼，而不是吞掉它、改喊「daemon 連不上」再叫使用者重跑 tp-start。
    if (launcherExit) {
      console.error(`tp-browser: failed to start the browser (launcher exited with code ${launcherExit}); see the launcher messages above.`);
      process.exit(Number.isInteger(launcherExit) && launcherExit > 0 && launcherExit < 256 ? launcherExit : 1);
    }
    console.error(`tp-browserd is not reachable on 127.0.0.1:${port}.`);
    console.error('Start TooPower Browser first:  tp-start  (or: tp-headed)');
    process.exit(2);
  }

  const { createClient, buildSdk } = await import('../lib/sdk.js');
  const token = readToken();
  const { rpc, waitPush } = createClient({ port, token });
  const sdk = buildSdk({ rpc, waitPush });
  for (const [k, v] of Object.entries(sdk)) {
    if (typeof v === 'function' || (typeof v === 'class')) globalThis[k] = v;
  }
  globalThis.Page = sdk.Page; globalThis.TaskSpace = sdk.TaskSpace;

  // mkdtempSync／writeFileSync 一起放進 try：舊寫法若這裡失敗（磁碟滿、權限、暫存目錄不可寫），
  // 例外會往外丟，finally 不會執行，0700 的暫存目錄就永遠留在 tmpdir 裡沒人清。
  let tmpDir = null;
  let exitCode = 0;
  // 使用者腳本可能在 import 期間同步呼叫 process.exit()（例如 `-e 'process.exit(3)'`）：
  // process.exit() 不展開堆疊，finally 永遠不會執行，於是含腳本原文（可能帶帳密或網址）的
  // tp-run-XXXX/script.mjs 永久留在 TMPDIR。建立目錄後立刻掛上同步清理，
  // finally 也改用同一套機制（rmSync force:true ⇒ 重複清理安全冪等；
  // 刻意不 removeListener：萬一第一次清理失敗，程序 exit 時還有第二次機會）。
  process.on('exit', () => { removeTmpRunDir(tmpDir); });
  try {
    tmpDir = mkdtempSync(join(tmpdir(), 'tp-run-'));
    const tmp = join(tmpDir, 'script.mjs');
    writeFileSync(tmp, code, { mode: 0o600 });
    await import(pathToFileURL(tmp).href);
  } catch (e) {
    // thrown 值不一定是 Error。整段回報再用一層 try 包住，
    // 任何意外都不能阻止下面的 process.exit(1)。
    exitCode = 1;
    try {
      console.error(describeThrown(e));
      const stack = thrownStack(e);
      if (stack) console.error(stack);
      console.error(`tp-browser's nodejs process exited with code 1.`);
    } catch {
      // 連 stderr 都寫不出去時，仍然要讓程序結束，不能卡在事件迴圈裡。
    }
  } finally {
    removeTmpRunDir(tmpDir);
  }
  // The SSE event stream keeps the event loop alive; a CLI must exit explicitly.
  // 使用者腳本可以用 `process.exitCode = N` 表示失敗（這是不截斷 stdout 的安全慣例）；
  // 舊寫法 `process.exit(0)` 會把它蓋掉，自動化因此把失敗的腳本當成成功。
  const scriptExit = Number(process.exitCode);
  const finalCode = exitCode !== 0 ? exitCode : (Number.isInteger(scriptExit) ? scriptExit : 0);
  process.exit(finalCode);
}

main().catch((e) => {
  // 這裡同樣可能收到非 Error 值；而且 SSE 串流可能已經開啟，事件迴圈不會自己排空，
  // 所以一定要顯式 process.exit(1)，不能只設 process.exitCode。
  try { console.error(describeThrown(e)); } catch {}
  process.exit(1);
});
