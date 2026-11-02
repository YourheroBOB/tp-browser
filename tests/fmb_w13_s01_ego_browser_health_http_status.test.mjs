import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/ego-browser.js', import.meta.url));

test('status treats a non-2xx health response as unreachable', async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, chrome: true }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'status'], {
      env: { ...process.env, TP_DAEMON_PORT: String(address.port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });

    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (status, signal) => {
      clearTimeout(timeout);
      resolve({ status, signal, stdout, stderr });
    });
  });

  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.signal, null);
  assert.match(result.stderr, /is not reachable/);
  assert.equal(result.stdout, '');
});
