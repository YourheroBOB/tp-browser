// tp-start.sh --headed 在 daemon 已健康時的快速路徑。
// 回歸：無頭 Chrome 的 gpu/utility 子行程沒有 --headless，舊的 `grep -qv` 會把它當成已是有頭。
// 回歸：profile 路徑含 `.local`，當正則時 `.` 會對上無關行程（例如 Xlocal）。
// 零網路：curl/ps/pkill/sleep/node/uname 都是暫存目錄裡的替身，PATH 不含系統目錄。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accessSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/tp-start.sh', import.meta.url));
const COREUTILS = ['dirname', 'mkdir', 'chmod', 'grep', 'pwd'];

function findExecutable(name) {
  for (const dir of ['/usr/bin', '/bin']) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate);
      return candidate;
    } catch {
      // try the next location
    }
  }
  throw new Error(`required system utility not found: ${name}`);
}

function writeExec(path, contents) {
  writeFileSync(path, contents, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function makeSandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'fmb-w14-s12-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const pkillLog = join(root, 'pkill.log');
  const psOut = join(root, 'ps.out');
  const procVersion = join(root, 'proc-version');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(pkillLog, '');
  writeFileSync(psOut, '');
  writeFileSync(procVersion, 'Linux version 6.8.0-test\n');

  for (const name of COREUTILS) {
    symlinkSync(findExecutable(name), join(bin, name));
  }

  const cat = findExecutable('cat');
  writeExec(join(bin, 'ps'), `#!/bin/sh\nexec '${cat}' "$PS_SNAPSHOT"\n`);
  writeExec(join(bin, 'curl'), '#!/bin/sh\nprintf \'%s\\n\' \'{"ok":true,"chrome":true}\'\nexit 0\n');
  writeExec(join(bin, 'uname'), '#!/bin/sh\nprintf \'Linux\\n\'\n');
  writeExec(join(bin, 'pkill'), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$PKILL_LOG"\nexit 0\n');
  writeExec(join(bin, 'pgrep'), '#!/bin/sh\nexit 1\n');
  writeExec(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
  writeExec(join(bin, 'node'), '#!/bin/sh\nexit 0\n');

  return { root, home, bin, pkillLog, psOut, procVersion };
}

function profileOf(sandbox) {
  return join(sandbox.home, '.local', 'share', 'ego-linux', 'profile-agent');
}

function setProcesses(sandbox, lines) {
  writeFileSync(sandbox.psOut, `${lines.join('\n')}\n`);
}

function runHeaded(sandbox) {
  return spawnSync('/bin/sh', [SCRIPT, '--headed'], {
    encoding: 'utf8',
    timeout: 8000,
    env: {
      HOME: sandbox.home,
      PATH: sandbox.bin,
      PKILL_LOG: sandbox.pkillLog,
      PS_SNAPSHOT: sandbox.psOut,
      TP_START_PROC_VERSION: sandbox.procVersion,
    },
  });
}

function assertDidNotClaimHeaded(sandbox, res) {
  assert.equal(res.error, undefined, res.error?.message);
  assert.equal(res.status, 1, `stdout=${res.stdout} stderr=${res.stderr}`);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /No Chrome\/Chromium\/Edge\/Brave binary found on Linux!/);
  assert.equal(readFileSync(sandbox.pkillLog, 'utf8'), '');
}

test(
  'headed fast-path ignores headless Chrome helpers that omit --headless',
  { skip: process.platform === 'win32' },
  (t) => {
    const sandbox = makeSandbox(t);
    const profile = profileOf(sandbox);
    setProcesses(sandbox, [
      `/usr/bin/chrome --headless=new --user-data-dir=${profile} --remote-debugging-port=9773`,
      `/usr/bin/chrome --type=gpu-process --user-data-dir=${profile} --gpu-preferences=Default`,
    ]);

    assertDidNotClaimHeaded(sandbox, runHeaded(sandbox));
  },
);

test(
  'headed fast-path does not treat a regex lookalike of .local as this profile',
  { skip: process.platform === 'win32' },
  (t) => {
    const sandbox = makeSandbox(t);
    const decoy = join(sandbox.home, 'Xlocal', 'share', 'ego-linux', 'profile-agent');
    setProcesses(sandbox, [
      `/usr/bin/chrome --type=browser --user-data-dir=${decoy}`,
    ]);

    assertDidNotClaimHeaded(sandbox, runHeaded(sandbox));
  },
);

test(
  'headed fast-path keeps an already headed profile window',
  { skip: process.platform === 'win32' },
  (t) => {
    const sandbox = makeSandbox(t);
    const profile = profileOf(sandbox);
    setProcesses(sandbox, [
      `/usr/bin/chrome --user-data-dir=${profile} --remote-debugging-port=9773`,
      `/usr/bin/chrome --type=gpu-process --user-data-dir=${profile}`,
    ]);

    const res = runHeaded(sandbox);
    assert.equal(res.error, undefined, res.error?.message);
    assert.equal(res.status, 0, `stdout=${res.stdout} stderr=${res.stderr}`);
    assert.match(res.stdout, /TP_READY \(port=9772, chrome=9773, os=Linux, mode=headed\)/);
    assert.equal(res.stderr, '');
    assert.equal(readFileSync(sandbox.pkillLog, 'utf8'), '');
  },
);
