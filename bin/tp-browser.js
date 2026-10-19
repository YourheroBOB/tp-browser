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
    }
    const r = spawnSync('powershell.exe', psArgs, { stdio });
    return r.status ?? 0;
  } else {
    const script = resolveScript(mode === 'stop' ? 'tp-stop.sh' : 'tp-start.sh', 'ego-start.ps1');
    const shArgs = [script];
    if (mode === 'headed') shArgs.push('--headed');
    if (mode === 'restart') shArgs.push('--restart');
    shArgs.push(...extraArgs);
    const r = spawnSync('/bin/sh', shArgs, { stdio });
    return r.status ?? 0;
  }
}

function readToken() {
  if (!existsSync(TOKEN_FILE)) throw new Error(`no token at ${TOKEN_FILE}; is tp-browserd running?`);
  return readFileSync(TOKEN_FILE, 'utf8').trim();
}
function readPort() {
  if (existsSync(DAEMON_JSON)) {
    try {
      const p = JSON.parse(readFileSync(DAEMON_JSON, 'utf8')).port;
      if (p === 9774) return 9774;
    } catch {}
  }
  return 9772;
}
function readChromePort() {
  if (existsSync(DAEMON_JSON)) {
    try {
      const p = JSON.parse(readFileSync(DAEMON_JSON, 'utf8')).chromePort;
      if (p === 9775) return 9775;
    } catch {}
  }
  return 9773;
}
function daemonBase(port) {
  return port === 9774 ? 'http://127.0.0.1:9774' : 'http://127.0.0.1:9772';
}
function chromeVersionUrl(chromePort) {
  return chromePort === 9775 ? 'http://127.0.0.1:9775/json/version' : 'http://127.0.0.1:9773/json/version';
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

async function runNodeJs(args) {
  let code = null;
  if (args[0] === '-e') code = args[1];
  else {
    code = await new Promise((resolve) => {
      let buf = '';
      if (process.stdin.isTTY) { console.error('tp-browser nodejs: pass -e "code" or pipe a heredoc'); process.exit(2); }
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (d) => { buf += d; });
      process.stdin.on('end', () => resolve(buf));
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
    exitCode = 1;
    console.error(`${e.name || 'Error'}: ${e.message}`);
    const stack = String(e.stack || '').split('\n').slice(1, 4).join('\n');
    if (stack) console.error(stack);
    console.error(`tp-browser's nodejs process exited with code 1.`);
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
  // The SSE event stream keeps the event loop alive; a CLI must exit explicitly.
  process.exit(exitCode);
}

main().catch((e) => { console.error(`${e.name || 'Error'}: ${e.message}`); process.exitCode = 1; });
