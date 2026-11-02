// tests/fmb_w10_s01_ego_browser_rpc_timeout.test.mjs
// 回歸測試：`tp-browser spaces` 走 POST /rpc 時原本完全沒有任何逾時。
// 只要 daemon 接了連線卻不回應（事件迴圈被 CDP 洪流綁死、半開連線、被本機防火牆吞掉），
// CLI 就會永遠掛著：不結束、也不印任何錯誤，自動化流程整批卡死。
//
// 測試邊界：只在 127.0.0.1 上用 OS 指派的臨時埠跑「假 daemon」，不連任何正式服務；
// 憑證一律使用明顯假值 FAKE_VALUE_FOR_TEST；暫存 HOME 建在 tmpdir() 內並於 after() 清除。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/ego-browser.js', import.meta.url));

// 假的資料目錄：CLI 會去 $HOME/.local/share/ego-linux/token 讀 token。
const home = mkdtempSync(join(tmpdir(), 'fmb-w10-s01-home-'));
const dataDir = join(home, '.local', 'share', 'ego-linux');
mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, 'token'), 'FAKE_VALUE_FOR_TEST\n', { mode: 0o600 });

const servers = [];

function startFakeDaemon(handler) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    servers.push(server);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// 必須用非同步 spawn：spawnSync 會鎖住本測試程序的 event loop，
// 假 daemon 就無法回應子程序送來的 /health，測試本身會失去意義。
function runCli(args, extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    // 這道保險只是不要讓「舊行為掛死」把整個測試套件一起拖住：
    // 舊版沒有逾時，會被 SIGKILL 收掉，signal !== null 即明確失敗。
    const killer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('close', (code, signal) => {
      clearTimeout(killer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

after(() => {
  for (const s of servers) {
    try { s.closeAllConnections?.(); } catch {}
    try { s.close(); } catch {}
  }
  rmSync(home, { recursive: true, force: true });
});

test('spaces：daemon 卡住不回 /rpc 時，CLI 必須逾時結束並回報原因（不可無限等待）', async () => {
  const server = await startFakeDaemon((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, chrome: true }));
      return;
    }
    // /rpc：讀掉請求之後刻意永不回應，模擬卡死的 daemon。
    req.resume();
  });
  const { port } = server.address();

  const r = await runCli(['spaces'], { TP_DAEMON_PORT: String(port), TP_RPC_TIMEOUT_MS: '400' });

  assert.equal(r.signal, null, `CLI 沒有自己結束（signal=${r.signal}），代表 /rpc 完全沒有逾時`);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /did not answer \/rpc \(space\.list\) within 400ms/);
  assert.ok(r.stderr.includes(String(port)), `錯誤訊息應指出是哪個埠：${r.stderr}`);
});

test('spaces：daemon 正常回應時成功路徑不受逾時影響', async () => {
  const server = await startFakeDaemon((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, chrome: true }));
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const { method } = JSON.parse(body || '{}');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { called: method, spaces: [{ id: 1 }] } }));
    });
  });
  const { port } = server.address();

  const r = await runCli(['spaces'], { TP_DAEMON_PORT: String(port), TP_RPC_TIMEOUT_MS: '400' });

  assert.equal(r.signal, null);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /"called": "space\.list"/);
  assert.match(r.stdout, /"id": 1/);
});
