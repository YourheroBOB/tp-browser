// 回歸 tp-stop.sh（只打到 PATH 上的假 curl／pkill／pgrep／sleep，不連網、不殺真程序）：
// 1. daemon.json 的 port 若帶前導零（018802、0009772），算術比較在部分 sh 會把
//    前導零當八進位，數字 8／9 直接讓 set -e 中止，pkill 根本沒送出。
//    sed 必須先去掉前導零；0009772 正規化後就是預設埠，不可再 flush 一次。
// 2. 超出 1..65535、長度超過 5、或根本不是埠的 daemon.json，不可中止停止流程。
// 3. pgrep 結束碼 >= 2 不是「已經沒有程序」。不可印 TP_STOPPED。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, accessSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const skipWin = process.platform === 'win32' ? 'POSIX launcher; skipped on win32' : false;
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const stopScript = join(repoRoot, 'scripts', 'tp-stop.sh');

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

function makeBin(dir, pgrepExit) {
  const bin = join(dir, 'bin');
  const logDir = join(dir, 'log');
  mkdirSync(bin, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  const curlLog = join(logDir, 'curl.log');
  const pkillLog = join(logDir, 'pkill.log');
  const pgrepLog = join(logDir, 'pgrep.log');
  writeExec(join(bin, 'curl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shellQuote(curlLog)}\nexit 22\n`);
  writeExec(join(bin, 'pkill'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shellQuote(pkillLog)}\nexit 0\n`);
  writeExec(join(bin, 'pgrep'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shellQuote(pgrepLog)}\nexit ${pgrepExit}\n`);
  writeExec(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
  return { bin, curlLog, pkillLog, pgrepLog };
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
  for (const name of ['curl', 'pkill', 'pgrep', 'sleep']) {
    const which = spawnSync(SH, ['-c', `command -v ${name}`], {
      encoding: 'utf8',
      env: { PATH: path, HOME: '/tmp' },
    });
    assert.equal(which.status, 0, `command -v ${name} failed: ${which.stderr}`);
    assert.equal(which.stdout.trim(), join(bin, name));
  }
}

function runStop(home, bin) {
  assertMocksFirst(bin);
  return spawnSync(SH, [stopScript], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      LANG: 'C',
      LC_ALL: 'C',
    },
  });
}

function prepare(t, daemonBody, pgrepExit = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-regress-tpstop-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const data = join(home, '.local', 'share', 'ego-linux');
  mkdirSync(data, { recursive: true });
  if (daemonBody !== undefined) writeFileSync(join(data, 'daemon.json'), daemonBody);
  const logs = makeBin(dir, pgrepExit);
  return { home, ...logs };
}

function assertStopped(result) {
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /^TP_STOPPED$/m);
  assert.doesNotMatch(result.stdout, /TP_STOP_FAILED/);
}

test('leading-zero port 018802 is flushed as 18802 and stop still completes', { skip: skipWin }, (t) => {
  const ctx = prepare(t, '{"port":018802}\n');
  const result = runStop(ctx.home, ctx.bin);
  assertStopped(result);
  const curl = readLog(ctx.curlLog);
  assert.equal(countFlush(curl, 18802), 1);
  assert.equal(countFlush(curl, '018802'), 0);
  assert.equal(countFlush(curl, 9772), 1);
  assert.equal(countFlush(curl, 9774), 1);
  // esc_regex 先把 '.' 寫成 '\.'，pkill -f 才不會把檔名裡的點當成任意字元。
  assert.match(readLog(ctx.pkillLog), /ego-browserd\\\.js/);
  assert.match(readLog(ctx.pkillLog), /tp-browserd\\\.js/);
});

test('leading zeros that normalize to a default port are not flushed twice', { skip: skipWin }, (t) => {
  const ctx = prepare(t, '{"port":0009772}\n');
  const result = runStop(ctx.home, ctx.bin);
  assertStopped(result);
  const curl = readLog(ctx.curlLog);
  assert.equal(countFlush(curl, 9772), 1);
  assert.equal(countFlush(curl, 9774), 1);
  assert.equal(countFlush(curl, '0009772'), 0);
  assert.match(readLog(ctx.pkillLog), /ego-browserd\\\.js/);
});

test('out-of-range and overlong ports are ignored and do not abort stop', { skip: skipWin }, (t) => {
  for (const body of ['{"port":0}\n', '{"port":65536}\n', '{"port":70000}\n', '{"port":123456}\n']) {
    const ctx = prepare(t, body);
    const result = runStop(ctx.home, ctx.bin);
    assertStopped(result);
    const curl = readLog(ctx.curlLog);
    assert.equal(countFlush(curl, 9772), 1, body);
    assert.equal(countFlush(curl, 9774), 1, body);
    assert.equal(countFlush(curl, 0), 0, body);
    assert.equal(countFlush(curl, 65536), 0, body);
    assert.equal(countFlush(curl, 70000), 0, body);
    assert.equal(countFlush(curl, 123456), 0, body);
    assert.match(readLog(ctx.pkillLog), /ego-browserd\\\.js/);
  }
});

test('upper bound port 65535 is flushed once', { skip: skipWin }, (t) => {
  const ctx = prepare(t, '{"port":65535}\n');
  const result = runStop(ctx.home, ctx.bin);
  assertStopped(result);
  const curl = readLog(ctx.curlLog);
  assert.equal(countFlush(curl, 65535), 1);
  assert.equal(countFlush(curl, 9772), 1);
  assert.equal(countFlush(curl, 9774), 1);
});

test('unparsable daemon.json still stops the default ports', { skip: skipWin }, (t) => {
  const ctx = prepare(t, '{{{not-json\n');
  const result = runStop(ctx.home, ctx.bin);
  assertStopped(result);
  const curl = readLog(ctx.curlLog);
  assert.equal(countFlush(curl, 9772), 1);
  assert.equal(countFlush(curl, 9774), 1);
  assert.match(curl, /127\.0\.0\.1/);
  assert.equal(curl.split('\n').filter(Boolean).every((line) => line.includes('127.0.0.1')), true);
});

test('pgrep exit 2 is not reported as TP_STOPPED', { skip: skipWin }, (t) => {
  const ctx = prepare(t, undefined, 2);
  const result = runStop(ctx.home, ctx.bin);
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stdout, /^TP_STOP_FAILED$/m);
  assert.doesNotMatch(result.stdout, /^TP_STOPPED$/m);
  assert.match(result.stderr, /refusing to report success/);
  const pkill = readLog(ctx.pkillLog);
  assert.match(pkill, /ego-browserd\\\.js/);
  assert.doesNotMatch(pkill, /(^|\s)-9(\s|$)/m);
});
