import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const CLI = fileURLToPath(new URL('../bin/tp-browser.js', import.meta.url));

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(resolve));
}

function runCli(home, command) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, command], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        TP_DAEMON_PORT: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`tp-browser ${command} timed out`));
    }, 10_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test('CLI honors valid custom daemon and Chrome ports from daemon.json', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fmb-w4-s02-'));
  const dataDir = join(home, '.local', 'share', 'ego-linux');
  mkdirSync(dataDir, { recursive: true });

  const daemon = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, chrome: true }));
      return;
    }
    res.writeHead(404).end();
  });
  const chrome = createServer((req, res) => {
    if (req.url === '/json/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ Browser: 'FakeBrowser/1.0' }));
      return;
    }
    res.writeHead(404).end();
  });

  try {
    const daemonPort = await listen(daemon);
    const chromePort = await listen(chrome);
    writeFileSync(
      join(dataDir, 'daemon.json'),
      JSON.stringify({ port: daemonPort, chromePort }),
      'utf8',
    );

    const status = await runCli(home, 'status');
    assert.equal(status.code, 0, status.stderr);
    assert.deepEqual(JSON.parse(status.stdout), { ok: true, chrome: true });

    const doctor = await runCli(home, 'doctor');
    assert.equal(doctor.code, 0, doctor.stderr);
    assert.match(doctor.stdout, new RegExp(`daemon\\s+127\\.0\\.0\\.1:${daemonPort}: ok`));
    assert.match(doctor.stdout, new RegExp(`chrome\\s+127\\.0\\.0\\.1:${chromePort}: ok \\(FakeBrowser/1\\.0\\)`));
  } finally {
    await close(daemon);
    await close(chrome);
    rmSync(home, { recursive: true, force: true });
  }
});
