// 回歸：scripts/tp-start.sh 在 TP_BROWSER_BIN 不是可執行檔時，必須在 flush／pkill／
// 啟動之前退出，並保留既有 profile lock。shim 吞掉 curl，不連線 127.0.0.1。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const tpStart = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'tp-start.sh');

function writeShim(dir, name, body) {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function childPath(shim) {
  const base = process.env.PATH ? `${process.env.PATH}:/usr/bin:/bin` : '/usr/bin:/bin';
  return `${shim}:${base}`;
}

function runStart(prepare) {
  const home = mkdtempSync(join(tmpdir(), 'fmb-regress-start-'));
  const shim = join(home, 'shim');
  const profile = join(home, '.local', 'share', 'ego-linux', 'profile-agent');
  mkdirSync(shim, { recursive: true });
  mkdirSync(profile, { recursive: true });
  const lock = join(profile, 'SingletonLock');
  writeFileSync(lock, 'keep');
  const curlLog = join(home, 'curl.log');
  const pkillLog = join(home, 'pkill.log');
  const nodeLog = join(home, 'node.log');
  writeShim(shim, 'curl', `#!/bin/sh
printf '%s\\n' "$*" >> "$CURL_LOG"
exit 22
`);
  writeShim(shim, 'pkill', `#!/bin/sh
printf '%s\\n' "$*" >> "$PKILL_LOG"
exit 0
`);
  writeShim(shim, 'pgrep', `#!/bin/sh
exit 1
`);
  writeShim(shim, 'sleep', '#!/bin/sh\nexit 0\n');
  writeShim(shim, 'node', `#!/bin/sh
printf '%s\\n' "$*" >> "$NODE_LOG"
exit 99
`);
  const bin = prepare(home);
  try {
    const result = spawnSync('sh', [tpStart], {
      encoding: 'utf8',
      timeout: 15000,
      cwd: home,
      env: {
        HOME: home,
        PATH: childPath(shim),
        LANG: 'C',
        LC_ALL: 'C',
        TMPDIR: home,
        TP_BROWSER_BIN: bin,
        CURL_LOG: curlLog,
        PKILL_LOG: pkillLog,
        NODE_LOG: nodeLog,
      },
    });
    const curlText = existsSync(curlLog) ? readFileSync(curlLog, 'utf8') : '';
    const lockText = existsSync(lock) ? readFileSync(lock, 'utf8') : null;
    return {
      result,
      bin,
      lockText,
      curlText,
      pkillRan: existsSync(pkillLog),
      nodeRan: existsSync(nodeLog),
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function assertRefused(run) {
  assert.equal(run.result.error, undefined);
  assert.equal(run.result.status, 1);
  const stderr = run.result.stderr ?? '';
  const stdout = run.result.stdout ?? '';
  assert.match(stderr, /TP_BROWSER_BIN is set to/);
  assert.ok(stderr.includes(run.bin));
  assert.match(stderr, /Refusing to auto-detect another browser/);
  assert.match(stderr, /Nothing was flushed, stopped or launched/);
  assert.equal(stdout.includes('TP_READY'), false);
  assert.equal(run.curlText.includes('flush-and-close'), false);
  assert.equal(run.pkillRan, false);
  assert.equal(run.nodeRan, false);
  assert.equal(run.lockText, 'keep');
}

test('a non-executable TP_BROWSER_BIN is refused before flush or pkill', () => {
  const run = runStart((home) => {
    const bin = join(home, 'not-executable-browser');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    chmodSync(bin, 0o644);
    return bin;
  });
  assertRefused(run);
});

test('a missing TP_BROWSER_BIN is refused before flush or pkill', () => {
  const run = runStart((home) => join(home, 'missing-browser'));
  assertRefused(run);
});
