// 回歸：scripts/tp-stop.sh 對 daemon.json 的寬鬆解析（前導零、超長、超範圍、
// 損壞檔不得中止 stop）以及 pgrep 失敗時不得回報 TP_STOPPED。
// curl／pkill／pgrep／sleep 都是 tmp 內的 shim，不會打到 127.0.0.1，也不會發訊號。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const tpStop = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'tp-stop.sh');

function writeShim(dir, name, body) {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function childPath(shim) {
  const base = process.env.PATH ? `${process.env.PATH}:/usr/bin:/bin` : '/usr/bin:/bin';
  return `${shim}:${base}`;
}

function flushedPorts(curlLog) {
  const text = existsSync(curlLog) ? readFileSync(curlLog, 'utf8') : '';
  const ports = [];
  for (const line of text.split('\n')) {
    const match = line.match(/127\.0\.0\.1:(\d+)\/flush-and-close/);
    if (match) ports.push(Number(match[1]));
  }
  return ports;
}

function runStop(json, pgrepExit) {
  const home = mkdtempSync(join(tmpdir(), 'fmb-regress-stop-'));
  const data = join(home, '.local', 'share', 'ego-linux');
  const shim = join(home, 'shim');
  mkdirSync(data, { recursive: true });
  mkdirSync(shim, { recursive: true });
  const curlLog = join(home, 'curl.log');
  const pkillLog = join(home, 'pkill.log');
  const pgrepLog = join(home, 'pgrep.log');
  if (json !== undefined) writeFileSync(join(data, 'daemon.json'), json);
  writeShim(shim, 'curl', `#!/bin/sh
printf '%s\\n' "$*" >> "$CURL_LOG"
exit 0
`);
  writeShim(shim, 'pkill', `#!/bin/sh
printf '%s\\n' "$*" >> "$PKILL_LOG"
exit 0
`);
  writeShim(shim, 'pgrep', `#!/bin/sh
printf '%s\\n' "$*" >> "$PGREP_LOG"
exit "$PGREP_EXIT"
`);
  writeShim(shim, 'sleep', '#!/bin/sh\nexit 0\n');
  try {
    const result = spawnSync('sh', [tpStop], {
      encoding: 'utf8',
      timeout: 15000,
      cwd: home,
      env: {
        HOME: home,
        PATH: childPath(shim),
        LANG: 'C',
        LC_ALL: 'C',
        TMPDIR: home,
        CURL_LOG: curlLog,
        PKILL_LOG: pkillLog,
        PGREP_LOG: pgrepLog,
        PGREP_EXIT: String(pgrepExit),
      },
    });
    return {
      result,
      ports: flushedPorts(curlLog),
      pkill: existsSync(pkillLog) ? readFileSync(pkillLog, 'utf8') : '',
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function assertPorts(actual, expected) {
  assert.deepEqual([...actual].sort((a, b) => a - b), [...expected].sort((a, b) => a - b));
}

test('leading zeros are stripped so a custom port is flushed and stop still succeeds', () => {
  const { result, ports } = runStop('{ "port": 00080 }\n', 1);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal((result.stdout ?? '').trim(), 'TP_STOPPED');
  assert.equal((result.stderr ?? '').includes('pgrep failed'), false);
  assertPorts(ports, [80, 9772, 9774]);
  assert.equal(ports.filter((port) => port === 9772).length, 1);
  assert.equal(ports.includes(80), true);
});

test('leading zeros that collapse to a default port are not flushed twice', () => {
  const { result, ports } = runStop('{ "port": 0009772 }\n', 1);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal((result.stdout ?? '').trim(), 'TP_STOPPED');
  assertPorts(ports, [9772, 9774]);
  assert.equal(ports.filter((port) => port === 9772).length, 1);
});

test('out-of-range, overlong, zero, and unparsable daemon.json keep the two default flushes', () => {
  const samples = [
    '{ "port": 0 }\n',
    '{ "port": 65536 }\n',
    '{ "port": 123456 }\n',
    '{ "port": }\n',
    'not-json {{{',
  ];
  for (const json of samples) {
    const { result, ports } = runStop(json, 1);
    assert.equal(result.error, undefined, json);
    assert.equal(result.status, 0, json);
    assert.equal((result.stdout ?? '').trim(), 'TP_STOPPED', json);
    assertPorts(ports, [9772, 9774]);
  }
});

test('pgrep failure is not reported as TP_STOPPED and does not escalate to SIGKILL', () => {
  const { result, pkill } = runStop('{ "port": 18080 }\n', 2);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal((result.stdout ?? '').trim(), 'TP_STOP_FAILED');
  assert.equal((result.stdout ?? '').includes('TP_STOPPED'), false);
  assert.match(result.stderr ?? '', /pgrep failed/);
  assert.match(result.stderr ?? '', /refusing to report success/);
  assert.equal(pkill.includes('-9'), false);
});
