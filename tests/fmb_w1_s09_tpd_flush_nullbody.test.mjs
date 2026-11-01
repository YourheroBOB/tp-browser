import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 9774;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const FAKE_TOKEN = 'FAKE_VALUE_FOR_TEST';
const DAEMON_PATH = fileURLToPath(new URL('../daemon/tp-browserd.js', import.meta.url));

function isPortAvailable() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', (error) => {
      if (error.code === 'EADDRINUSE') resolve(false);
      else reject(error);
    });
    probe.listen(PORT, '127.0.0.1', () => {
      probe.close((error) => error ? reject(error) : resolve(true));
    });
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHealth(child, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('daemon exited before becoming healthy');
    try {
      const response = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(500) });
      if (response.status === 200) return response.json();
    } catch {}
    await delay(100);
  }
  throw new Error('daemon did not become healthy before timeout');
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, delay(2_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    const forceExited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await forceExited;
  }
}

test('tp-browserd flush-and-close responds and null RPC bodies do not crash it', async (t) => {
  if (!(await isPortAvailable())) {
    t.skip('port 9774 is already occupied');
    return;
  }

  const home = mkdtempSync(join(tmpdir(), 'fmb-w1-s09-tp-browserd-'));
  let child;
  try {
    const dataDir = join(home, '.local', 'share', 'ego-linux');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dataDir, 'token'), FAKE_TOKEN, { mode: 0o600 });

    child = spawn(process.execPath, [DAEMON_PATH, '--alt-port'], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: 'ignore',
    });

    await waitForHealth(child);

    const flush = await fetch(`${BASE_URL}/flush-and-close`);
    assert.equal(flush.status, 200);
    assert.deepEqual(await flush.json(), { ok: true });

    const rpc = await fetch(`${BASE_URL}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tp-token': FAKE_TOKEN },
      body: 'null',
    });
    assert.equal(rpc.status, 400);
    const rpcBody = await rpc.json();
    assert.equal(rpcBody.ok, false);
    assert.equal(rpcBody.error.name, 'BadRequest');

    const health = await fetch(`${BASE_URL}/health`);
    assert.equal(health.status, 200);
  } finally {
    await stopChild(child);
    rmSync(home, { recursive: true, force: true });
  }
});
