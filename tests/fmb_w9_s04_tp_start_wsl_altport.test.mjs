// Regression for: tp-start.sh --headed under WSL2 delegated to Windows
// ego-start.ps1 but dropped --alt-port, so the Windows daemon started on
// 9772/9773 (or its own 9773-derived group) instead of the requested
// 9774/9775 — and that wrong daemon.json was copied back to Linux.
//
// Everything lives under mkdtempSync(tmpdir()): a fake /proc/version source, a
// fake powershell.exe that only records its argv, and a fake Windows Users tree.
// HOME is redirected into the temp dir. No network, no real credentials
// (FAKE_VALUE_FOR_TEST only), nothing written outside the temp dir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const TP_START = path.join(REPO_ROOT, 'scripts', 'tp-start.sh');

const WIN_SCRIPT = 'C:\\Users\\alice\\.local\\share\\ego-linux\\scripts\\ego-start.ps1';
const BASE_ARGS = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WIN_SCRIPT, '-Headed'];

function scaffold() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fmb-w9-s04-'));
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });

  const usersRoot = path.join(tmp, 'users');
  const egoDir = path.join(usersRoot, 'alice', '.local', 'share', 'ego-linux');
  fs.mkdirSync(path.join(egoDir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(egoDir, 'scripts', 'ego-start.ps1'), '# FAKE_VALUE_FOR_TEST\n');

  const versionFile = path.join(tmp, 'proc-version');
  fs.writeFileSync(versionFile, 'Linux version 6.6.9-microsoft-standard-WSL2 (x86_64)\n');

  const psPath = path.join(tmp, 'fake-powershell.exe');
  const argsLog = path.join(tmp, 'ps-argv.log');
  const quotedLog = JSON.stringify(argsLog);
  fs.writeFileSync(
    psPath,
    [
      '#!/bin/sh',
      `: > ${quotedLog}`,
      `for a in "$@"; do printf '%s\\n' "$a" >> ${quotedLog}; done`,
      'exit 0',
      '',
    ].join('\n')
  );
  fs.chmodSync(psPath, 0o755);

  return { tmp, home, usersRoot, egoDir, versionFile, psPath, argsLog };
}

function runTpStart(scaf, flags, extraEnv = {}) {
  return spawnSync('sh', [TP_START, ...flags], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: scaf.home,
      TP_START_PROC_VERSION: scaf.versionFile,
      TP_START_WIN_PS: scaf.psPath,
      TP_START_WIN_USERS: scaf.usersRoot,
      ...extraEnv,
    },
  });
}

function recordedArgs(scaf) {
  if (!fs.existsSync(scaf.argsLog)) return null;
  const lines = fs.readFileSync(scaf.argsLog, 'utf8').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const DELEGATION_CASES = [
  { name: 'headed', flags: ['--headed'], expected: [...BASE_ARGS] },
  { name: 'headed + alt-port', flags: ['--headed', '--alt-port'], expected: [...BASE_ARGS, '-AltPort'] },
  { name: 'headed + restart', flags: ['--headed', '--restart'], expected: [...BASE_ARGS, '-Restart'] },
  {
    name: 'headed + restart + alt-port',
    flags: ['--headed', '--restart', '--alt-port'],
    expected: [...BASE_ARGS, '-Restart', '-AltPort'],
  },
];

for (const c of DELEGATION_CASES) {
  test(`WSL2 delegation forwards exact flags: ${c.name}`, () => {
    const scaf = scaffold();
    try {
      const res = runTpStart(scaf, c.flags);
      assert.equal(res.status, 0, `stdout=${res.stdout} stderr=${res.stderr}`);
      assert.deepEqual(recordedArgs(scaf), c.expected);
    } finally {
      fs.rmSync(scaf.tmp, { recursive: true, force: true });
    }
  });
}

test('non-headed run never delegates to Windows powershell', () => {
  const scaf = scaffold();
  try {
    const bogusBin = path.join(scaf.tmp, 'no-such-browser');
    const res = runTpStart(scaf, ['--alt-port'], { TP_BROWSER_BIN: bogusBin });
    assert.equal(
      fs.existsSync(scaf.argsLog),
      false,
      'fake powershell.exe must not be invoked when --headed is absent'
    );
    assert.notEqual(res.status, 0, `stdout=${res.stdout} stderr=${res.stderr}`);
    assert.match(res.stderr, /TP_BROWSER_BIN/);
  } finally {
    fs.rmSync(scaf.tmp, { recursive: true, force: true });
  }
});

test('WSL2 delegation still copies daemon.json/token back with 0600', () => {
  const scaf = scaffold();
  try {
    const cfg = { port: 9774, chromePort: 9775, token: 'FAKE_VALUE_FOR_TEST' };
    fs.writeFileSync(path.join(scaf.egoDir, 'daemon.json'), `${JSON.stringify(cfg)}\n`);
    fs.writeFileSync(path.join(scaf.egoDir, 'token'), 'FAKE_VALUE_FOR_TEST\n');

    const res = runTpStart(scaf, ['--headed', '--restart', '--alt-port']);
    assert.equal(res.status, 0, `stdout=${res.stdout} stderr=${res.stderr}`);

    const dataDir = path.join(scaf.home, '.local', 'share', 'ego-linux');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'daemon.json'), 'utf8')), cfg);
    assert.equal(fs.statSync(path.join(dataDir, 'daemon.json')).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(path.join(dataDir, 'token'), 'utf8'), 'FAKE_VALUE_FOR_TEST\n');
    assert.equal(fs.statSync(path.join(dataDir, 'token')).mode & 0o777, 0o600);
    assert.deepEqual(recordedArgs(scaf), [...BASE_ARGS, '-Restart', '-AltPort']);
  } finally {
    fs.rmSync(scaf.tmp, { recursive: true, force: true });
  }
});
