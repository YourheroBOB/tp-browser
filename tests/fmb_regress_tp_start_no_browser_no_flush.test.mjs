// Regression: tp-start.sh must discover a browser before flush/pkill.
// With no Chrome/Chromium/Edge/Brave on PATH it has to exit 1 and leave any
// already-running daemon alone. These tests never pass --headed (that path
// can delegate to another OS) and never inherit TP_BROWSER_BIN.
// curl / pkill / pgrep / sleep / node are stubs. PATH contains only stubs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const startScript = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'tp-start.sh');

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

function runStart(args) {
  const home = mkdtempSync(join(tmpdir(), 'fmb-regress-tp-start-'));
  const bin = join(home, 'bin');
  const logDir = join(home, 'logs');
  mkdirSync(bin, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  const logs = {
    curl: join(logDir, 'curl.txt'),
    pkill: join(logDir, 'pkill.txt'),
    pgrep: join(logDir, 'pgrep.txt'),
    sleep: join(logDir, 'sleep.txt'),
    node: join(logDir, 'node.txt'),
    ps: join(logDir, 'ps.txt'),
  };
  for (const log of Object.values(logs)) writeFileSync(log, '');
  for (const name of ['dirname', 'mkdir', 'chmod', 'grep', 'sed', 'rm']) writeDelegate(bin, name);
  writeExec(bin, 'uname', '#!/bin/sh\necho Linux\nexit 0\n');
  writeLogger(bin, 'curl', 'TP_TEST_CURL_LOG', 1);
  writeLogger(bin, 'pkill', 'TP_TEST_PKILL_LOG', 0);
  writeLogger(bin, 'pgrep', 'TP_TEST_PGREP_LOG', 1);
  writeLogger(bin, 'sleep', 'TP_TEST_SLEEP_LOG', 0);
  writeLogger(bin, 'node', 'TP_TEST_NODE_LOG', 99);
  writeLogger(bin, 'ps', 'TP_TEST_PS_LOG', 0);
  let result;
  try {
    result = spawnSync('/bin/sh', [startScript, ...args], {
      encoding: 'utf8',
      timeout: 8000,
      cwd: home,
      env: {
        HOME: home,
        PATH: bin,
        TMPDIR: home,
        LC_ALL: 'C',
        TP_TEST_CURL_LOG: logs.curl,
        TP_TEST_PKILL_LOG: logs.pkill,
        TP_TEST_PGREP_LOG: logs.pgrep,
        TP_TEST_SLEEP_LOG: logs.sleep,
        TP_TEST_NODE_LOG: logs.node,
        TP_TEST_PS_LOG: logs.ps,
      },
    });
    const read = (path) => readFileSync(path, 'utf8').split('\n').filter(Boolean);
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      error: result.error,
      curls: read(logs.curl),
      pkills: read(logs.pkill),
      pgreps: read(logs.pgrep),
      sleeps: read(logs.sleep),
      nodes: read(logs.node),
      ps: read(logs.ps),
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function assertNoDestructiveAction(result) {
  assert.equal(result.error, undefined);
  assert.equal(
    result.status,
    1,
    `stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`,
  );
  assert.match(result.stderr, /No Chrome\/Chromium\/Edge\/Brave binary found/);
  assert.equal(result.stdout.includes('TP_READY'), false);
  assert.equal(result.stdout.includes('TP_NOT_READY'), false);
  assert.deepEqual(result.pkills, []);
  assert.deepEqual(result.pgreps, []);
  assert.deepEqual(result.sleeps, []);
  assert.deepEqual(result.nodes, []);
  assert.deepEqual(result.ps, []);
  for (const line of result.curls) {
    assert.equal(line.includes('flush-and-close'), false, line);
    assert.match(line, /127\.0\.0\.1/);
  }
}

test('--restart with no browser exits before flush, pkill, or launch', () => {
  const result = runStart(['--restart']);
  assertNoDestructiveAction(result);
  assert.deepEqual(result.curls, []);
});

test('a health probe is allowed, but a missing browser still does not flush', () => {
  const result = runStart([]);
  assertNoDestructiveAction(result);
  assert.equal(result.curls.length, 1);
  assert.match(result.curls[0], /http:\/\/127\.0\.0\.1:9772\/health/);
});

test('--alt-port health probe uses 9774 and still does not flush', () => {
  const result = runStart(['--alt-port']);
  assertNoDestructiveAction(result);
  assert.equal(result.curls.length, 1);
  assert.match(result.curls[0], /http:\/\/127\.0\.0\.1:9774\/health/);
  assert.equal(result.curls[0].includes('9772'), false);
  assert.equal(result.curls[0].includes('flush-and-close'), false);
});
