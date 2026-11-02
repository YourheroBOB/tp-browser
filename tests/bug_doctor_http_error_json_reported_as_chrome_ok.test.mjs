import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ego-browser.js');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    server.on('error', reject);
  });
}

function runDoctor(home) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.TP_DAEMON_PORT;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'doctor'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('ego-browser doctor timed out'));
    }, 8000);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test('doctor must not treat HTTP 500 JSON from /json/version as a live Chrome', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tp-doctor-chrome-http-'));
  const dataDir = join(home, '.local', 'share', 'ego-linux');
  mkdirSync(dataDir, { recursive: true });
  const hits = [];
  const server = createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    hits.push(path);
    if (path === '/json/version') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not a browser' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  try {
    const port = await listen(server);
    writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify({ port, chromePort: port }));
    const { stdout } = await runDoctor(home);
    assert.ok(hits.includes('/json/version'), 'doctor never requested /json/version');
    assert.match(stdout, new RegExp(`127\\.0\\.0\\.1:${port}: NOT REACHABLE`));
    assert.doesNotMatch(stdout, new RegExp(`127\\.0\\.0\\.1:${port}: ok`));
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    if (home.startsWith(tmpdir())) rmSync(home, { recursive: true, force: true });
  }
});
