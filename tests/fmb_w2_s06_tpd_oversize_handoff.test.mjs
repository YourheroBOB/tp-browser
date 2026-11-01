import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const PORT = 9774;
const daemonScript = fileURLToPath(new URL('../daemon/tp-browserd.js', import.meta.url));

async function checkPortAvailability() {
  const probe = createServer();
  return new Promise((resolve, reject) => {
    probe.once('error', (error) => {
      if (error.code === 'EADDRINUSE') resolve(false);
      else reject(error);
    });
    probe.listen(PORT, '127.0.0.1', () => {
      probe.close((error) => {
        if (error) reject(error);
        else resolve(true);
      });
    });
  });
}

async function waitForHealth(child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`daemon exited before becoming ready (${child.exitCode})`);
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/health`, {
        signal: AbortSignal.timeout(250),
      });
      if (response.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('daemon did not become ready before the timeout');
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const waitForExit = () => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', resolve);
  });
  child.kill('SIGTERM');
  const exited = await Promise.race([
    waitForExit().then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);
  if (!exited) {
    child.kill('SIGKILL');
    await waitForExit();
  }
}

test('tp-browserd returns 413 for oversized RPC bodies and rejects handOff for unknown spaces', async (t) => {
  if (!(await checkPortAvailability())) {
    t.skip(`port ${PORT} is already in use`);
    return;
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'fmb-w2-s06-tpd-'));
  const home = join(tempRoot, 'home');
  mkdirSync(home);
  const child = spawn(process.execPath, ['--experimental-websocket', daemonScript, '--alt-port'], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: 'ignore',
  });

  try {
    await waitForHealth(child);
    const token = readFileSync(join(home, '.local', 'share', 'ego-linux', 'token'), 'utf8').trim();
    const headers = { 'content-type': 'application/json', 'x-tp-token': token };

    const oversizedBody = JSON.stringify({
      method: 'status',
      params: { padding: 'x'.repeat(1_200_000) },
    });
    const oversizedResponse = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
      method: 'POST',
      headers,
      body: oversizedBody,
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(oversizedResponse.status, 413);
    const oversizedResult = await oversizedResponse.json();
    assert.equal(oversizedResult.ok, false);
    assert.equal(oversizedResult.error.name, 'PayloadTooLarge');

    const handOffResponse = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ method: 'space.handOff', params: { id: 999 } }),
      signal: AbortSignal.timeout(5_000),
    });
    const handOffResult = await handOffResponse.json();
    assert.equal(handOffResult.ok, false);
    assert.equal(handOffResult.error.name, 'UnknownSpace');
  } finally {
    await stopChild(child);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
