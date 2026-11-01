// tests/fmb_w7_s07_ego_cli_rpc_timeout.test.mjs
// w7-s07：ego-browser CLI 的 spaces /rpc 路徑必須有逾時、可辨識的 HTTP 錯誤，
// 且正常 JSON 回應行為不可改變。
// 零依賴、零網路、只連 127.0.0.1 臨時 server；認證示例值一律使用 FAKE_VALUE_FOR_TEST。
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('../bin/ego-browser.js', import.meta.url));
const cleanups = [];

after(() => {
  for (const fn of cleanups.splice(0).reverse()) {
    try { fn(); } catch {}
  }
});

function startServer(handler) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      cleanups.push(() => {
        try {
          if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        } catch {}
        try { server.close(); } catch {}
      });
      resolve({ server, port });
    });
  });
}

function makeHomeWithToken() {
  const root = mkdtempSync(join(tmpdir(), 'fmb-w7-s07-'));
  const home = join(root, 'home');
  const dataDir = join(home, '.local', 'share', 'ego-linux');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'token'), 'FAKE_VALUE_FOR_TEST', { mode: 0o600 });
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return home;
}

// 子程序不使用完整繼承環境：CI／sandbox 可能設定 proxy 或 NODE_OPTIONS，
// 讓 Node fetch 連 127.0.0.1 假 server 前就被導走或延遲，導致 health 先逾時。
// 這裡只保留 CLI 需要的最小環境，並明確關掉 env proxy 與 no_proxy 例外。
function childEnv(home, port, timeoutMs) {
  const env = {
    PATH: process.env.PATH || '',
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    TMPDIR: process.env.TMPDIR || tmpdir(),
    TP_DAEMON_PORT: String(port),
    TP_RPC_TIMEOUT_MS: String(timeoutMs),
    NO_PROXY: '127.0.0.1,localhost,::1,*',
    no_proxy: '127.0.0.1,localhost,::1,*',
    NODE_USE_ENV_PROXY: '0',
  };

  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || process.env.windir;
    if (systemRoot) env.SystemRoot = systemRoot;
    if (process.env.windir) env.windir = process.env.windir;
    if (process.env.COMSPEC) env.COMSPEC = process.env.COMSPEC;
    if (process.env.PATHEXT) env.PATHEXT = process.env.PATHEXT;
    env.TEMP = process.env.TEMP || tmpdir();
    env.TMP = process.env.TMP || tmpdir();
  }

  return env;
}

function runSpaces(home, port, timeoutMs) {
  const startedAt = Date.now();
  const res = spawnSync(process.execPath, [cli, 'spaces'], {
    encoding: 'utf8',
    timeout: 5000,
    env: childEnv(home, port, timeoutMs),
  });
  return {
    res,
    elapsedMs: Date.now() - startedAt,
    output: `${res.stdout || ''}\n${res.stderr || ''}`,
  };
}

function serveHealth(req, res) {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, chrome: true }));
    return true;
  }
  return false;
}

test('spaces: hanging /rpc exits non-zero within 5s and reports timeout', async () => {
  const home = makeHomeWithToken();
  const { port } = await startServer((req, res) => {
    if (serveHealth(req, res)) return;
    if (req.url === '/rpc') {
      req.resume();
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const { res, elapsedMs, output } = runSpaces(home, port, 500);

  assert.equal(res.error, undefined, output);
  assert.notEqual(res.status, 0);
  assert.ok(elapsedMs < 5000, `spaces took ${elapsedMs}ms`);
  assert.match(output, /timeout/i);
});

test('spaces: /rpc 502 HTML reports HTTP status and content opening', async () => {
  const home = makeHomeWithToken();
  const html = '<html><body><h1>502 Bad Gateway</h1><p>upstream returned HTML</p></body></html>';
  const { port } = await startServer((req, res) => {
    if (serveHealth(req, res)) return;
    if (req.url === '/rpc') {
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const { res, output } = runSpaces(home, port, 2000);

  assert.equal(res.error, undefined, output);
  assert.notEqual(res.status, 0);
  assert.match(output, /502/);
  assert.match(output, /text\/html/i);
});

test('spaces: /rpc 403 reports token mismatch', async () => {
  const home = makeHomeWithToken();
  const { port } = await startServer((req, res) => {
    if (serveHealth(req, res)) return;
    if (req.url === '/rpc') {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { name: 'Error', message: 'token rejected' } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const { res, output } = runSpaces(home, port, 2000);

  assert.equal(res.error, undefined, output);
  assert.notEqual(res.status, 0);
  assert.match(output, /403/);
  assert.match(output, /token 不符/);
});

test('spaces: normal JSON output is unchanged', async () => {
  const home = makeHomeWithToken();
  const { port } = await startServer((req, res) => {
    if (serveHealth(req, res)) return;
    if (req.url === '/rpc') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { marker: 'normal-json' } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const { res, output } = runSpaces(home, port, 2000);
  const expected = `${JSON.stringify({ ok: true, chrome: true }, null, 1)}\n${JSON.stringify({ marker: 'normal-json' }, null, 1)}\n`;

  assert.equal(res.error, undefined, output);
  assert.equal(res.status, 0, output);
  assert.equal(res.stderr, '');
  assert.equal(res.stdout, expected);
});
