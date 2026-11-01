// tests/fmb_w6_s10_tp_start_flush_all_ports.test.mjs
//
// Regression for scripts/tp-start.sh.
//
// The pkill sweep in tp-start.sh matches "ego-browserd.js" / "tp-browserd.js" /
// "$PROFILE_DIR" — i.e. *every* TP daemon and every agent Chrome on the
// machine, not just the port group this invocation is about to start. The
// default group (9772/9773), the alt group (9774/9775) and any extra port in
// daemon.json are all killed. Before the fix only $DAEMON_PORT was flushed, so
// the other group's Chrome was SIGTERM'ed/SIGKILL'ed before it could persist
// cookies and storage.
//
// Nothing here talks to a real daemon: a stub PATH records every
// curl/pgrep/pkill/node/sleep call, pgrep always answers "nothing is alive"
// (so the wait loop exits immediately and no SIGKILL path is taken) and curl
// answers /health with {"chrome":true} so the launch wait ends at once.
// No network, no credentials, no paths outside mkdtemp(tmpdir()).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const scriptPath = join(repoRoot, 'scripts', 'tp-start.sh');
const SH = existsSync('/bin/sh') ? '/bin/sh' : 'sh';
const tempRoot = mkdtempSync(join(tmpdir(), 'fmb-w6-s10-tp-start-flush-'));

after(() => rmSync(tempRoot, { recursive: true, force: true }));

function stub(binDir, name, body) {
  const file = join(binDir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`, 'utf8');
  chmodSync(file, 0o755);
}

// Each sandbox owns its own HOME (so DATA_DIR is empty by default), its own
// stub PATH and its own call log.
function makeSandbox(name, options = {}) {
  const root = join(tempRoot, name);
  const home = join(root, 'home');
  const binDir = join(root, 'stub-bin');
  const logFile = join(root, 'calls.log');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(home, '.local', 'share'), { recursive: true });
  writeFileSync(logFile, '', 'utf8');

  stub(
    binDir,
    'curl',
    [
      'TP_URL=""',
      'for _a in "$@"; do',
      '  case "$_a" in',
      '    http://*|https://*) TP_URL="$_a" ;;',
      '  esac',
      'done',
      '[ -n "$TP_URL" ] || TP_URL="NO_URL"',
      'printf \'curl %s\\n\' "$TP_URL" >> "$TP_TEST_LOG"',
      'case "$TP_URL" in',
      '  */flush-and-close*) exit 0 ;;',
      '  */health*) printf \'{"ok":true,"chrome":true}\\n\'; exit 0 ;;',
      'esac',
      'exit 7',
    ].join('\n'),
  );
  stub(binDir, 'pgrep', 'printf \'pgrep %s\\n\' "$*" >> "$TP_TEST_LOG"\nexit 1');
  stub(binDir, 'pkill', 'printf \'pkill %s\\n\' "$*" >> "$TP_TEST_LOG"\nexit 0');
  stub(binDir, 'node', 'printf \'node %s\\n\' "$*" >> "$TP_TEST_LOG"\nexit 0');
  stub(binDir, 'sleep', 'printf \'sleep %s\\n\' "$*" >> "$TP_TEST_LOG"\nexit 0');

  const fakeBrowser = join(root, 'fake-browser');
  writeFileSync(fakeBrowser, '#!/bin/sh\nexit 0\n', 'utf8');
  chmodSync(fakeBrowser, 0o755);

  const env = {
    ...process.env,
    HOME: home,
    TP_TEST_LOG: logFile,
    TP_BROWSER_BIN: options.TP_BROWSER_BIN ?? fakeBrowser,
    PATH: `${binDir}${delimiter}${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`,
  };

  const writeDaemonJson = (content) => {
    const dataDir = join(home, '.local', 'share', 'ego-linux');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'daemon.json'), content, 'utf8');
  };

  const run = (args) =>
    spawnSync(SH, [scriptPath, ...args], { encoding: 'utf8', timeout: 60_000, env });

  return { root, home, logFile, env, run, writeDaemonJson, fakeBrowser };
}

const readEvents = (logFile) =>
  readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);

function flushEvents(events) {
  const out = [];
  events.forEach((line, index) => {
    if (!line.startsWith('curl ') || !line.includes('/flush-and-close')) return;
    const m = /127\.0\.0\.1:(\d+)\/flush-and-close/.exec(line);
    out.push({ index, port: m ? Number(m[1]) : NaN });
  });
  return out;
}

const firstPkillIndex = (events) => events.findIndex((line) => line.startsWith('pkill '));

test('tp-start.sh --restart flushes 9772 and 9774 before the first pkill', () => {
  const box = makeSandbox('default-port');
  const res = box.run(['--restart']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /TP_READY/);

  const events = readEvents(box.logFile);
  const flushes = flushEvents(events);
  const kill = firstPkillIndex(events);

  assert.ok(kill >= 0, 'the sweep must call pkill at least once');
  assert.equal(flushes.length, 2, `expected exactly two flushes, got: ${JSON.stringify(flushes)}`);

  const p9772 = flushes.find((f) => f.port === 9772);
  const p9774 = flushes.find((f) => f.port === 9774);
  assert.ok(p9772, 'the port about to be started (9772) must be flushed');
  assert.ok(p9774, 'the other group (9774) is killed by the same sweep and must be flushed too');
  assert.ok(p9772.index < kill, '9772 must be flushed before the first pkill');
  assert.ok(p9774.index < kill, '9774 must be flushed before the first pkill');
  assert.ok(p9772.index < p9774.index, 'the port being started is flushed first');
});

test('tp-start.sh --alt-port --restart also flushes both 9774 and 9772 before the first pkill', () => {
  const box = makeSandbox('alt-port');
  const res = box.run(['--alt-port', '--restart']);
  assert.equal(res.status, 0, res.stderr || res.stdout);
  assert.match(res.stdout, /TP_READY/);

  const events = readEvents(box.logFile);
  const flushes = flushEvents(events);
  const kill = firstPkillIndex(events);

  assert.ok(kill >= 0, 'the sweep must call pkill at least once');
  assert.deepEqual(flushes.map((f) => f.port).sort((a, b) => a - b), [9772, 9774]);
  for (const flush of flushes) {
    assert.ok(flush.index < kill, `flush of ${flush.port} must precede the first pkill`);
  }
});

test('tp-start.sh flushes a valid daemon.json port too, still before the first pkill', () => {
  const box = makeSandbox('daemon-json-port');
  box.writeDaemonJson('{\n  "port": 18802,\n  "chromePort": 18803\n}\n');
  const res = box.run(['--restart']);
  assert.equal(res.status, 0, res.stderr || res.stdout);

  const events = readEvents(box.logFile);
  const flushes = flushEvents(events);
  const kill = firstPkillIndex(events);

  assert.deepEqual(flushes.map((f) => f.port).sort((a, b) => a - b), [9772, 9774, 18802]);
  for (const flush of flushes) {
    assert.ok(flush.index < kill, `flush of ${flush.port} must precede the first pkill`);
  }
});

test('tp-start.sh flushes each port once even when daemon.json repeats 9774', () => {
  const box = makeSandbox('daemon-json-dedup');
  box.writeDaemonJson('{"port": 9774, "chromePort": 9775}');
  const res = box.run(['--alt-port', '--restart']);
  assert.equal(res.status, 0, res.stderr || res.stdout);

  const flushes = flushEvents(readEvents(box.logFile));
  assert.deepEqual(flushes.map((f) => f.port), [9774, 9772], 'no duplicate flush for 9774');
});

test('tp-start.sh ignores unusable daemon.json ports instead of failing', () => {
  for (const payload of ['{"port": 0}', '{"port": 70000}', '{"port": "not-a-port"}', 'not json at all']) {
    const box = makeSandbox(`daemon-json-bad-${Buffer.from(payload).toString('hex').slice(0, 12)}`);
    box.writeDaemonJson(payload);
    const res = box.run(['--restart']);
    assert.equal(res.status, 0, `${payload}: ${res.stderr || res.stdout}`);

    const events = readEvents(box.logFile);
    const flushes = flushEvents(events);
    const kill = firstPkillIndex(events);
    assert.deepEqual(
      flushes.map((f) => f.port).sort((a, b) => a - b),
      [9772, 9774],
      `${payload}: only the fixed dual-port set should be flushed`,
    );
    for (const flush of flushes) {
      assert.ok(flush.index < kill, `${payload}: flush of ${flush.port} must precede the first pkill`);
    }
  }
});

test('tp-start.sh with an invalid TP_BROWSER_BIN flushes nothing and kills nothing', () => {
  const box = makeSandbox('invalid-browser', {
    TP_BROWSER_BIN: join(tempRoot, 'invalid-browser', 'does-not-exist'),
  });
  const res = box.run(['--restart']);
  assert.equal(res.status, 1, res.stderr || res.stdout);
  assert.match(res.stderr, /TP_BROWSER_BIN/);

  const events = readEvents(box.logFile);
  assert.deepEqual(flushEvents(events), [], 'no /flush-and-close may be attempted');
  assert.equal(firstPkillIndex(events), -1, 'no pkill may be attempted');
});
