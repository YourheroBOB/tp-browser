// tests/fmb_w6_s09_tp_stop_no_pgrep.test.mjs
// Regression tests for scripts/tp-stop.sh (fan-out w6 / s09).
//
// Bug 1: without pgrep/pkill on PATH the script killed nothing yet still
//   printed TP_STOPPED (pgrep exits 127 when the binary is missing, and
//   all_stopped() read that as "no matching process").
// Bug 2: flush-and-close only ever hit the hard-coded 9772/9774, so a daemon
//   configured as {"port":9780} in daemon.json was never flushed.
//
// Hermetic by construction: HOME and PATH are temp dirs, curl is a stub that
// only appends its arguments to a log file, and /proc is redirected through
// TP_PROC_DIR so the tests never scan — or signal — unrelated real processes.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const SCRIPT = fileURLToPath(new URL('../scripts/tp-stop.sh', import.meta.url));
const SH = '/bin/sh';
const tempRoot = mkdtempSync(join(tmpdir(), 'fmb-w6-s09-tp-stop-'));
after(() => rmSync(tempRoot, { recursive: true, force: true }));

function realBin(name) {
  const res = spawnSync(SH, ['-c', `command -v ${name}`], { encoding: 'utf8' });
  assert.equal(res.status, 0, `cannot resolve ${name}: ${res.stderr}`);
  return res.stdout.trim();
}

// A PATH holding only sh, sleep and a fake curl — deliberately no pgrep/pkill/ps.
function makeStubPath(tag) {
  const dir = join(tempRoot, `stub-${tag}`);
  mkdirSync(dir, { recursive: true });
  symlinkSync(realBin('sh'), join(dir, 'sh'));
  symlinkSync(realBin('sleep'), join(dir, 'sleep'));
  const log = join(tempRoot, `curl-${tag}.log`);
  writeFileSync(
    join(dir, 'curl'),
    '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$TP_TEST_CURL_LOG"\nexit 0\n',
    'utf8',
  );
  chmodSync(join(dir, 'curl'), 0o755);
  return { dir, log };
}

function makeHome(tag) {
  const home = join(tempRoot, `home-${tag}`);
  mkdirSync(home, { recursive: true });
  return home;
}

// Redirect /proc for the script under test: a directory with one symlink per
// watched PID pointing at the real /proc/<pid>. A reaped process leaves a
// dangling symlink, which the script correctly treats as "gone".
function makeFakeProc(tag, pids) {
  const dir = join(tempRoot, `proc-${tag}`);
  mkdirSync(dir, { recursive: true });
  for (const pid of pids) {
    symlinkSync(`/proc/${pid}`, join(dir, String(pid)));
  }
  return dir;
}

async function spawnFakeDaemon(tag) {
  const dir = join(tempRoot, `fake-${tag}`);
  mkdirSync(dir, { recursive: true });
  // The file name is what puts "ego-browserd.js" into the command line.
  const target = join(dir, 'ego-browserd.js');
  writeFileSync(target, 'sleep 300\n', 'utf8');
  chmodSync(target, 0o755);
  const child = spawn(SH, ['-c', 'exec sleep 300', target], { stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fake daemon did not start')), 10_000);
    child.once('spawn', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  return child;
}

function waitExit(child, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error('fake daemon never exited')), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function assertProcessGone(pid) {
  try {
    process.kill(pid, 0);
  } catch (err) {
    assert.equal(err.code, 'ESRCH', `unexpected error for pid ${pid}: ${err.code}`);
    return;
  }
  assert.fail(`process ${pid} is still alive`);
}

function runStop(home, stub, procDir) {
  return spawnSync(SH, [SCRIPT], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: home,
      PATH: stub.dir,
      TP_TEST_CURL_LOG: stub.log,
      TP_PROC_DIR: procDir,
    },
  });
}

test('tp-stop.sh 沒有 pgrep/pkill 時仍真的終止 daemon，不會謊報 TP_STOPPED', async () => {
  const home = makeHome('kill');
  const stub = makeStubPath('kill');
  const child = await spawnFakeDaemon('kill');
  const procDir = makeFakeProc('kill', [child.pid]);

  const res = runStop(home, stub, procDir);

  assert.equal(res.status, 0, `stdout=${res.stdout} stderr=${res.stderr}`);
  assert.match(res.stdout, /TP_STOPPED/);
  await waitExit(child);
  assertProcessGone(child.pid);
});

test('tp-stop.sh 在完全無法偵測程序時回報 TP_STOP_FAILED，且絕不輸出 TP_STOPPED', async () => {
  const home = makeHome('nocap');
  const stub = makeStubPath('nocap');
  const child = await spawnFakeDaemon('nocap');
  // No pgrep/pkill, no ps, and TP_PROC_DIR points at a path that does not
  // exist → the script has no way to inspect processes at all.
  const missingProc = join(tempRoot, 'proc-nocap-missing');

  const res = runStop(home, stub, missingProc);

  assert.notEqual(res.status, 0);
  assert.match(res.stdout, /TP_STOP_FAILED/);
  assert.doesNotMatch(res.stdout, /TP_STOPPED/);
  // The fake daemon must not have been signalled either.
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
  child.kill('SIGKILL');
  await waitExit(child);
});

test('tp-stop.sh 一併 flush daemon.json 指定的 port，9772／9774 仍保留', () => {
  const home = makeHome('ports');
  const dataDir = join(home, '.local', 'share', 'ego-linux');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'daemon.json'), '{"port":9780,"chromePort":9773}');
  const stub = makeStubPath('ports');
  const procDir = makeFakeProc('ports', []);

  const res = runStop(home, stub, procDir);

  assert.equal(res.status, 0, `stdout=${res.stdout} stderr=${res.stderr}`);
  assert.match(res.stdout, /TP_STOPPED/);
  const urls = readFileSync(stub.log, 'utf8');
  assert.match(urls, /http:\/\/127\.0\.0\.1:9772\/flush-and-close/);
  assert.match(urls, /http:\/\/127\.0\.0\.1:9774\/flush-and-close/);
  assert.match(urls, /http:\/\/127\.0\.0\.1:9780\/flush-and-close/);
});

test('tp-stop.sh 忽略 daemon.json 裡非法的 port 值', () => {
  const home = makeHome('badport');
  const dataDir = join(home, '.local', 'share', 'ego-linux');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'daemon.json'), '{"port":0,"alt":{"port":99999},"note":"port:abc"}');
  const stub = makeStubPath('badport');
  const procDir = makeFakeProc('badport', []);

  const res = runStop(home, stub, procDir);

  assert.equal(res.status, 0, `stdout=${res.stdout} stderr=${res.stderr}`);
  assert.match(res.stdout, /TP_STOPPED/);
  const urls = readFileSync(stub.log, 'utf8');
  assert.match(urls, /http:\/\/127\.0\.0\.1:9772\/flush-and-close/);
  assert.match(urls, /http:\/\/127\.0\.0\.1:9774\/flush-and-close/);
  assert.doesNotMatch(urls, /:0\//);
  assert.doesNotMatch(urls, /:99999\//);
  assert.doesNotMatch(urls, /:abc\//);
});
