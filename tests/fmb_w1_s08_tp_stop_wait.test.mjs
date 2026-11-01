import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const STOP_SCRIPT = fileURLToPath(new URL('../scripts/tp-stop.sh', import.meta.url));

function makeSandbox(t, pgrepMode) {
  const root = mkdtempSync(join(tmpdir(), 'fmb-w1-s08-tp-stop-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const bin = join(root, 'bin');
  const home = join(root, 'home');
  const dataDir = join(home, '.local', 'share', 'ego-linux');
  const eventLog = join(root, 'events.log');
  const pgrepCountFile = join(root, 'pgrep-count');

  for (const dir of [bin, dataDir]) {
    mkdirSync(dir, { recursive: true });
  }

  const stubs = {
    curl: `#!/bin/sh
printf 'curl %s\\n' "$*" >> "$EVENT_LOG"
exit 0
`,
    pkill: `#!/bin/sh
printf 'pkill %s\\n' "$*" >> "$EVENT_LOG"
exit 0
`,
    pgrep: `#!/bin/sh
printf 'pgrep %s\\n' "$*" >> "$EVENT_LOG"
count=0
if [ -f "$PGREP_COUNT_FILE" ]; then
  read count < "$PGREP_COUNT_FILE"
fi
count=$((count + 1))
printf '%s\\n' "$count" > "$PGREP_COUNT_FILE"
${pgrepMode}
`,
    sleep: `#!/bin/sh
exit 0
`,
  };

  for (const [name, body] of Object.entries(stubs)) {
    const path = join(bin, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  }

  return {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH || '/bin:/usr/bin'}`,
      HOME: home,
      EVENT_LOG: eventLog,
      PGREP_COUNT_FILE: pgrepCountFile,
      PGREP_ALIVE_CALLS: '3',
    },
    eventLog,
    pgrepCountFile,
  };
}

function runStop(sandbox) {
  return spawnSync('/bin/sh', [STOP_SCRIPT], {
    encoding: 'utf8',
    env: sandbox.env,
    timeout: 10_000,
  });
}

test('tp-stop waits for graceful exit and flushes both ports before signaling', (t) => {
  const sandbox = makeSandbox(t, 'if [ "$count" -le "$PGREP_ALIVE_CALLS" ]; then exit 0; fi\nexit 1');
  const result = runStop(sandbox);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'TP_STOPPED');

  const events = readFileSync(sandbox.eventLog, 'utf8').trim().split('\n');
  const firstPkill = events.findIndex((line) => line.startsWith('pkill '));
  const flush9772 = events.findIndex((line) => line.includes('127.0.0.1:9772/flush-and-close'));
  const flush9774 = events.findIndex((line) => line.includes('127.0.0.1:9774/flush-and-close'));
  assert.ok(flush9772 >= 0 && flush9772 < firstPkill, '9772 flush must precede pkill');
  assert.ok(flush9774 >= 0 && flush9774 < firstPkill, '9774 flush must precede pkill');
  assert.ok(events.filter((line) => line.startsWith('pgrep -f ')).length > 3, 'must poll process status');
  assert.ok(!events.some((line) => line.startsWith('pkill -9 ')), 'graceful exit must not require force kill');
});

test('tp-stop force-kills survivors and fails if they remain', (t) => {
  const sandbox = makeSandbox(t, 'exit 0');
  const result = runStop(sandbox);

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout.trim(), 'TP_STOP_FAILED');
  const events = readFileSync(sandbox.eventLog, 'utf8');
  assert.match(events, /^pkill -9 -f /m);
});
