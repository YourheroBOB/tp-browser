#!/usr/bin/env node
// ego-browser (Linux agent build) — CLI compatible with the ego-browser skill.
// `ego-browser nodejs` runs a Node.js script with the taskSpace()/page() SDK.
// Script code arrives via -e or stdin (heredoc) — never from argv file paths —
// and this CLI never spawns processes: it talks HTTP+SSE to ego-browserd.
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const DATA_DIR = join(homedir(), '.local', 'share', 'ego-linux');
const TOKEN_FILE = join(DATA_DIR, 'token');
const DAEMON_JSON = join(DATA_DIR, 'daemon.json');

function readToken() {
  if (!existsSync(TOKEN_FILE)) throw new Error(`no token at ${TOKEN_FILE}; is ego-browserd running?`);
  return readFileSync(TOKEN_FILE, 'utf8').trim();
}
function readPort() {
  if (existsSync(DAEMON_JSON)) { try { return JSON.parse(readFileSync(DAEMON_JSON, 'utf8')).port; } catch {} }
  return 9772;
}

async function health(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2500) });
    return await r.json();
  } catch { return null; }
}

async function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0] || 'help';

  if (sub === 'nodejs') return runNodeJs(argv.slice(1));
  if (sub === 'status' || sub === 'spaces') {
    const port = readPort();
    const h = await health(port);
    if (!h) { console.error(`ego-browserd is not reachable on 127.0.0.1:${port}.`); console.error(`Start it: node ${daemonPath()}`); process.exitCode = 2; return; }
    console.log(JSON.stringify(h, null, 1));
    if (sub === 'spaces') console.log(JSON.stringify(await rpcCmd(port, 'space.list'), null, 1));
    return;
  }
  if (sub === 'doctor') return doctor();
  if (sub === 'version') { console.log('ego-linux 0.1.0 (ego-browser compatible subset)'); return; }
  console.log(`ego-browser (ego-linux build)
usage:
  ego-browser nodejs -e 'code'      run an agent script (-e) or pipe one via stdin/heredoc
  ego-browser status                daemon + chrome health
  ego-browser spaces                list task spaces
  ego-browser doctor                diagnose and print fix commands
  ego-browser version`);
}

function daemonPath() { return join(dirname(dirname(fileURLToPath(import.meta.url))), 'daemon', 'ego-browserd.js'); }

async function rpcCmd(port, method, params) {
  const res = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ego-token': readToken() },
    body: JSON.stringify({ id: 1, method, params: params || {} }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(`${j.error?.name}: ${j.error?.message}`);
  return j.result;
}

async function doctor() {
  const port = readPort();
  const chromePort = 9773;
  console.log('== ego-linux doctor ==');
  const h = await health(port);
  console.log(`daemon  127.0.0.1:${port}: ${h ? `ok (chrome attached: ${h.chrome})` : 'NOT RUNNING'}`);
  if (!h) console.log(`  fix: node ${daemonPath()}   # or: systemctl --user start ego-browserd`);
  let chromeOk = false;
  try { const r = await fetch(`http://127.0.0.1:${chromePort}/json/version`, { signal: AbortSignal.timeout(2500) }); const v = await r.json(); chromeOk = true; console.log(`chrome  127.0.0.1:${chromePort}: ok (${v.Browser})`); } catch { console.log(`chrome  127.0.0.1:${chromePort}: NOT REACHABLE`); }
  if (!chromeOk) {
    console.log('  fix (headless agent profile):');
    console.log('    mkdir -p ~/.local/share/ego-linux/profile-agent');
    console.log('    chromium --headless=new --no-first-run --no-default-browser-check \\');
    console.log(`      --remote-debugging-port=${chromePort} --user-data-dir=$HOME/.local/share/ego-linux/profile-agent \\`);
    console.log('      --window-size=1440,900 about:blank &');
    console.log('  (Xvfb headed variant: drop --headless=new after starting Xvfb and setting DISPLAY)');
  }
  if (h && !h.chrome) console.log('  daemon is up but Chromium not attached; it retries every 3s once chrome answers.');
}

async function runNodeJs(args) {
  let code = null;
  if (args[0] === '-e') code = args[1];
  else {
    code = await new Promise((resolve) => {
      let buf = '';
      if (process.stdin.isTTY) { console.error('ego-browser nodejs: pass -e "code" or pipe a heredoc'); process.exit(2); }
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (d) => { buf += d; });
      process.stdin.on('end', () => resolve(buf));
    });
  }

  const port = readPort();
  const h = await health(port);
  if (!h) {
    console.error(`ego-browserd is not reachable on 127.0.0.1:${port}.`);
    console.error(`Start the daemon first:  node ${daemonPath()}`);
    console.error(`Then start Chromium with:  chromium --headless=new --remote-debugging-port=9773 --user-data-dir=$HOME/.local/share/ego-linux/profile-agent`);
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

  const tmp = join(tmpdir(), `ego-linux-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(tmp, code, { mode: 0o600 });
  let exitCode = 0;
  try {
    await import(tmp);
  } catch (e) {
    exitCode = 1;
    console.error(`${e.name || 'Error'}: ${e.message}`);
    const stack = String(e.stack || '').split('\n').slice(1, 4).join('\n');
    if (stack) console.error(stack);
    console.error(`ego-linux's nodejs process exited with code 1.`);
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
  // The SSE event stream keeps the event loop alive; a CLI must exit explicitly.
  process.exit(exitCode);
}

main().catch((e) => { console.error(`${e.name || 'Error'}: ${e.message}`); process.exitCode = 1; });
