// tests/fmb_w9_s01_tp_stop_regex_path.test.mjs
// Regression for fmb wave 9 task s01: scripts/tp-stop.sh interpolated
// $PROFILE_DIR straight into pkill/pgrep patterns (extended regexes). A HOME
// containing '+' or an unclosed '[' made the literal path unmatchable — or made
// pgrep exit 2, which all_stopped treated as "no process left" — so the script
// printed TP_STOPPED while the agent Chrome was still alive.
// Zero network: curl is shimmed to a no-op; only tmpdir() paths are used.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const stopScript = join(repoRoot, 'scripts', 'tp-stop.sh');
const basePath = process.env.PATH ?? '';

const tempRoot = mkdtempSync(join(tmpdir(), 'fmb-w9-s01-tp-stop-'));
const curlShimDir = join(tempRoot, 'shim-curl');
const pgrepFailDir = join(tempRoot, 'shim-pgrep-fail');
mkdirSync(curlShimDir, { recursive: true });
mkdirSync(pgrepFailDir, { recursive: true });

// curl is a no-op so the run never touches 127.0.0.1:9772 / 9774.
writeFileSync(join(curlShimDir, 'curl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
// pgrep shim simulates a pattern/usage failure (procps exit code 2).
writeFileSync(join(pgrepFailDir, 'pgrep'), '#!/bin/sh\nexit 2\n', { mode: 0o755 });

const children = [];
after(() => {
  for (const child of children) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  rmSync(tempRoot, { recursive: true, force: true });
});

function makeHome(name) {
  const home = join(tempRoot, name);
  mkdirSync(join(home, '.local', 'share', 'ego-linux', 'profile-agent'), { recursive: true });
  return home;
}

function profileDirOf(home) {
  return join(home, '.local', 'share', 'ego-linux', 'profile-agent');
}

function startFakeAgentChrome(home) {
  const child = spawn(
    process.execPath,
    ['-e', 'setInterval(()=>{},1e3)', `--user-data-dir=${profileDirOf(home)}`],
    { stdio: 'ignore', detached: true },
  );
  child.unref();
  children.push(child);
  return child;
}

function waitAlive(child, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return true;
}

function waitExit(child, ms) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), ms);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}

function runStop(home, pathPrefix = '') {
  return spawnSync('sh', [stopScript], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${pathPrefix}${curlShimDir}:${basePath}`,
    },
  });
}

for (const homeName of ['a+b', 'a[b']) {
  test(`tp-stop terminates the agent Chrome and prints TP_STOPPED for HOME=${homeName}`, async () => {
    const home = makeHome(homeName);
    const chrome = startFakeAgentChrome(home);
    assert.ok(waitAlive(chrome, 5000), 'fake agent Chrome should be alive before tp-stop');

    const res = runStop(home);
    assert.equal(res.status, 0, `stdout=${res.stdout} stderr=${res.stderr}`);
    assert.match(res.stdout, /TP_STOPPED/);
    assert.ok(!res.stdout.includes('TP_STOP_FAILED'), res.stdout);
    assert.ok(await waitExit(chrome, 10_000), 'fake agent Chrome must be terminated by tp-stop');
  });
}

test('tp-stop does not print TP_STOPPED when pgrep itself fails (exit 2)', () => {
  const home = makeHome('plain');
  const res = runStop(home, `${pgrepFailDir}:`);
  assert.equal(res.status, 1, `stdout=${res.stdout} stderr=${res.stderr}`);
  assert.ok(!res.stdout.includes('TP_STOPPED'), res.stdout);
  assert.match(res.stdout, /TP_STOP_FAILED/);
});
