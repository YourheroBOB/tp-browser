// 回歸 tp-start.sh 的 flush 迴圈（假 curl／pkill／pgrep／node／sleep，不啟動真 daemon）：
// 只 flush 即將啟動的那一個埠時，另一組 9772／9774 的 Chrome 會在寫回 cookie 前被殺掉。
// 同時：daemon.json 裡用不成的埠（0、70000、壞 JSON）必須跳過，不可讓 set -e 中止，
// 也不可對同一個埠 flush 兩次。
// 故意不測前導零：tp-start.sh 的 sed 沒有先去掉前導零，那仍是未修的算術風險。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, accessSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const skipWin = process.platform === 'win32' ? 'POSIX launcher; skipped on win32' : false;
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const startScript = join(repoRoot, 'scripts', 'tp-start.sh');

function resolveSh() {
  for (const candidate of ['/bin/sh', '/usr/bin/sh']) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // try the next absolute path
    }
  }
  return 'sh';
}

const SH = resolveSh();

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function writeExec(path, body) {
  writeFileSync(path, body, { mode: 0o755 });
}

function makeBin(dir) {
  const bin = join(dir, 'bin');
  const logDir = join(dir, 'log');
  mkdirSync(bin, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  const curlLog = join(logDir, 'curl.log');
  const pkillLog = join(logDir, 'pkill.log');
  const nodeLog = join(logDir, 'node.log');
  writeExec(join(bin, 'curl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shellQuote(curlLog)}\ncase "$*" in\n  */health*) printf '%s\\n' '{"ok":true,"chrome":true}' ;;\nesac\nexit 0\n`);
  writeExec(join(bin, 'pkill'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shellQuote(pkillLog)}\nexit 0\n`);
  writeExec(join(bin, 'pgrep'), '#!/bin/sh\nexit 1\n');
  writeExec(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
  writeExec(join(bin, 'node'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shellQuote(nodeLog)}\nexit 0\n`);
  const browser = join(bin, 'fake-browser');
  writeExec(browser, '#!/bin/sh\nexit 0\n');
  return { bin, browser, curlLog, pkillLog, nodeLog };
}

function readLog(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function countFlush(log, port) {
  const needle = `http://127.0.0.1:${port}/flush-and-close`;
  return log.split('\n').filter((line) => line.includes(needle)).length;
}

function assertMocksFirst(bin) {
  const path = `${bin}:/usr/bin:/bin`;
  for (const name of ['curl', 'pkill', 'pgrep', 'sleep', 'node']) {
    const which = spawnSync(SH, ['-c', `command -v ${name}`], {
      encoding: 'utf8',
      env: { PATH: path, HOME: '/tmp' },
    });
    assert.equal(which.status, 0, `command -v ${name} failed: ${which.stderr}`);
    assert.equal(which.stdout.trim(), join(bin, name));
  }
}

function runStart(home, bin, browser, args) {
  assertMocksFirst(bin);
  return spawnSync(SH, [startScript, ...args], {
    encoding: 'utf8',
    timeout: 20000,
    cwd: home,
    env: {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      LANG: 'C',
      LC_ALL: 'C',
      TMPDIR: home,
      TP_BROWSER_BIN: browser,
    },
  });
}

function prepare(t, daemonBody) {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-regress-tpstart-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const data = join(home, '.local', 'share', 'ego-linux');
  mkdirSync(data, { recursive: true });
  if (daemonBody !== undefined) writeFileSync(join(data, 'daemon.json'), daemonBody);
  return { home, ...makeBin(dir) };
}

function assertReady(result, port) {
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, new RegExp(`TP_READY \\(port=${port}\\b`));
  assert.doesNotMatch(result.stdout, /TP_NOT_READY/);
  assert.doesNotMatch(result.stderr, /TP_NOT_READY/);
}

test('unusable daemon.json port 70000 is skipped while both default groups are flushed once', { skip: skipWin }, (t) => {
  const ctx = prepare(t, '{"port":70000}\n');
  const result = runStart(ctx.home, ctx.bin, ctx.browser, ['--restart']);
  assertReady(result, 9772);
  const curl = readLog(ctx.curlLog);
  assert.equal(countFlush(curl, 9772), 1);
  assert.equal(countFlush(curl, 9774), 1);
  assert.equal(countFlush(curl, 70000), 0);
  assert.match(readLog(ctx.pkillLog), /ego-browserd\.js/);
  assert.match(readLog(ctx.nodeLog), /profile-init\.js/);
  assert.match(readLog(ctx.nodeLog), /-e/);
  assert.equal(curl.split('\n').filter(Boolean).every((line) => line.includes('127.0.0.1')), true);
});

test('a daemon.json port already in the flush list is not requested twice', { skip: skipWin }, (t) => {
  const ctx = prepare(t, '{"port":9772}\n');
  const result = runStart(ctx.home, ctx.bin, ctx.browser, ['--restart']);
  assertReady(result, 9772);
  const curl = readLog(ctx.curlLog);
  assert.equal(countFlush(curl, 9772), 1);
  assert.equal(countFlush(curl, 9774), 1);
});

test('garbage daemon.json does not abort and still flushes both default ports', { skip: skipWin }, (t) => {
  const ctx = prepare(t, '{"port":\n');
  const result = runStart(ctx.home, ctx.bin, ctx.browser, ['--restart']);
  assertReady(result, 9772);
  const curl = readLog(ctx.curlLog);
  assert.equal(countFlush(curl, 9772), 1);
  assert.equal(countFlush(curl, 9774), 1);
  assert.match(readLog(ctx.pkillLog), /tp-browserd\.js/);
});

test('alt-port still flushes 9772 when daemon.json port is 0', { skip: skipWin }, (t) => {
  const ctx = prepare(t, '{"port":0}\n');
  const result = runStart(ctx.home, ctx.bin, ctx.browser, ['--restart', '--alt-port']);
  assertReady(result, 9774);
  const curl = readLog(ctx.curlLog);
  assert.equal(countFlush(curl, 9774), 1);
  assert.equal(countFlush(curl, 9772), 1);
  assert.equal(countFlush(curl, 0), 0);
  assert.equal(countFlush(curl, 9775), 0);
});
