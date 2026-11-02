// 回歸 scripts/tp-stop.sh：
// 1. pgrep 結束碼 >= 2 不是「已經沒有行程」，不得印 TP_STOPPED。
// 2. daemon.json 損壞、越界、或只含 chromePort 時不得中止停止流程，並退回 9772/9774。
// 3. 前導零與 CRLF 仍要解析出 daemon 埠，並連同預設埠一起 flush。
// curl / pkill / pgrep / sleep 都是 PATH 上的假指令，不連線、不殺真實行程。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const stopScript = fileURLToPath(new URL('../scripts/tp-stop.sh', import.meta.url));

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function installFake(dir, name, body) {
  const file = join(dir, name);
  writeFileSync(file, body.endsWith('\n') ? body : `${body}\n`);
  chmodSync(file, 0o755);
}

function readLog(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

function dump(result) {
  return [
    `status=${result.status}`,
    `signal=${result.signal ?? ''}`,
    `error=${result.error ? result.error.message : ''}`,
    `stdout=${result.stdout}`,
    `stderr=${result.stderr}`,
    `curl=${result.curl}`,
    `pkill=${result.pkill}`,
    `pgrep=${result.pgrep}`,
  ].join('\n');
}

function runStop(t, { daemonBody = null, pgrepRc = '1' } = {}) {
  const rc = String(pgrepRc);
  if (!/^[0-9]{1,3}$/.test(rc)) {
    throw new Error('invalid pgrep rc');
  }
  const home = mkdtempSync(join(tmpdir(), 'fmb-regress-stop-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = join(home, 'bin');
  const logDir = join(home, 'logs');
  mkdirSync(bin);
  mkdirSync(logDir);
  const curlLog = join(logDir, 'curl.txt');
  const pkillLog = join(logDir, 'pkill.txt');
  const pgrepLog = join(logDir, 'pgrep.txt');
  const sleepLog = join(logDir, 'sleep.txt');
  const dataDir = join(home, '.local', 'share', 'ego-linux');
  mkdirSync(dataDir, { recursive: true });
  if (daemonBody !== null) {
    writeFileSync(join(dataDir, 'daemon.json'), daemonBody);
  }

  const recorder = (logFile, tail) => `#!/bin/sh
printf '%s\\n' "$*" >> ${shellQuote(logFile)}
${tail}
`;
  installFake(bin, 'curl', recorder(curlLog, 'exit 0'));
  installFake(bin, 'pkill', recorder(pkillLog, 'exit 0'));
  installFake(bin, 'pgrep', recorder(pgrepLog, `exit ${rc}`));
  installFake(bin, 'sleep', recorder(sleepLog, 'exit 0'));

  const result = spawnSync('sh', [stopScript], {
    encoding: 'utf8',
    timeout: 15000,
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      PATH: [bin, process.env.PATH].filter(Boolean).join(':'),
    },
  });
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    curl: readLog(curlLog),
    pkill: readLog(pkillLog),
    pgrep: readLog(pgrepLog),
    sleep: readLog(sleepLog),
  };
}

test('pgrep 失敗不得回報 TP_STOPPED', (t) => {
  const result = runStop(t, { pgrepRc: '2' });
  assert.equal(result.status, 1, dump(result));
  assert.match(result.stdout, /TP_STOP_FAILED/);
  assert.doesNotMatch(result.stdout, /TP_STOPPED/);
  assert.match(result.stderr, /tp-stop: pgrep failed; refusing to report success/);
  assert.match(result.curl, /127\.0\.0\.1:9772\/flush-and-close/);
  assert.match(result.curl, /127\.0\.0\.1:9774\/flush-and-close/);
  assert.match(result.pkill, /-f /);
  assert.doesNotMatch(result.pkill, /(^|\s)-9(\s|$)/);
  assert.notEqual(result.pgrep, '');
});

test('損壞或越界的 daemon.json 退回 9772 與 9774 且仍成功停止', (t) => {
  const samples = [
    'this is not json',
    '',
    '{"port": 0}',
    '{"port": -1}',
    '{"port": 99999}',
    '{"port": 65536}',
    '{"port": 123456}',
    '{"chromePort": 9775}',
  ];
  for (const body of samples) {
    const result = runStop(t, { daemonBody: body, pgrepRc: '1' });
    assert.equal(result.status, 0, `${body}\n${dump(result)}`);
    assert.match(result.stdout, /TP_STOPPED/);
    assert.match(result.curl, /127\.0\.0\.1:9772\/flush-and-close/);
    assert.match(result.curl, /127\.0\.0\.1:9774\/flush-and-close/);
    assert.doesNotMatch(result.curl, /127\.0\.0\.1:9775\//);
    assert.doesNotMatch(result.curl, /127\.0\.0\.1:0\//);
    assert.doesNotMatch(result.curl, /127\.0\.0\.1:99999\//);
    assert.doesNotMatch(result.curl, /127\.0\.0\.1:65536\//);
    assert.doesNotMatch(result.curl, /127\.0\.0\.1:123456\//);
  }
});

test('自訂 daemon 埠與範圍上界會 flush，chromePort 不會被當成 daemon', (t) => {
  const custom = runStop(t, {
    daemonBody: '{"chromePort":9775,"port":18080}\n',
    pgrepRc: '1',
  });
  assert.equal(custom.status, 0, dump(custom));
  assert.match(custom.stdout, /TP_STOPPED/);
  assert.match(custom.curl, /127\.0\.0\.1:18080\/flush-and-close/);
  assert.match(custom.curl, /127\.0\.0\.1:9772\/flush-and-close/);
  assert.match(custom.curl, /127\.0\.0\.1:9774\/flush-and-close/);
  assert.doesNotMatch(custom.curl, /127\.0\.0\.1:9775\//);

  const top = runStop(t, { daemonBody: '{"port": 65535}\n', pgrepRc: '1' });
  assert.equal(top.status, 0, dump(top));
  assert.match(top.curl, /127\.0\.0\.1:65535\/flush-and-close/);
  assert.match(top.curl, /127\.0\.0\.1:9772\/flush-and-close/);
});

test('前導零與 CRLF 的 daemon 埠仍會被 flush', (t) => {
  const padded = runStop(t, { daemonBody: '{"port": 00123}\n', pgrepRc: '1' });
  assert.equal(padded.status, 0, dump(padded));
  assert.match(padded.stdout, /TP_STOPPED/);
  assert.match(padded.curl, /127\.0\.0\.1:123\/flush-and-close/);
  assert.match(padded.curl, /127\.0\.0\.1:9772\/flush-and-close/);
  assert.doesNotMatch(padded.curl, /127\.0\.0\.1:00123\//);

  const crlf = runStop(t, { daemonBody: '{"port": 18080}\r\n', pgrepRc: '1' });
  assert.equal(crlf.status, 0, dump(crlf));
  assert.match(crlf.curl, /127\.0\.0\.1:18080\/flush-and-close/);
  assert.match(crlf.curl, /127\.0\.0\.1:9774\/flush-and-close/);
});
