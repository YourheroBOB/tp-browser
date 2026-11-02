// 回歸：scripts/tp-start.sh
// 1. daemon.json 裡不可用的 port（0、65536、99999）不得 flush；65535 與 CRLF 行尾的合法 port 要 flush。
// 2. 同一 port 只 flush 一次。
// 3. WSL 有頭分支只有在 powershell 真的可執行時才接管；接管時要轉發 -Restart、
//    複製 daemon.json／token，且不得在本機 flush。不重複 --alt-port 那條既有測試。
// PATH 上的 curl／pkill／pgrep／sleep／node 都是暫存假指令。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tpStart = join(fileURLToPath(new URL('..', import.meta.url)), 'scripts', 'tp-start.sh');

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function writeExe(dir, name, body) {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

function layout() {
  const dir = mkdtempSync(join(tmpdir(), 'fmb-regress-tp-start-'));
  const bin = join(dir, 'bin');
  const home = join(dir, 'home');
  const data = join(home, '.local', 'share', 'ego-linux');
  mkdirSync(bin, { recursive: true });
  mkdirSync(data, { recursive: true });
  const curlLog = join(dir, 'curl.log');
  const psLog = join(dir, 'ps.log');
  writeExe(bin, 'curl', `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shQuote(curlLog)}\nexit 0\n`);
  writeExe(bin, 'pkill', '#!/bin/sh\nexit 0\n');
  writeExe(bin, 'pgrep', '#!/bin/sh\nexit 1\n');
  writeExe(bin, 'sleep', '#!/bin/sh\nexit 0\n');
  writeExe(bin, 'node', '#!/bin/sh\nexit 0\n');
  const browser = writeExe(bin, 'browser', '#!/bin/sh\nexit 0\n');
  return { dir, bin, home, data, curlLog, psLog, browser };
}

function baseEnv(ctx) {
  return {
    PATH: `${ctx.bin}:/usr/bin:/bin`,
    HOME: ctx.home,
    LANG: 'C',
    LC_ALL: 'C',
    TP_BROWSER_BIN: ctx.browser,
  };
}

function runStart(ctx, args, extraEnv) {
  return spawnSync('/bin/sh', [tpStart, ...args], {
    env: { ...baseEnv(ctx), ...extraEnv },
    encoding: 'utf8',
  });
}

function countFlush(logPath, port) {
  let text = '';
  try {
    text = readFileSync(logPath, 'utf8');
  } catch {
    text = '';
  }
  const needle = `127.0.0.1:${port}/flush-and-close`;
  let count = 0;
  let from = 0;
  while (from <= text.length) {
    const at = text.indexOf(needle, from);
    if (at === -1) break;
    count += 1;
    from = at + needle.length;
  }
  return count;
}

test('越界 port 不 flush，邊界值與 CRLF port 會 flush，預設 port 不重複', () => {
  const cases = [
    { body: '{"port": 99999}\n', extra: null },
    { body: '{"port": 0}\n', extra: null },
    { body: '{"port": 65536}\n', extra: null },
    { body: '{"port": 65535}\n', extra: '65535' },
    { body: '{"port": 18802}\r\n', extra: '18802' },
    { body: '{"port": 9772}\n', extra: null, dedupe: '9772' },
  ];
  for (const item of cases) {
    const ctx = layout();
    try {
      writeFileSync(join(ctx.data, 'daemon.json'), item.body);
      const result = runStart(ctx, []);
      assert.equal(result.status, 1, item.body);
      assert.match(result.stderr, /TP_NOT_READY/);
      assert.equal(countFlush(ctx.curlLog, '9772'), 1, item.body);
      assert.equal(countFlush(ctx.curlLog, '9774'), 1, item.body);
      assert.equal(countFlush(ctx.curlLog, '99999'), 0);
      assert.equal(countFlush(ctx.curlLog, '65536'), 0);
      assert.equal(countFlush(ctx.curlLog, '0'), 0);
      if (item.extra) assert.equal(countFlush(ctx.curlLog, item.extra), 1, item.body);
      if (item.dedupe) assert.equal(countFlush(ctx.curlLog, item.dedupe), 1);
    } finally {
      rmSync(ctx.dir, { recursive: true, force: true });
    }
  }
});

test('WSL 有頭但 powershell 不可執行時改走本機啟動，不會直接成功退出', () => {
  const ctx = layout();
  try {
    const proc = join(ctx.dir, 'proc-version');
    writeFileSync(proc, 'Linux version 5.15.0-microsoft-standard\n');
    const winPs = join(ctx.dir, 'powershell.exe');
    writeFileSync(winPs, '#!/bin/sh\nexit 0\n');
    chmodSync(winPs, 0o644);
    const users = join(ctx.dir, 'Users');
    const winEgo = join(users, 'alice', '.local', 'share', 'ego-linux');
    mkdirSync(join(winEgo, 'scripts'), { recursive: true });
    writeFileSync(join(winEgo, 'scripts', 'ego-start.ps1'), '# fake\n');
    writeFileSync(join(winEgo, 'token'), 'FAKE_VALUE_FOR_TEST\n');
    writeFileSync(join(winEgo, 'daemon.json'), '{"port":9774}\n');

    const result = runStart(ctx, ['--headed'], {
      TP_START_PROC_VERSION: proc,
      TP_START_WIN_PS: winPs,
      TP_START_WIN_USERS: users,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /TP_NOT_READY/);
    assert.equal(countFlush(ctx.curlLog, '9772') > 0, true);
    assert.equal(existsSync(join(ctx.data, 'token')), false);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('WSL 有頭加 restart 會轉發旗標、複製設定，且不在本機 flush', () => {
  const ctx = layout();
  try {
    const proc = join(ctx.dir, 'proc-version');
    writeFileSync(proc, 'Linux version 5.15.0-microsoft-standard\n');
    const winPs = writeExe(ctx.dir, 'powershell.exe', `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shQuote(ctx.psLog)}\nexit 0\n`);
    const users = join(ctx.dir, 'Users');
    const winEgo = join(users, 'alice', '.local', 'share', 'ego-linux');
    mkdirSync(join(winEgo, 'scripts'), { recursive: true });
    writeFileSync(join(winEgo, 'scripts', 'ego-start.ps1'), '# fake\n');
    writeFileSync(join(winEgo, 'token'), 'FAKE_VALUE_FOR_TEST\n');
    writeFileSync(join(winEgo, 'daemon.json'), '{"port":9772,"chromePort":9773}\n');

    const result = runStart(ctx, ['--headed', '--restart'], {
      TP_START_PROC_VERSION: proc,
      TP_START_WIN_PS: winPs,
      TP_START_WIN_USERS: users,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.includes('TP_NOT_READY'), false);
    assert.equal(existsSync(ctx.curlLog), false);
    const psArgs = readFileSync(ctx.psLog, 'utf8');
    assert.match(psArgs, /-Headed/);
    assert.match(psArgs, /-Restart/);
    assert.equal(psArgs.includes('-AltPort'), false);
    assert.equal(readFileSync(join(ctx.data, 'token'), 'utf8'), 'FAKE_VALUE_FOR_TEST\n');
    assert.equal(readFileSync(join(ctx.data, 'daemon.json'), 'utf8'), '{"port":9772,"chromePort":9773}\n');
    assert.equal(statSync(join(ctx.data, 'token')).mode & 0o777, 0o600);
    assert.equal(statSync(join(ctx.data, 'daemon.json')).mode & 0o777, 0o600);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});
