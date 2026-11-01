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

// 回傳 { code, label }：code 是啟動器退出碼（語意見 launcherExitCode），label 是被執行的啟動器路徑。
// label 讓呼叫端能把「哪一支啟動器失敗」寫進錯誤訊息，而不是只丟出一個沒有上下文的數字。
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
    return { code: launcherExitCode(r, script), label: script };
  } else {
    const script = resolveScript(mode === 'stop' ? 'tp-stop.sh' : 'tp-start.sh', 'ego-start.ps1');
    const shArgs = [script];
    if (mode === 'headed') shArgs.push('--headed');
    if (mode === 'restart') shArgs.push('--restart');
    shArgs.push(...extraArgs);
    const r = spawnSync('/bin/sh', shArgs, { stdio });
    return { code: launcherExitCode(r, script), label: script };
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
  const launcher = runLauncher('start', [], true);
  port = readPort();
  h = await health(port);
  // 啟動器失敗（找不到瀏覽器、權限、腳本本身錯誤…）時不要吞掉它：
  // 把 { code, label } 一起回傳，讓呼叫端能把「退出碼 + 啟動器標籤」寫進錯誤訊息。
  return { port, h, launcher };
}

async function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0] || 'help';

  if (sub === 'start' || sub === '--start') { process.exitCode = runLauncher('start', argv.slice(1)).code; return; }
  if (sub === 'headed' || sub === '--headed' || sub === '-Headed') { process.exitCode = runLauncher('headed', argv.slice(1)).code; return; }
  if (sub === 'restart' || sub === '--restart') { process.exitCode = runLauncher('restart', argv.slice(1)).code; return; }
  if (sub === 'stop' || sub === '--stop') { process.exitCode = runLauncher('stop', argv.slice(1)).code; return; }
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

const NODEJS_USAGE = "usage: tp-browser nodejs -e 'code'          run an agent script passed on the command line\n" +
  "       tp-browser nodejs <<'EOF' ... EOF   pipe the script via stdin/heredoc";

// 參數錯誤必須在 ensureRunning() 之前就結束。舊版 `nodejs -e`（後面沒帶程式碼）會把 code
// 變成空字串 → 照樣去叫 tp-start.sh → 最後用「daemon 不在線」誤導使用者；若 daemon 剛好在線，
// 甚至會執行空腳本並 exit 0，使用者完全看不出自己打錯參數。
function nodeJsUsageError(reason) {
  console.error(`tp-browser nodejs: ${reason}`);
  console.error(NODEJS_USAGE);
  process.exit(2);
}

async function runNodeJs(args) {
  let code = null;
  if (args[0] === '-e') {
    if (args[1] === undefined) nodeJsUsageError('-e requires a script string, e.g. -e "console.log(1)"');
    code = args[1];
    if (String(code).replace(/^\uFEFF/, '').trim() === '') nodeJsUsageError('-e was given an empty script string');
  } else {
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

  const { port, h, launcher } = await ensureRunning();
  // 啟動器失敗時，即使埠上有別的 daemon 回應 /health（Chromium 沒掛上），也要回報啟動器失敗，
  // 不能把它當成可用：否則後面會在讀 token 時才以不相干的錯誤 exit 1。
  const launcherFailed = launcher && launcher.code !== 0 && !(h && h.ok && h.chrome);
  if (!h || !h.ok || launcherFailed) {
    if (launcher && launcher.code !== 0) {
      console.error(`tp-browser: launcher ${launcher.label} exited with code ${launcher.code}; the daemon did not come up.`);
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

main().catch((e) => {
  // 這裡同樣可能收到非 Error 值；而且 SSE 串流可能已經開啟，事件迴圈不會自己排空，
  // 所以一定要顯式 process.exit(1)，不能只設 process.exitCode。
  try { console.error(describeThrown(e)); } catch {}
  process.exit(1);
});
