import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/tp-browser.js', import.meta.url));

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function runDoctor(env) {
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
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

async function doctorAgainst(respondVersion) {
  const hits = [];
  const home = mkdtempSync(join(tmpdir(), 'tp-bug-doctor-'));
  const server = await listen((req, res) => {
    const path = (req.url || '').split('?')[0];
    hits.push(path);
    if (path === '/json/version') {
      respondVersion(res);
      return;
    }
    res.writeHead(404, { connection: 'close' });
    res.end();
  });
  try {
    const port = server.address().port;
    const data = join(home, '.local', 'share', 'ego-linux');
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'daemon.json'), JSON.stringify({ port, chromePort: port }));
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.TP_DAEMON_PORT;
    const result = await runDoctor(env);
    return { ...result, hits };
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  }
}

test('doctor does not treat HTTP 404 JSON that contains Browser as Chrome', async () => {
  const result = await doctorAgainst((res) => {
    res.writeHead(404, { 'content-type': 'application/json', connection: 'close' });
    res.end('{"Browser":"Chrome/9.9.9"}');
  });
  assert.ok(
    result.hits.includes('/json/version'),
    `doctor did not probe fake /json/version (hits: ${result.hits.join(' ')})`,
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /NOT REACHABLE/, result.stdout);
  assert.doesNotMatch(result.stdout, /Chrome\/9\.9\.9/);
});

test('doctor does not treat JSON without a Browser field as Chrome', async () => {
  const result = await doctorAgainst((res) => {
    res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
    res.end('{"ok":true}');
  });
  assert.ok(
    result.hits.includes('/json/version'),
    `doctor did not probe fake /json/version (hits: ${result.hits.join(' ')})`,
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /NOT REACHABLE/, result.stdout);
  assert.doesNotMatch(result.stdout, /ok \(undefined\)/);
});
