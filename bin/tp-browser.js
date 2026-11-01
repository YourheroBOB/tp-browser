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

async function runNodeJs(args) {
  // ── 參數檢查：在連線／啟動任何東西之前就擋掉 ──────────────────────
  // 舊寫法只認 args[0]==='-e'，其餘一律靜默改讀 stdin：使用者誤傳檔案路徑
  // （`nodejs ./x.js`）、`--eval`、`-c`、`--help` 時參數被無聲丟棄；若 stdin 又是
  // /dev/null 或空管線（agent／CI 常見），接下來還會先 ensureRunning() 把整個瀏覽器
  // 拉起來，再執行一支空腳本並 exit 0——看起來成功，其實什麼都沒做。
  // 現在只要第一個參數不是 -e 卻又帶了任何參數，就是用法錯誤：exit 2、不連線、不啟動。
  if (args.length > 0 && args[0] !== '-e') {
    console.error(`tp-browser nodejs: unrecognized argument(s): ${args.join(' ')}`);
    console.error('tp-browser nodejs: the script must come from -e "code" or stdin (heredoc); file paths are not accepted.');
    console.error('tp-browser nodejs:   tp-browser nodejs -e "code"');
    console.error("tp-browser nodejs:   tp-browser nodejs <<'EOF' … EOF");
    process.exit(2);
  }

  let code = null;
  if (args[0] === '-e') {
    // `-e` 少了腳本字串時，舊寫法把 undefined 靜靜變成空腳本：先透過 ensureRunning() 去連
    // 甚至啟動／重啟整個瀏覽器，再「成功」執行一支什麼都不做的腳本，使用者只看到 exit 0。
    // 改成在連線／啟動任何東西之前就回報用法錯誤（與 ego-browser.js 對應段落一致）。
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
  code = String(code || '').replace(/^\uFEFF/, '');

  // 空腳本（去除 BOM 與空白後）→ 用法錯誤。stdin 是 /dev/null 或空管線時（agent／CI
  // 很常見），舊寫法會先 ensureRunning() 啟動瀏覽器，再跑一支空腳本並 exit 0。
  // 這個檢查必須排在 ensureRunning() 之前：不得連線、不得啟動任何東西。
  if (code.trim() === '') {
    console.error('tp-browser nodejs: the script is empty (after stripping BOM and whitespace).');
    console.error('tp-browser nodejs: pass the code with -e "code" or pipe a non-empty script via stdin / heredoc.');
    process.exit(2);
  }

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

  // mkdtempSync／writeFileSync 一起放進 try：舊寫法若這裡失敗（磁碟滿、權限、暫存目錄不可寫），
  // 例外會往外丟，finally 不會執行，0700 的暫存目錄就永遠留在 tmpdir 裡沒人清。
  let tmpDir = null;
  let exitCode = 0;
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
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }
  // The SSE event stream keeps the event loop alive; a CLI must exit explicitly.
  // 使用者腳本可以用 `process.exitCode = N` 表示失敗（這是不截斷 stdout 的安全慣例）；
  // 舊寫法 `process.exit(exitCode)` 在腳本成功時把它蓋成 0，自動化因此把失敗腳本當成功。
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
