// tests/muse1103_test_bin_ego_browser.test.mjs
// Focused unit tests for bin/ego-browser.js edge/error paths.
//
// Run: node --test tests/muse1103_test_bin_ego_browser.test.mjs
//
// Conventions follow nearby tests (fmb_w11_s01 / fmb_w12_s01 /
// ego_browser_launcher_failure_exit_code): spawnSync the CLI with an
// isolated HOME under tmpdir(), use obviously-fake values, touch no real
// daemon/browser/service, and clean up temp dirs in after().
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';

const CLI = fileURLToPath(new URL('../bin/ego-browser.js', import.meta.url));
const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// Isolated HOME with a harmless fake launcher: if the CLI ever walks into
// ensureRunning()'s auto-start path, it only runs `exit 0` and prints MARKER,
// so the test can prove the auto-start path was (not) taken.
const MARKER = 'MUSE1103_FAKE_LAUNCHER_RAN';
function fakeHome() {
  const root = mkdtempSync(join(tmpdir(), 'muse1103-ego-browser-'));
  roots.push(root);
  const scripts = join(root, '.local', 'share', 'ego-linux', 'app', 'scripts');
  mkdirSync(scripts, { recursive: true });
  for (const name of ['tp-start.sh', 'tp-stop.sh']) {
    writeFileSync(join(scripts, name), `#!/bin/sh\necho "${MARKER}" >&2\nexit 0\n`, { mode: 0o755 });
  }
  return root;
}

function envFor(home, extra = {}) {
  return { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: home, ...extra };
}

// A loopback port with nothing listening on it: /health fails fast with
// ECONNREFUSED instead of waiting out the 2.5s fetch timeout.
function closedLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function run(args, { home, envExtra = {}, input = '' } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    env: envFor(home, envExtra),
    input,
  });
}

test('nodejs --eval: unknown dash option is rejected as a usage error before touching stdin/daemon', () => {
  const home = fakeHome();
  // Empty stdin: without the guard the CLI would fall into the stdin branch
  // and misreport this as "the script is empty".
  const r = run(['nodejs', '--eval', 'console.log(1)'], { home, input: '' });
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}; stderr=${r.stderr}`);
  assert.match(r.stderr, /unknown option --eval/);
  assert.doesNotMatch(r.stderr, /script is empty/);
  // Must fail before any daemon contact or launcher run.
  assert.doesNotMatch(r.stderr, /not reachable/);
  assert.doesNotMatch(r.stderr, /127\.0\.0\.1/);
  assert.doesNotMatch(r.stderr, new RegExp(MARKER));
  assert.doesNotMatch(r.stdout, /1/);
});

test('nodejs -x: single-dash unknown option is rejected the same way', () => {
  const home = fakeHome();
  const r = run(['nodejs', '-x', 'console.log(1)'], { home, input: '' });
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}; stderr=${r.stderr}`);
  assert.match(r.stderr, /unknown option -x/);
  assert.doesNotMatch(r.stderr, new RegExp(MARKER));
});

test("nodejs -e '   ': whitespace-only script is a usage error, not a silent success", () => {
  const home = fakeHome();
  const r = run(['nodejs', '-e', '  \n\t\n '], { home });
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}; stderr=${r.stderr}`);
  assert.match(r.stderr, /script is empty/);
  assert.doesNotMatch(r.stderr, /not reachable/);
  assert.doesNotMatch(r.stderr, new RegExp(MARKER));
  assert.equal(r.stdout, '');
});

test('nodejs -e with BOM-only script is a usage error', () => {
  const home = fakeHome();
  const r = run(['nodejs', '-e', '﻿'], { home });
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}; stderr=${r.stderr}`);
  assert.match(r.stderr, /script is empty/);
  assert.doesNotMatch(r.stderr, new RegExp(MARKER));
});

test('status against a closed port exits 2 with a not-reachable error', async () => {
  const home = fakeHome();
  const port = await closedLoopbackPort();
  const r = run(['status'], { home, envExtra: { TP_DAEMON_PORT: String(port) } });
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}; stderr=${r.stderr}`);
  assert.match(r.stderr, /is not reachable/);
  assert.match(r.stderr, new RegExp(`127\\.0\\.0\\.1:${port}`));
  assert.equal(r.stdout, '');
});

test('doctor with nothing listening reports NOT RUNNING plus fix hints and exits 0', async () => {
  const home = fakeHome();
  const port = await closedLoopbackPort();
  const chromePort = await closedLoopbackPort();
  // daemon.json is the launcher-written port source; TP_DAEMON_PORT left
  // unset so readPort()/readChromePort() take these closed ports.
  const dataDir = join(home, '.local', 'share', 'ego-linux');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify({ port, chromePort }), 'utf8');
  const env = envFor(home);
  delete env.TP_DAEMON_PORT;
  const r = spawnSync(process.execPath, [CLI, 'doctor'], {
    encoding: 'utf8',
    timeout: 30_000,
    env,
    input: '',
  });
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
  assert.match(r.stdout, new RegExp(`daemon  127\\.0\\.0\\.1:${port}: NOT RUNNING`));
  assert.match(r.stdout, new RegExp(`chrome  127\\.0\\.0\\.1:${chromePort}: NOT REACHABLE`));
  assert.match(r.stdout, /fix:/);
});

test('skill prints the bundled SKILL.md guide and exits 0', () => {
  const home = fakeHome();
  const r = run(['skill'], { home });
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr=${r.stderr}`);
  assert.match(r.stdout, /tp-browser/);
  assert.ok(r.stdout.length > 500, `SKILL output suspiciously short: ${r.stdout.length} chars`);
});
