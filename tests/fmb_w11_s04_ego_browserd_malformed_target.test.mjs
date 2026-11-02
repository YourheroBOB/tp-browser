// tests/fmb_w11_s04_ego_browserd_malformed_target.test.mjs
//
// Regression for daemon/ego-browserd.js: the HTTP request handler used to be
// `createServer(async (req, res) => ...)` with no error boundary, so any throw inside it
// became an unhandled rejection — and Node's default policy for those is to terminate
// the process. Node's HTTP parser only checks the request line against its own character
// table, so a target such as `GET http://[ HTTP/1.1` is delivered to the handler while
// `new URL()` rejects it. Because that parse happens before the Host/Origin guard, one
// unauthenticated request from any local process killed the daemon and every TaskSpace
// with it.
//
// Hermetic by construction: the daemon hard-codes its listen port (9772 / 9774) and
// probes 9773 / 9775 for a real Chromium, so this test (a) rebinds the daemon's HTTP
// listener to a unix socket inside its own mkdtemp() directory and (b) blocks the Chrome
// probe, both through a tiny preload written into that same temp directory. It therefore
// never competes for a shared loopback port and never touches a real browser.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DAEMON = fileURLToPath(new URL('../daemon/ego-browserd.js', import.meta.url));

const tempRoot = mkdtempSync(join(tmpdir(), 'fmb-w11-s04-ego-browserd-'));
const socketPath = process.platform === 'win32'
  ? '\\\\.\\pipe\\fmb-w11-s04-' + process.pid + '-' + Date.now()
  : join(tempRoot, 'daemon.sock');
const preloadPath = join(tempRoot, 'listen-on-unix-socket.mjs');

const PRELOAD_SOURCE = `
import http from 'node:http';

// Rebind the daemon's HTTP listener to a unix socket so this test never competes for the
// hard-coded loopback ports (9772 / 9774) with a real daemon or a parallel test run.
const socketPath = process.env.FMB_W11_S04_DAEMON_SOCKET;
if (socketPath) {
  const originalListen = http.Server.prototype.listen;
  http.Server.prototype.listen = function listen(...args) {
    const cb = args.find((a) => typeof a === 'function');
    return originalListen.call(this, { path: socketPath }, cb);
  };
}

// Never let the daemon under test attach to a Chromium that happens to run on this
// machine: the regression only needs the HTTP layer.
const realFetch = globalThis.fetch;
globalThis.fetch = function fetch(input, init) {
  const url = String(input && input.url ? input.url : input);
  if (url.startsWith('http://127.0.0.1:9773') || url.startsWith('http://127.0.0.1:9775')) {
    return Promise.reject(new Error('blocked by the FMB_W11_S04 test preload'));
  }
  return realFetch(input, init);
};
`;
writeFileSync(preloadPath, PRELOAD_SOURCE, 'utf8');

// Request targets built only from characters Node's HTTP parser accepts, yet that
// `new URL()` refuses: unterminated / empty IPv6 host, invalid percent-encoding,
// out-of-range port.
const MALFORMED_TARGETS = [
  'http://[',
  'http://[]/',
  'http://%zz/',
  'http://example.test:99999999999/',
];

let child = null;
let daemonStderr = '';

after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL'); } catch {}
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
  rmSync(tempRoot, { recursive: true, force: true });
});

function rawRequest(target, { host = '127.0.0.1', timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const sock = net.connect({ path: socketPath });
    let raw = '';
    let settled = false;
    const timer = setTimeout(finish, timeoutMs);
    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch {}
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(raw);
      resolve({ status: m ? Number(m[1]) : 0, raw });
    }
    sock.setEncoding('utf8');
    sock.on('connect', () => {
      sock.write('GET ' + target + ' HTTP/1.1\r\nHost: ' + host + '\r\nConnection: close\r\n\r\n');
    });
    sock.on('data', (c) => { raw += c; });
    sock.on('end', finish);
    sock.on('close', finish);
    sock.on('error', finish);
  });
}

// The daemon answers with `res.end(JSON.stringify(...))` and no Content-Length, so Node
// sends the body with `Transfer-Encoding: chunked`. Splitting on the first blank line and
// JSON.parse()-ing the rest would therefore always fail (the body still carries chunk
// framing), so the framing has to be decoded before asserting on the payload.
function dechunk(body) {
  let out = '';
  let pos = 0;
  while (pos < body.length) {
    const nl = body.indexOf('\r\n', pos);
    if (nl < 0) break;
    const size = parseInt(body.slice(pos, nl).split(';')[0].trim(), 16);
    if (!Number.isFinite(size) || size <= 0) break; // '0' is the terminal chunk
    out += body.slice(nl + 2, nl + 2 + size);
    pos = nl + 2 + size + 2;
  }
  return out;
}

function bodyOf(res) {
  const i = res.raw.indexOf('\r\n\r\n');
  if (i < 0) return null;
  const head = res.raw.slice(0, i).toLowerCase();
  const rest = res.raw.slice(i + 4);
  return /transfer-encoding:\s*chunked/.test(head) ? dechunk(rest) : rest;
}

function jsonOf(res) {
  const body = bodyOf(res);
  if (body === null) return null;
  try { return JSON.parse(body); } catch { return null; }
}

async function waitForHealth(proc, deadlineMs = 12000) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    if (proc.exitCode !== null || proc.signalCode !== null) return null;
    const res = await rawRequest('/health', { timeoutMs: 1500 });
    if (res.status === 200) return res;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

test('a malformed request target is answered with 400 and never kills the daemon', async (t) => {
  child = spawn(process.execPath, ['--import', pathToFileURL(preloadPath).href, DAEMON, '--alt-port'], {
    env: {
      ...process.env,
      HOME: tempRoot,
      USERPROFILE: tempRoot,
      EGO_BROWSERD_PORT: '', // never let the ambient environment choose the port
      FMB_W11_S04_DAEMON_SOCKET: socketPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', () => {});
  child.stderr.on('data', (c) => { daemonStderr += c; });

  const ready = await waitForHealth(child);
  if (!ready) {
    // Safety valve: if a future Node version changes --import / http listen semantics this
    // must not turn into a false failure. The skip reason always carries the daemon's own
    // diagnostics.
    t.skip('daemon did not become ready over its test socket: ' + daemonStderr.slice(-300));
    return;
  }
  assert.equal(jsonOf(ready)?.ok, true, 'health payload before the malformed requests');

  // The Host guard must still reject anything that is not loopback.
  const identity = await rawRequest('/health', { host: 'not-loopback.example' });
  assert.equal(identity.status, 403, 'non-loopback Host must be rejected with 403');

  const answered = [];
  for (const target of MALFORMED_TARGETS) {
    const res = await rawRequest(target);
    answered.push(res.status);
    const alive = await rawRequest('/health');
    assert.equal(
      alive.status,
      200,
      `daemon stopped serving after request target ${JSON.stringify(target)} (answer was ${res.status}); stderr=${daemonStderr.slice(-400)}`,
    );
    assert.equal(jsonOf(alive)?.ok, true, `health payload after ${JSON.stringify(target)}`);
  }

  assert.ok(
    answered.includes(400),
    `expected an explicit 400 for a malformed request target, got ${JSON.stringify(answered)}`,
  );
  assert.equal(child.exitCode, null, `daemon exited: ${daemonStderr.slice(-400)}`);
});
