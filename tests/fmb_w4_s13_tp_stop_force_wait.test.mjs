// tests/fmb_w4_s13_tp_stop_force_wait.test.mjs
// tp-stop.sh 迴歸測試：SIGKILL 只是把訊號排入佇列，行程在核心回收前仍會被 pgrep 看到
// （若父行程尚未 wait，zombie 也還留在 /proc）。原本的實作在送出 SIGKILL 之後只檢查
// 一次 all_stopped()，因此在「殺得掉、但還沒消失」的正常情境下會印出 TP_STOP_FAILED
// 並以 1 結束。此測試用假的 curl/pkill/pgrep/sleep 把那個時間窗變成確定性行為。
// 零依賴、零網路；所有檔案都在 mkdtempSync(tmpdir()) 內，結束後刪除。
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const STOP_SCRIPT = fileURLToPath(new URL('../scripts/tp-stop.sh', import.meta.url));
const SKIP = process.platform === 'win32' ? 'tp-stop.sh is POSIX-only' : false;

// dyingCalls：送出 SIGKILL 之後，前 N 次 pgrep 仍看得到正在死亡的行程。
function makeSandbox(t, dyingCalls) {
  const root = mkdtempSync(join(tmpdir(), 'fmb-w4-s13-tp-stop-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const bin = join(root, 'bin');
  const home = join(root, 'home');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(home, '.local', 'share', 'ego-linux'), { recursive: true });

  const eventLog = join(root, 'events.log');
  const forcedMarker = join(root, 'forced.marker');
  const dyingCounter = join(root, 'dying.count');
  writeFileSync(eventLog, '');

  const stubs = {
    curl: `#!/bin/sh
printf 'curl %s\\n' "$*" >> "$EVENT_LOG"
exit 0
`,
    pkill: `#!/bin/sh
printf 'pkill %s\\n' "$*" >> "$EVENT_LOG"
case " $* " in
  *" -9 "*) : > "$FORCED_MARKER" ;;
esac
exit 0
`,
    pgrep: `#!/bin/sh
printf 'pgrep %s\\n' "$*" >> "$EVENT_LOG"
if [ -f "$FORCED_MARKER" ]; then
  seen=0
  if [ -f "$DYING_COUNTER" ]; then read seen < "$DYING_COUNTER"; fi
  seen=$((seen + 1))
  printf '%s\\n' "$seen" > "$DYING_COUNTER"
  if [ "$seen" -le "$DYING_CALLS" ]; then exit 0; fi
  exit 1
fi
exit 0
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
    eventLog,
    env: {
      HOME: home,
      PATH: `${bin}:${process.env.PATH ?? '/bin:/usr/bin'}`,
      EVENT_LOG: eventLog,
      FORCED_MARKER: forcedMarker,
      DYING_COUNTER: dyingCounter,
      DYING_CALLS: String(dyingCalls),
    },
  };
}

function runStop(env) {
  return spawnSync('/bin/sh', [STOP_SCRIPT], { encoding: 'utf8', env, timeout: 20_000 });
}

function events(sandbox) {
  return readFileSync(sandbox.eventLog, 'utf8').trim().split('\n').filter(Boolean);
}

function lastForceKillIndex(lines) {
  let last = -1;
  lines.forEach((line, index) => {
    if (line.startsWith('pkill -9 ')) last = index;
  });
  return last;
}

test('tp-stop：SIGKILL 之後會再輪詢，不會在第一次 pgrep 就回報 TP_STOP_FAILED', { skip: SKIP }, (t) => {
  // 行程「殺得掉，但第一次 pgrep 還看得到」——這是最常見的真實情境。
  const sandbox = makeSandbox(t, 1);
  const result = runStop(sandbox.env);

  assert.equal(result.status, 0, `stdout=${result.stdout} stderr=${result.stderr}`);
  assert.equal(result.stdout.trim(), 'TP_STOPPED');

  const lines = events(sandbox);
  const killIndex = lastForceKillIndex(lines);
  assert.ok(killIndex >= 0, 'graceful shutdown 逾時時必須送出 SIGKILL');

  const pollsAfterKill = lines.slice(killIndex + 1).filter((line) => line.startsWith('pgrep ')).length;
  assert.ok(pollsAfterKill >= 2, `SIGKILL 後必須繼續輪詢，實際 pgrep 次數=${pollsAfterKill}`);
});

test('tp-stop：真正殺不掉的行程仍會在有限次輪詢後以 1 結束', { skip: SKIP }, (t) => {
  const sandbox = makeSandbox(t, 999);
  const result = runStop(sandbox.env);

  assert.notEqual(result.status, null, 'tp-stop 必須在測試逾時前自行結束（不可無限輪詢）');
  assert.equal(result.status, 1, `stdout=${result.stdout} stderr=${result.stderr}`);
  assert.equal(result.stdout.trim(), 'TP_STOP_FAILED');

  const lines = events(sandbox);
  const killIndex = lastForceKillIndex(lines);
  assert.ok(killIndex >= 0, 'graceful shutdown 逾時時必須送出 SIGKILL');

  const pollsAfterKill = lines.slice(killIndex + 1).filter((line) => line.startsWith('pgrep ')).length;
  assert.ok(pollsAfterKill >= 2, `失敗判定前仍應重試輪詢，實際 pgrep 次數=${pollsAfterKill}`);
  assert.ok(pollsAfterKill <= 20, `輪詢次數必須有上限，實際 pgrep 次數=${pollsAfterKill}`);
});
