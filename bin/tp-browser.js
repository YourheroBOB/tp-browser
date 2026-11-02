#!/usr/bin/env node
// tp-browser / ego-browser — CLI for TooPower Browser (Windows / Linux / macOS).
// `tp-browser nodejs` (or `ego-browser nodejs`) runs a Node.js script with the taskSpace()/page() SDK.
// Script code arrives via -e or stdin (heredoc) — never from argv file paths —
// and this CLI never spawns processes: it talks HTTP+SSE to tp-browserd / ego-browserd.
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, realpathSync } from 'node:fs';
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
// 讓 `tp-browser stop` / `start` 回 0，自動化流程因此誤判「已停止／已啟動」。
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
function readPort() {
  // 允許以 TP_DAEMON_PORT 明確指定 daemon 埠：未設定時行為與以往完全相同（9774 或 9772）。
  // 這讓測試能把假 daemon 綁在 OS 指派的臨時埠上，不必和真的 daemon 搶 9772／9774。
  const envPort = Number(process.env.TP_DAEMON_PORT);
  if (Number.isInteger(envPort) && envPort > 0 && envPort <= 65535) return envPort;
  if (existsSync(DAEMON_JSON)) {
    try {
      const p = JSON.parse(readFileSync(DAEMON_JSON, 'utf8')).port;
      if (Number.isInteger(p) && p > 0 && p <= 65535) return p;
    } catch {}
  }
  return 9772;
}
function readChromePort() {
  if (existsSync(DAEMON_JSON)) {
    try {
      const p = JSON.parse(readFileSync(DAEMON_JSON, 'utf8')).chromePort;
      if (Number.isInteger(p) && p > 0 && p <= 65535) return p;
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
  // 與 daemonBase 同一個病灶：舊寫法只認 9775，其餘一律導回 9773。
  // 若 daemon.json 指定了其他（合法的）chromePort，`tp-browser doctor` 會去探測錯的埠，
  // 運氣不好還會探到機器上「另一個」Chrome 的 CDP，並回報錯誤的 Browser 版本。
  // 直接採用傳入的埠，對既有 9773／9775 兩種情況結果完全相同。
  return `http://127.0.0.1:${chromePort}/json/version`;
}

async function health(port) {
  try {
    const r = await fetch(`${daemonBase(port)}/health`, { signal: AbortSignal.timeout(2500) });
    return await r.json();
  } catch { return null; }
}

async function ensureRunning() {
  let port = readPort();
  let h = await health(port);
  if (h && h.ok && h.chrome) return { port, h };
  runLauncher('start', [], true);
  port = readPort();
  h = await health(port);
  return { port, h };
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
  if (sub === 'version') { console.log(`TooPower Browser (tp-browser) 0.3.1 [${osBuildTag()} — 強到沒朋友]`); return; }
  console.log(`TooPower Browser / tp-browser (${osBuildTag()} — 強到沒朋友)
usage:
  tp-browser nodejs -e 'code'       run an agent script (-e) or pipe one via stdin/heredoc (auto-starts if needed)
  tp-browser start                  start headless background browser (alias: tp-start / ego-start)
  tp-browser headed                 open visible GUI browser window for human login/Co-Riding (alias: tp-headed / ego-headed)
  tp-browser stop                   stop browser & daemon (alias: tp-stop / ego-stop)
  tp-browser status                 daemon + chrome health
  tp-browser spaces                 list task spaces
  tp-browser doctor                 diagnose and print fix commands
  tp-browser skill                  print the AI Agent SKILL.md guide
  tp-browser version                print version and platform build`);
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

// `tp-browser nodejs` 的參數驗證，必須在「連線 daemon／啟動啟動器」之前完成。
// 舊寫法只判斷 `args[0] === '-e'` 就直接取 `args[1]`：shell 引號漏掉或變數展開失敗時
// （`tp-browser nodejs -e`、`tp-browser nodejs --eval '...'`）會掉進 stdin 分支，
// stdin 立刻 EOF ⇒ 執行空腳本 ⇒ 回報 exit 0，呼叫端因此誤判「任務已執行」；
// 而且過程中 ensureRunning 還會先把瀏覽器啟動器拉起來，白白開了一個瀏覽器。
// 非旗標的第一個參數維持舊行為（忽略並從 stdin 讀），避免破壞既有呼叫方式。
// 驗證邏輯抽成純函式：不印訊息、不 process.exit、不碰網路。
// 這樣測試就能直接 import 逐條驗證每個分支（含「不該誤擋」的反向案例），
// 不必為每一種輸入都啟動一個子程序；真正的入口 validateNodeJsArgs() 只負責印訊息與退出。
export function nodeJsArgsError(args) {
  const first = args[0];
  if (first === undefined) return null; // 走 stdin／heredoc 路徑，與以往完全相同
  if (first === '-e') {
    if (args.length < 2 || typeof args[1] !== 'string') {
      return [
        "tp-browser nodejs: -e requires a script string, e.g. tp-browser nodejs -e 'console.log(1)'",
        'tp-browser nodejs: nothing was executed; no daemon or browser was started.',
      ];
    }
    // 同一個病灶的另一半：`-e "$VAR"` 在 VAR 未設定／展開失敗時傳進來的是「空字串」，
    // 舊寫法會照樣執行空腳本並回 exit 0，呼叫端同樣誤判「任務已執行」。
    // 只含 BOM／空白的腳本也一樣沒有任何作用，因此在連線 daemon、拉起瀏覽器之前先擋掉。
    if (args[1].replace(/^\uFEFF/, '').trim() === '') {
      return [
        'tp-browser nodejs: -e received an empty script (only BOM/whitespace); nothing was executed.',
        "tp-browser nodejs: pass real code, e.g. tp-browser nodejs -e 'console.log(1)'  |  tp-browser nodejs < script.js",
      ];
    }
    return null;
  }
  if (typeof first === 'string' && first.startsWith('-')) {
    return [
      `tp-browser nodejs: unknown option ${first} (only -e is supported)`,
      'tp-browser nodejs: usage: tp-browser nodejs -e "code"  |  tp-browser nodejs < script.js',
    ];
  }
  return null;
}

function validateNodeJsArgs(args) {
  const lines = nodeJsArgsError(args);
  if (!lines) return;
  for (const line of lines) console.error(line);
  process.exit(2);
}

async function runNodeJs(args) {
  validateNodeJsArgs(args);
  let code = null;
  if (args[0] === '-e') code = args[1];
  else {
    code = await new Promise((resolve) => {
      let buf = '';
      if (process.stdin.isTTY) { console.error('tp-browser nodejs: pass -e "code" or pipe a heredoc'); process.exit(2); }
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (d) => { buf += d; });
      process.stdin.on('end', () => resolve(buf));
      process.stdin.once('error', (e) => {
        console.error(`tp-browser nodejs: failed to read stdin: ${e.message}`);
        process.exit(2);
      });
    });
  }
  code = String(code || '').replace(/^\uFEFF/, '');

  const { port, h } = await ensureRunning();
  if (!h || !h.ok) {
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

  const tmpDir = mkdtempSync(join(tmpdir(), 'tp-run-'));
  const tmp = join(tmpDir, 'script.mjs');
  writeFileSync(tmp, code, { mode: 0o600 });
  let exitCode = 0;
  try {
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
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
  // The SSE event stream keeps the event loop alive; a CLI must exit explicitly.
  process.exit(exitCode);
}

// 只有「被當成 CLI 直接執行」時才跑 main()；本檔被 import（例如測試）時不得有副作用，
// 否則就無法在不啟動子程序的前提下驗證 nodeJsArgsError() 這類純函式。
// 判定不出來時一律回 true（照舊執行）：寧可多跑一次，也絕不能讓 CLI 變成靜默 no-op。
function isCliEntryPoint() {
  try {
    const self = fileURLToPath(import.meta.url);
    const entry = process.argv[1];
    if (!entry) return false;
    if (entry === self) return true;
    return realpathSync(entry) === realpathSync(self);
  } catch {
    return true;
  }
}

if (isCliEntryPoint()) {
  main().catch((e) => {
    // 這裡同樣可能收到非 Error 值；而且 SSE 串流可能已經開啟，事件迴圈不會自己排空，
    // 所以一定要顯式 process.exit(1)，不能只設 process.exitCode。
    try { console.error(describeThrown(e)); } catch {}
    process.exit(1);
  });
}
