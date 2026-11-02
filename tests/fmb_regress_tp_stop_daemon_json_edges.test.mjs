// Regression: tp-stop.sh parses daemon.json with sed under `set -e`.
// A damaged, quoted, or out-of-range port used to be able to abort the stop
// before anything was flushed. chromePort must not be treated as the daemon
// port. Leading zeros are stripped so the range check sees the real number.
// curl / pkill / pgrep / sleep are stubs on an isolated PATH and HOME.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const stopScript = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'tp-stop.sh');

function writeExec(dir, name, body) {
  const path = join(dir, name);
  writeFileSync(path, body.endsWith('\n') ? body : `${body}\n`);
  chmodSync(path, 0o755);
}

function writeDelegate(bin, name) {
  writeExec(bin, name, `#!/bin/sh
for c in /bin/${name} /usr/bin/${name}; do
  if [ -x "$c" ]; then
    exec "$c" "$@"
  fi
done
echo "missing ${name}" >&2
exit 127
`);
}

function writeLogger(bin, name, logVar, code) {
  writeExec(bin, name, `#!/bin/sh
if [ -n "$${logVar}" ]; then
  printf '%s\\n' "$*" >> "$${logVar}"
fi
exit ${code}
`);
}

function flushPorts(curls) {
  const ports = [];
  for (const line of curls) {
    const match = line.match(/http:\/\/127\.0\.0\.1:(\d+)\/flush-and-close/);
    assert.ok(match, `unexpected curl invocation: ${line}`);
    ports.push(match[1]);
  }
  return ports;
}

function runStop(daemonJson) {
  const home = mkdtempSync(join(tmpdir(), 'fmb-regress-tp-stop-'));
  const bin = join(home, 'bin');
  const logDir = join(home, 'logs');
  mkdirSync(bin, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  const curlLog = join(logDir, 'curl.txt');
  const pkillLog = join(logDir, 'pkill.txt');
  const pgrepLog = join(logDir, 'pgrep.txt');
  const sleepLog = join(logDir, 'sleep.txt');
  for (const log of [curlLog, pkillLog, pgrepLog, sleepLog]) writeFileSync(log, '');
  writeDelegate(bin, 'sed');
  writeLogger(bin, 'curl', 'TP_TEST_CURL_LOG', 1);
  writeLogger(bin, 'pkill', 'TP_TEST_PKILL_LOG', 0);
  writeLogger(bin, 'pgrep', 'TP_TEST_PGREP_LOG', 1);
  writeLogger(bin, 'sleep', 'TP_TEST_SLEEP_LOG', 0);
  if (daemonJson !== null && daemonJson !== undefined) {
    const dataDir = join(home, '.local', 'share', 'ego-linux');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'daemon.json'), daemonJson);
  }
  let result;
  try {
    result = spawnSync('/bin/sh', [stopScript], {
      encoding: 'utf8',
      timeout: 8000,
      cwd: home,
      env: {
        HOME: home,
        PATH: bin,
        TMPDIR: home,
        LC_ALL: 'C',
        TP_TEST_CURL_LOG: curlLog,
        TP_TEST_PKILL_LOG: pkillLog,
        TP_TEST_PGREP_LOG: pgrepLog,
        TP_TEST_SLEEP_LOG: sleepLog,
      },
    });
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      error: result.error,
      curls: readFileSync(curlLog, 'utf8').split('\n').filter(Boolean),
      pkills: readFileSync(pkillLog, 'utf8').split('\n').filter(Boolean),
      pgreps: readFileSync(pgrepLog, 'utf8').split('\n').filter(Boolean),
      sleeps: readFileSync(sleepLog, 'utf8').split('\n').filter(Boolean),
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function assertStopped(daemonJson, ports) {
  const result = runStop(daemonJson);
  assert.equal(result.error, undefined);
  assert.equal(
    result.status,
    0,
    `stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`,
  );
  assert.equal(result.stdout.trim(), 'TP_STOPPED');
  assert.equal(result.stderr.trim(), '');
  assert.deepEqual(flushPorts(result.curls), ports);
  assert.ok(result.pkills.length > 0, 'pkill stub was not used');
  assert.ok(result.pgreps.length > 0, 'pgrep stub was not used');
  assert.ok(result.sleeps.length > 0, 'stop returned before the flush wait');
}

test('damaged or non-numeric daemon.json still stops and flushes only the defaults', () => {
  const samples = [
    'this is not json',
    '{',
    '',
    '{ "port": "18802" }',
    '{ "port": -1 }',
    '{ "port": nope }',
    '{ "chromePort": 18800 }',
  ];
  for (const sample of samples) {
    assertStopped(sample, ['9772', '9774']);
  }
});

test('out-of-range ports are ignored and do not abort the stop', () => {
  for (const sample of ['{ "port": 0 }', '{ "port": 000 }', '{ "port": 65536 }', '{ "port": 100000 }']) {
    assertStopped(sample, ['9772', '9774']);
  }
});

test('boundary ports 1 and 65535 are flushed with the defaults', () => {
  assertStopped('{ "port": 1 }', ['9772', '9774', '1']);
  assertStopped('{ "port": 65535 }', ['9772', '9774', '65535']);
});

test('chromePort is not flushed; a spaced port key is', () => {
  assertStopped(
    '{ "chromePort" : 18800, "port" : 18802 }',
    ['9772', '9774', '18802'],
  );
});

test('leading zeros are stripped before the range check and 9772 is not flushed twice', () => {
  assertStopped('{ "port": 0018802, "chromePort": 18800 }', ['9772', '9774', '18802']);
  assertStopped('{ "port": 09772 }', ['9772', '9774']);
  assertStopped('{ "port": 09774 }', ['9772', '9774']);
});
