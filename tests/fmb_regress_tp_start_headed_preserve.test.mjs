// 回歸 scripts/tp-start.sh：
// 已健康且行程列沒有 --headless 時，--headed 要保留視窗，不得 flush／pkill。
// 行程列已是無頭時不得走這條捷徑。
// --restart 不得沿用「已經健康」捷徑。
// --alt-port 的健康檢查必須打 9774，而不是 9772。
// WSL 字串出現但 powershell 不存在時，不得呼叫真實 Windows 啟動器。
// curl / pkill / pgrep / sleep / node / ps 都是 PATH 上的假指令。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const startScript = fileURLToPath(new URL('../scripts/tp-start.sh', import.meta.url));

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
    `node=${result.node}`,
  ].join('\n');
}

function runStart(t, {
  args = [],
  headless = null,
  browser = 'unset',
  procText = 'Linux version\n',
} = {}) {
  const home = mkdtempSync(join(tmpdir(), 'fmb-regress-start-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = join(home, 'bin');
  const logDir = join(home, 'logs');
  mkdirSync(bin);
  mkdirSync(logDir);
  const curlLog = join(logDir, 'curl.txt');
  const pkillLog = join(logDir, 'pkill.txt');
  const pgrepLog = join(logDir, 'pgrep.txt');
  const sleepLog = join(logDir, 'sleep.txt');
  const nodeLog = join(logDir, 'node.txt');
  const procFile = join(home, 'proc-version');
  writeFileSync(procFile, procText);
  installFake(bin, 'fake-browser', '#!/bin/sh\nexit 0\n');

  const profile = join(home, '.local', 'share', 'ego-linux', 'profile-agent');
  let psOutput = '';
  if (headless === true) {
    psOutput = `${profile} --headless=new --remote-debugging-port=9773`;
  } else if (headless === false) {
    psOutput = `${profile} --remote-debugging-port=9773`;
  }

  let browserBin = '';
  if (browser === 'valid') browserBin = join(bin, 'fake-browser');
  if (browser === 'missing') browserBin = join(home, 'missing-browser');

  const recorder = (logFile, tail) => `#!/bin/sh
printf '%s\\n' "$*" >> ${shellQuote(logFile)}
${tail}
`;
  installFake(bin, 'curl', `#!/bin/sh
printf '%s\\n' "$*" >> ${shellQuote(curlLog)}
case "$*" in
  */health*)
    printf '%s\\n' '{"ok":true,"chrome":true}'
    exit 0
    ;;
esac
exit 1
`);
  installFake(bin, 'pkill', recorder(pkillLog, 'exit 0'));
  installFake(bin, 'pgrep', recorder(pgrepLog, 'exit 1'));
  installFake(bin, 'sleep', recorder(sleepLog, 'exit 0'));
  installFake(bin, 'node', recorder(nodeLog, 'exit 0'));
  installFake(bin, 'ps', `#!/bin/sh
printf '%s\\n' "$FAKE_PS_OUTPUT"
exit 0
`);

  const result = spawnSync('sh', [startScript, ...args], {
    encoding: 'utf8',
    timeout: 15000,
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      PATH: [bin, process.env.PATH].filter(Boolean).join(':'),
      TP_START_PROC_VERSION: procFile,
      TP_START_WIN_PS: join(home, 'missing-powershell.exe'),
      TP_START_WIN_USERS: join(home, 'missing-users'),
      TP_BROWSER_BIN: browserBin,
      FAKE_PS_OUTPUT: psOutput,
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
    node: readLog(nodeLog),
  };
}

test('已是有頭視窗時 --headed 保留視窗且不 flush、不 pkill', (t) => {
  const result = runStart(t, { args: ['--headed'], headless: false });
  assert.equal(result.status, 0, dump(result));
  assert.match(result.stdout, /TP_READY /);
  assert.match(result.stdout, /mode=headed/);
  assert.match(result.stdout, /port=9772/);
  assert.doesNotMatch(result.stdout, /TP_INDICATORS/);
  assert.match(result.curl, /127\.0\.0\.1:9772\/health/);
  assert.doesNotMatch(result.curl, /flush-and-close/);
  assert.equal(result.pkill, '');
  assert.equal(result.node, '');
});

test('無頭行程不會被 --headed 當成可保留視窗', (t) => {
  const result = runStart(t, { args: ['--headed'], headless: true, browser: 'valid' });
  assert.equal(result.status, 0, dump(result));
  assert.match(result.stdout, /TP_READY /);
  assert.match(result.stdout, /mode=headed/);
  assert.match(result.stdout, /TP_INDICATORS/);
  assert.match(result.curl, /flush-and-close/);
  assert.match(result.curl, /127\.0\.0\.1:9772\/flush-and-close/);
  assert.match(result.curl, /127\.0\.0\.1:9774\/flush-and-close/);
  assert.notEqual(result.pkill, '');
  assert.notEqual(result.node, '');
});

test('--restart 不走已健康捷徑', (t) => {
  const result = runStart(t, {
    args: ['--restart', '--headed'],
    headless: false,
    browser: 'missing',
  });
  assert.equal(result.status, 1, dump(result));
  assert.match(result.stderr, /TP_BROWSER_BIN/);
  assert.match(result.stderr, /Nothing was flushed, stopped or launched/);
  assert.doesNotMatch(result.stdout, /TP_READY/);
  assert.doesNotMatch(result.stdout, /TP_INDICATORS/);
  assert.doesNotMatch(result.curl, /\/health/);
  assert.doesNotMatch(result.curl, /flush-and-close/);
  assert.equal(result.pkill, '');
  assert.equal(result.node, '');
});

test('--alt-port 的健康檢查使用 9774', (t) => {
  const result = runStart(t, { args: ['--alt-port'] });
  assert.equal(result.status, 0, dump(result));
  assert.match(result.stdout, /TP_READY /);
  assert.match(result.stdout, /port=9774/);
  assert.match(result.stdout, /chrome=9775/);
  assert.doesNotMatch(result.stdout, /port=9772/);
  assert.match(result.curl, /127\.0\.0\.1:9774\/health/);
  assert.doesNotMatch(result.curl, /127\.0\.0\.1:9772\//);
  assert.doesNotMatch(result.curl, /flush-and-close/);
  assert.equal(result.pkill, '');
  assert.equal(result.node, '');
});

test('已健康時直接 TP_READY，不 flush 也不 pkill', (t) => {
  const result = runStart(t, { args: [] });
  assert.equal(result.status, 0, dump(result));
  assert.match(result.stdout, /TP_READY /);
  assert.match(result.stdout, /port=9772/);
  assert.match(result.stdout, /chrome=9773/);
  assert.doesNotMatch(result.stdout, /mode=headed/);
  assert.match(result.curl, /127\.0\.0\.1:9772\/health/);
  assert.doesNotMatch(result.curl, /flush-and-close/);
  assert.equal(result.pkill, '');
  assert.equal(result.node, '');
});

test('核心字串含 microsoft 但 powershell 不存在時仍保留有頭視窗', (t) => {
  const result = runStart(t, {
    args: ['--headed'],
    headless: false,
    procText: 'Linux version 6.8.0-microsoft-standard\n',
  });
  assert.equal(result.status, 0, dump(result));
  assert.match(result.stdout, /TP_READY /);
  assert.match(result.stdout, /mode=headed/);
  assert.doesNotMatch(result.stdout, /TP_INDICATORS/);
  assert.match(result.curl, /127\.0\.0\.1:9772\/health/);
  assert.doesNotMatch(result.curl, /flush-and-close/);
  assert.equal(result.pkill, '');
  assert.equal(result.node, '');
});
