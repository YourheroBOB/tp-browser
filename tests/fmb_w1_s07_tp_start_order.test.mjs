import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accessSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/tp-start.sh', import.meta.url));
const COREUTILS = ['dirname', 'mkdir', 'chmod', 'rm', 'grep', 'pwd', 'id', 'sh'];

function findExecutable(name) {
  for (const dir of ['/usr/bin', '/bin']) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate);
      return candidate;
    } catch {
      // Continue checking next location
    }
  }
  throw new Error(`required system utility not found: ${name}`);
}

function makeSandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'fmb-w1-s07-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const pkillLog = join(root, 'pkill.log');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(pkillLog, '');

  for (const name of COREUTILS) {
    try {
      symlinkSync(findExecutable(name), join(bin, name));
    } catch {
      // Optional if already handled by shell builtin
    }
  }

  const stubs = {
    curl: '#!/bin/sh\nexit 22\n',
    pkill: '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$PKILL_LOG"\nexit 0\n',
    sleep: '#!/bin/sh\nexit 0\n',
    node: '#!/bin/sh\nexit 0\n',
    uname: '#!/bin/sh\nprintf \'Linux\\n\'\n',
  };
  for (const [name, contents] of Object.entries(stubs)) {
    const path = join(bin, name);
    writeFileSync(path, contents, { mode: 0o755 });
    chmodSync(path, 0o755);
  }

  return { root, home, bin, pkillLog };
}

function runStart(sandbox, browserBin) {
  const env = {
    HOME: sandbox.home,
    PATH: sandbox.bin,
    PKILL_LOG: sandbox.pkillLog,
  };
  if (browserBin) env.TP_BROWSER_BIN = browserBin;

  return spawnSync('/bin/sh', [SCRIPT, '--restart'], {
    encoding: 'utf8',
    timeout: 5000,
    env,
  });
}

test(
  'tp-start exits 1 without stopping processes when no browser executable is found',
  { skip: process.platform === 'win32' },
  (t) => {
    const sandbox = makeSandbox(t);
    const result = runStart(sandbox);

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /No Chrome/);
    assert.equal(readFileSync(sandbox.pkillLog, 'utf8'), '');
  },
);

test(
  'tp-start invokes pkill only after a valid TP_BROWSER_BIN is confirmed',
  { skip: process.platform === 'win32' },
  (t) => {
    const sandbox = makeSandbox(t);
    const browserBin = join(sandbox.root, 'fake-browser');
    writeFileSync(browserBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    chmodSync(browserBin, 0o755);

    const result = runStart(sandbox, browserBin);
    const pkillCalls = readFileSync(sandbox.pkillLog, 'utf8').trim();

    assert.notEqual(result.status, null, 'tp-start should finish within the test timeout');
    assert.notEqual(pkillCalls, '');
  },
);
