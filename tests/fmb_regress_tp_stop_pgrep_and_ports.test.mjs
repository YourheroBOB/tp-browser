// 回歸：scripts/tp-stop.sh
// 1. pgrep 退出碼 >= 2 不得被當成「已經沒有程序」而印出 TP_STOPPED。
// 2. daemon.json 的 port 會去掉前導 0；超出 1..65535 或超過 5 位的值不得拿去 flush。
// 假 curl／pkill／pgrep／sleep 放在暫存目錄，不連線、不殺真實程序。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tpStop = join(fileURLToPath(new URL('..', import.meta.url)), 'scripts', 'tp-stop.sh');

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function writeExe(dir, name, body) {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

function layout(pgrepRc) {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-regress-tp-stop-'));
  const bin = join(dir, 'bin');
  const home = join(dir, 'home');
  const data = join(home, '.local', 'share', 'ego-linux');
  mkdirSync(bin, { recursive: true });
  mkdirSync(data, { recursive: true });
  const curlLog = join(dir, 'curl.log');
  const rcFile = join(dir, 'pgrep.rc');
  writeFileSync(rcFile, `${pgrepRc}\n`);
  writeExe(bin, 'curl', `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shQuote(curlLog)}\nexit 0\n`);
  writeExe(bin, 'pkill', '#!/bin/sh\nexit 0\n');
  writeExe(bin, 'pgrep', `#!/bin/sh\nrc=$(cat ${shQuote(rcFile)})\nexit "$rc"\n`);
  writeExe(bin, 'sleep', '#!/bin/sh\nexit 0\n');
  return { dir, bin, data, curlLog };
}

function runStop(env) {
  return spawnSync('/bin/sh', [tpStop], {
    env,
    encoding: 'utf8',
  });
}

function flushPorts(logPath) {
  let text = '';
  try {
    text = readFileSync(logPath, 'utf8');
  } catch {
    text = '';
  }
  return [...text.matchAll(/127\.0\.0\.1:(\d+)\/flush-and-close/g)].map((match) => match[1]);
}

test('pgrep 失敗時拒絕回報 TP_STOPPED', () => {
  const ctx = layout(2);
  try {
    const result = runStop({
      PATH: `${ctx.bin}:/usr/bin:/bin`,
      HOME: join(ctx.dir, 'home'),
      LANG: 'C',
      LC_ALL: 'C',
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout.trim(), 'TP_STOP_FAILED');
    assert.match(result.stderr, /pgrep failed; refusing to report success/);
    assert.equal(result.stdout.includes('TP_STOPPED'), false);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('前導零 port 會正規化後 flush，且不會保留 018802 這種字面', () => {
  const ctx = layout(1);
  try {
    writeFileSync(join(ctx.data, 'daemon.json'), '{ "port": 018802 }\n');
    const result = runStop({
      PATH: `${ctx.bin}:/usr/bin:/bin`,
      HOME: join(ctx.dir, 'home'),
      LANG: 'C',
      LC_ALL: 'C',
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), 'TP_STOPPED');
    const ports = flushPorts(ctx.curlLog);
    assert.deepEqual(ports, ['9772', '9774', '18802']);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('正規化後等於 9772 的前導零 port 不會多送一次 flush', () => {
  const ctx = layout(1);
  try {
    writeFileSync(join(ctx.data, 'daemon.json'), '{ "port": 0009772 }\n');
    const result = runStop({
      PATH: `${ctx.bin}:/usr/bin:/bin`,
      HOME: join(ctx.dir, 'home'),
      LANG: 'C',
      LC_ALL: 'C',
    });
    assert.equal(result.status, 0);
    assert.deepEqual(flushPorts(ctx.curlLog), ['9772', '9774']);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('損壞的 daemon.json 與越界 port 都不會中止停止流程', () => {
  const samples = [
    { body: '{{{', ports: ['9772', '9774'] },
    { body: '{ "port": 65536 }\n', ports: ['9772', '9774'] },
    { body: '{ "port": 100000 }\n', ports: ['9772', '9774'] },
    { body: '{ "port": 0 }\n', ports: ['9772', '9774'] },
    { body: '{ "port": 1 }\n', ports: ['9772', '9774', '1'] },
    { body: '{ "port": 65535 }\n', ports: ['9772', '9774', '65535'] },
  ];
  for (const sample of samples) {
    const ctx = layout(1);
    try {
      writeFileSync(join(ctx.data, 'daemon.json'), sample.body);
      const result = runStop({
        PATH: `${ctx.bin}:/usr/bin:/bin`,
        HOME: join(ctx.dir, 'home'),
        LANG: 'C',
        LC_ALL: 'C',
      });
      assert.equal(result.status, 0, sample.body);
      assert.equal(result.stdout.trim(), 'TP_STOPPED');
      assert.deepEqual(flushPorts(ctx.curlLog), sample.ports);
    } finally {
      rmSync(ctx.dir, { recursive: true, force: true });
    }
  }
});
