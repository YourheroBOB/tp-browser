import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const startScript = path.join(repoRoot, 'scripts', 'tp-start.sh');

function writeExec(filePath, content) {
  writeFileSync(filePath, content, { mode: 0o755 });
  chmodSync(filePath, 0o755);
}

function readText(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
}

function makeCase({ alwaysAlive }) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'tp-start-s09-'));
  const home = path.join(tmp, 'home');
  const externalDataDir = path.join(tmp, 'external-data');
  const fakeBin = path.join(tmp, 'bin');
  const recordDir = path.join(tmp, 'record');
  const fakeBrowser = path.join(fakeBin, 'fake-browser');
  const profileDir = path.join(home, '.local/share/ego-linux/profile-agent');
  const lockPath = path.join(profileDir, 'SingletonLock');

  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(recordDir, { recursive: true });
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(lockPath, 'FAKE_VALUE_FOR_TEST\n');

  writeExec(path.join(fakeBin, 'pgrep'), `#!/bin/sh
if [ "\${FAKE_PGREP_ALWAYS_ALIVE:-0}" = "1" ]; then
  exit 0
fi
exit 1
`);

  writeExec(path.join(fakeBin, 'pkill'), `#!/bin/sh
REC="\${FAKE_RECORD_DIR:?}"
printf '%s\\n' "$*" >> "$REC/pkill.args"
exit 1
`);

  writeExec(path.join(fakeBin, 'sleep'), '#!/bin/sh\nexit 0\n');

  writeExec(path.join(fakeBin, 'curl'), `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    */health) printf '%s\\n' '{"ok":true,"chrome":true}'; exit 0 ;;
  esac
done
exit 1
`);

  writeExec(fakeBrowser, `#!/bin/sh
REC="\${FAKE_RECORD_DIR:?}"
for arg in "$@"; do
  printf '%s\\n' "$arg" >> "$REC/browser.args"
done
exit 0
`);

  writeExec(path.join(fakeBin, 'node'), `#!/bin/sh
REC="\${FAKE_RECORD_DIR:?}"
case "$1" in
  *tools/profile-init.js)
    printf '%s\\n' "\${EGO_LINUX_DATA_DIR-UNSET}" >> "$REC/profile-init.env"
    printf '%s\\n' "$*" >> "$REC/profile-init.args"
    exit 0
    ;;
  -e)
    shift 2
    shift
    printf '%s\\n' "$*" >> "$REC/spawn.args"
    if [ "\${1:-}" = "\${FAKE_BROWSER_BIN:-}" ]; then
      "$@" >> "$REC/browser.log" 2>&1
    fi
    exit 0
    ;;
esac
exec "\${REAL_NODE:-node}" "$@"
`);

  const env = {
    ...process.env,
    HOME: home,
    PATH: [fakeBin, process.env.PATH].filter(Boolean).join(':'),
    EGO_LINUX_DATA_DIR: externalDataDir,
    TP_BROWSER_BIN: fakeBrowser,
    FAKE_RECORD_DIR: recordDir,
    REAL_NODE: process.execPath,
    FAKE_BROWSER_BIN: fakeBrowser,
    FAKE_PGREP_ALWAYS_ALIVE: alwaysAlive ? '1' : '0',
  };

  return { tmp, home, externalDataDir, fakeBin, recordDir, fakeBrowser, profileDir, lockPath, env };
}

function runStart(env) {
  return spawnSync('sh', [startScript, '--restart'], {
    env,
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 30000,
  });
}

test('fmb_w7_s09: SIGKILL 後仍殘留時不刪 SingletonLock、不啟動', (t) => {
  const ctx = makeCase({ alwaysAlive: true });
  t.after(() => rmSync(ctx.tmp, { recursive: true, force: true }));

  const result = runStart(ctx.env);
  assert.equal(result.status, 1, `expected exit 1\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stderr, /TP_NOT_READY \(profile still in use\)/);
  assert.ok(existsSync(ctx.lockPath), 'SingletonLock must not be deleted when profile is still in use');
  assert.ok(!existsSync(path.join(ctx.recordDir, 'spawn.args')), 'daemon/browser must not be launched');
  assert.ok(!existsSync(path.join(ctx.recordDir, 'browser.args')), 'browser must not be launched');
  assert.ok(!existsSync(path.join(ctx.recordDir, 'profile-init.env')), 'profile-init must not run');
  assert.ok(readText(path.join(ctx.recordDir, 'pkill.args')).includes('-9'), 'expected pkill -9 before giving up');
});

test('fmb_w7_s09: profile-init 使用 tp-start 的 DATA_DIR，正常路徑照常啟動', (t) => {
  const ctx = makeCase({ alwaysAlive: false });
  t.after(() => rmSync(ctx.tmp, { recursive: true, force: true }));

  const result = runStart(ctx.env);
  assert.equal(result.status, 0, `expected exit 0\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /TP_READY/);

  const profileInitEnv = readText(path.join(ctx.recordDir, 'profile-init.env')).trim();
  assert.equal(profileInitEnv, path.join(ctx.home, '.local/share/ego-linux'));

  const spawnLog = readText(path.join(ctx.recordDir, 'spawn.args'));
  assert.match(spawnLog, /ego-browserd\.js/);
  assert.ok(spawnLog.includes(ctx.fakeBrowser), 'fake browser should be launched');

  const browserArgs = readText(path.join(ctx.recordDir, 'browser.args')).split('\n');
  assert.ok(browserArgs.includes(`--user-data-dir=${ctx.profileDir}`), 'browser must use the same profile as tp-start');
  assert.ok(!browserArgs.some((arg) => arg.includes(ctx.externalDataDir)), 'browser must not use external EGO_LINUX_DATA_DIR profile');
  assert.ok(!existsSync(ctx.lockPath), 'SingletonLock should be removed on the normal path');
});
