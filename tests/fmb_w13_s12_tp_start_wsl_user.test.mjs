// 回歸：WSL 有頭委派必須拷回「與登入名稱相同且已安裝啟動器」的 Windows 設定檔，
// 並在 Users 根路徑整段符合 /mnt/<letter>/Users 時，把 -File 指到該磁碟代號。
// 只使用 mkdtemp 暫存目錄與 FAKE_VALUE_FOR_TEST，不連線、不碰 repo 以外的既有路徑。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accessSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/tp-start.sh', import.meta.url));
const skipWin = process.platform === 'win32' ? 'POSIX shell only' : false;
const TOOLS = ['dirname', 'basename', 'mkdir', 'chmod', 'cp', 'grep', 'tr'];

function findExecutable(name) {
  for (const dir of ['/usr/bin', '/bin']) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate);
      return candidate;
    } catch {
      // try the next directory
    }
  }
  throw new Error(`required system utility not found: ${name}`);
}

function daemonBody(user) {
  return `{"port":9772,"user":"${user}"}\n`;
}

function addUser(parent, name, token) {
  const ego = join(parent, name, '.local', 'share', 'ego-linux');
  mkdirSync(join(ego, 'scripts'), { recursive: true });
  writeFileSync(join(ego, 'scripts', 'ego-start.ps1'), '# fake launcher\n');
  writeFileSync(join(ego, 'token'), token);
  writeFileSync(join(ego, 'daemon.json'), daemonBody(name));
}

function makeTree(t, usersParts = ['Users']) {
  const root = mkdtempSync(join(tmpdir(), 'fmb-w13-s12-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const home = join(root, 'home');
  const users = join(root, ...usersParts);
  const bin = join(root, 'bin');
  const psLog = join(root, 'ps.log');
  const proc = join(root, 'proc-version');
  const ps = join(root, 'powershell.exe');

  mkdirSync(home, { recursive: true });
  mkdirSync(users, { recursive: true });
  mkdirSync(bin, { recursive: true });
  for (const name of TOOLS) {
    symlinkSync(findExecutable(name), join(bin, name));
  }
  writeFileSync(proc, 'Linux version 6.6.0-microsoft-standard-WSL2 fake\n');
  writeFileSync(
    ps,
    '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$TP_START_PS_LOG"\nexit 0\n',
    { mode: 0o755 },
  );
  chmodSync(ps, 0o755);

  return { root, home, users, bin, psLog, proc, ps };
}

function run(tree, { user, logname, winUser } = {}) {
  const env = {
    HOME: tree.home,
    PATH: tree.bin,
    LC_ALL: 'C',
    LANG: 'C',
    TP_START_PROC_VERSION: tree.proc,
    TP_START_WIN_PS: tree.ps,
    TP_START_WIN_USERS: tree.users,
    TP_START_PS_LOG: tree.psLog,
  };
  if (user !== undefined) env.USER = user;
  if (logname !== undefined) env.LOGNAME = logname;
  if (winUser !== undefined) env.TP_START_WIN_USER = winUser;
  return spawnSync('/bin/sh', [SCRIPT, '--headed'], {
    encoding: 'utf8',
    timeout: 10_000,
    env,
  });
}

function assertDelegated(tree, result, { user, token, drive = 'C' }) {
  assert.equal(
    result.status,
    0,
    `status=${result.status} error=${result.error?.message ?? ''} stdout=${result.stdout} stderr=${result.stderr}`,
  );
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  const data = join(tree.home, '.local', 'share', 'ego-linux');
  assert.equal(readFileSync(join(data, 'token'), 'utf8'), token);
  assert.equal(readFileSync(join(data, 'daemon.json'), 'utf8'), daemonBody(user));
  assert.equal(statSync(join(data, 'token')).mode & 0o777, 0o600);
  assert.equal(statSync(join(data, 'daemon.json')).mode & 0o777, 0o600);
  const lines = readFileSync(tree.psLog, 'utf8').split('\n').filter((line) => line !== '');
  assert.deepEqual(lines, [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    `${drive}:\\Users\\${user}\\.local\\share\\ego-linux\\scripts\\ego-start.ps1`,
    '-Headed',
  ]);
}

test('有頭 WSL 委派使用與登入名稱相同且已安裝啟動器的 Windows 設定檔', { skip: skipWin }, (t) => {
  const tree = makeTree(t);
  addUser(tree.users, 'aaa', 'FAKE_VALUE_FOR_TEST_AAA');
  addUser(tree.users, 'zzz', 'FAKE_VALUE_FOR_TEST_ZZZ');
  const result = run(tree, { user: 'zzz', logname: 'zzz' });
  assertDelegated(tree, result, { user: 'zzz', token: 'FAKE_VALUE_FOR_TEST_ZZZ' });
});

test('登入名稱沒有對應啟動器時，委派給 Users 根目錄內第一個已安裝的設定檔', { skip: skipWin }, (t) => {
  const tree = makeTree(t);
  addUser(tree.users, 'solo', 'FAKE_VALUE_FOR_TEST_SOLO');
  const result = run(tree, { user: 'other', logname: 'other' });
  assertDelegated(tree, result, { user: 'solo', token: 'FAKE_VALUE_FOR_TEST_SOLO' });
});

test('TP_START_WIN_USER 比登入名稱優先', { skip: skipWin }, (t) => {
  const tree = makeTree(t);
  addUser(tree.users, 'aaa', 'FAKE_VALUE_FOR_TEST_AAA');
  addUser(tree.users, 'zzz', 'FAKE_VALUE_FOR_TEST_ZZZ');
  const result = run(tree, { user: 'aaa', logname: 'aaa', winUser: 'zzz' });
  assertDelegated(tree, result, { user: 'zzz', token: 'FAKE_VALUE_FOR_TEST_ZZZ' });
});

test('Users 根路徑符合 /mnt/<letter>/Users 時，-File 使用該磁碟代號', { skip: skipWin }, (t) => {
  const tree = makeTree(t, ['mnt', 'd', 'Users']);
  addUser(tree.users, 'zzz', 'FAKE_VALUE_FOR_TEST_ZZZ');
  const result = run(tree, { user: 'zzz', logname: 'zzz' });
  assertDelegated(tree, result, { user: 'zzz', token: 'FAKE_VALUE_FOR_TEST_ZZZ', drive: 'D' });
});

test('登入名稱含斜線時忽略該名稱，並使用 Users 根目錄內的設定檔', { skip: skipWin }, (t) => {
  const tree = makeTree(t);
  addUser(tree.root, 'escaped', 'FAKE_VALUE_FOR_TEST_DECOY');
  addUser(tree.users, 'solo', 'FAKE_VALUE_FOR_TEST_SOLO');
  const result = run(tree, { user: '../escaped', logname: '../escaped' });
  assertDelegated(tree, result, { user: 'solo', token: 'FAKE_VALUE_FOR_TEST_SOLO' });
});
