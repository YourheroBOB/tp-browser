import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const CLI_PATH = fileURLToPath(new URL('../bin/tp-browser.js', import.meta.url));
const DAEMON_PORT = 9774;
const FAKE_TOKEN = 'FAKE_VALUE_FOR_TEST';

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
}

function runCli(args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI timed out: ${args.join(' ')}`));
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

test('CLI uses isolated daemon files and reports RPC errors', async (t) => {
  const requests = [];
  let rpcShouldFail = false;

  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, chrome: true }));
      return;
    }

    if (req.method === 'POST' && req.url === '/rpc') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push({
        body,
        tpToken: req.headers['x-tp-token'],
        egoToken: req.headers['x-ego-token'],
      });

      const result = rpcShouldFail
        ? { ok: false, error: { name: 'IntegrationFixtureError', message: 'fake RPC failure' } }
        : { ok: true, result: [{ id: 42, name: 'fixture-space' }] };

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  try {
    await listen(server, DAEMON_PORT);
  } catch (error) {
    if (error.code === 'EADDRINUSE') {
      t.skip(`127.0.0.1:${DAEMON_PORT} is already in use; avoiding requests to an unrelated local service`);
      return;
    }
    throw error;
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'tp-browser-fmb-integration-'));
  try {
    const dataDir = join(tempRoot, '.local', 'share', 'ego-linux');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, 'daemon.json'),
      JSON.stringify({ port: DAEMON_PORT, chromePort: 9775 }),
      'utf8',
    );
    writeFileSync(join(dataDir, 'token'), FAKE_TOKEN, { encoding: 'utf8', mode: 0o600 });

    const env = {
      PATH: process.env.PATH ?? '',
      HOME: tempRoot,
      USERPROFILE: tempRoot,
      TMPDIR: tempRoot,
      TEMP: tempRoot,
      TMP: tempRoot,
    };
    for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
      if (process.env[key]) env[key] = process.env[key];
    }

    const status = await runCli(['status'], tempRoot, env);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /"ok": true/);
    assert.match(status.stdout, /"chrome": true/);

    const spaces = await runCli(['spaces'], tempRoot, env);
    assert.equal(spaces.code, 0, spaces.stderr);
    assert.match(spaces.stdout, /fixture-space/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.method, 'space.list');
    assert.equal(requests[0].tpToken, FAKE_TOKEN);
    assert.equal(requests[0].egoToken, FAKE_TOKEN);

    rpcShouldFail = true;
    const failedSpaces = await runCli(['spaces'], tempRoot, env);
    assert.equal(failedSpaces.code, 1);
    assert.match(failedSpaces.stderr, /IntegrationFixtureError: fake RPC failure/);
    assert.equal(requests.length, 2);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
