// tests/fmb_w12_s13_tp_stop_sleep_portability.test.mjs
//
// 回歸測試：tp-stop.sh 以 `set -eu` 執行，任何一個 sleep 失敗都會讓整個停止流程
// 在「送出任何訊號之前」直接中止（exit 1、完全沒有輸出）。
//
// 原本 flush 之後寫的是 `sleep 1.0`。小數秒數不是 POSIX 保證的用法：BusyBox 在未
// 啟用 CONFIG_FEATURE_FLOAT_SLEEP 時（Alpine 等精簡鏡像）會以
// "sleep: invalid number '1.0'" 失敗，於是 tp-stop 一個程序都沒殺就結束。
//
// 本檔以「只接受整數秒」的 sleep stub 重現該環境，並鎖住：
//   1. 一整條停止流程（flush 等待 → 優雅等待逾時 → SIGKILL → TP_STOPPED）在
//      只有整數秒 sleep 的環境下仍能跑完，代表所有等待都是整數秒；
//   2. 原始碼中的 sleep 指令一律使用整數秒（靜態鎖定）。
//
// 測試完全 hermetic：只使用 os.tmpdir() 下的暫存目錄，不連任何網路服務，不讀寫
// repo 以外的既定路徑，也不需要真的 pgrep/pkill/sleep（全部以 stub 取代）。
// 只 spawn 一次受測腳本，避免對整套測試的排程與時間預算造成額外負擔。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accessSync,
  chmodSync,
  existsSync,
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

const SCRIPT = fileURLToPath(new URL('../scripts/tp-stop.sh', import.meta.url));
const SH = existsSync('/bin/sh') ? '/bin/sh' : null;
const SKIP = process.platform === 'win32'
  ? 'tp-stop.sh 只在 macOS/Linux 上執行'
  : (SH ? false : '/bin/sh not found');

// 模擬 BusyBox（未編譯 FLOAT_SLEEP）的 sleep：只接受整數秒，其餘一律失敗。
const STUB_SLEEP = `#!/bin/sh
printf '%s\\n' "$*" >> "$SLEEP_LOG"
case "$1" in
  ''|*[!0-9]*)
    echo "sleep: invalid number '$1'" >&2
    exit 1
    ;;
esac
exit 0
`;

const STUB_PKILL = `#!/bin/sh
printf '%s\\n' "$*" >> "$PKILL_LOG"
if [ "$1" = "-9" ]; then
  : > "$SIGKILL_MARKER"
fi
exit 0
`;

// pgrep 先回 0（目標還在），直到 pkill -9 被叫用（建立 marker）後才回 1。
// 這讓同一次執行就依序走過：flush 等待 → 優雅等待逾時 → SIGKILL → 確認停止。
const STUB_PGREP_STICKY = `#!/bin/sh
printf '%s\\n' "$*" >> "$PGREP_LOG"
if [ -e "$SIGKILL_MARKER" ]; then
  exit 1
fi
exit 0
`;

function findExecutable(name) {
  for (const dir of ['/usr/bin', '/bin', '/usr/local/bin']) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate);
      return candidate;
    } catch {
      // 換下一個可能位置
    }
  }
  return null;
}

function readLines(path) {
  return readFileSync(path, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean);
}

function makeSandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'fmb-w12-s13-tp-stop-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const home = join(root, 'home');
  const bin = join(root, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });

  const log = {
    sleep: join(root, 'sleep.log'),
    pkill: join(root, 'pkill.log'),
    pgrep: join(root, 'pgrep.log'),
    marker: join(root, 'sigkill.marker'),
  };
  for (const path of [log.sleep, log.pkill, log.pgrep]) writeFileSync(path, '');

  // tp-stop.sh 的 esc_regex 真的需要 sed，這裡用系統上的真檔。
  const sed = findExecutable('sed');
  assert.ok(sed, 'sed is required by scripts/tp-stop.sh');
  symlinkSync(sed, join(bin, 'sed'));

  const stubs = {
    // 模擬「沒有 daemon 在聽」：curl 連線失敗（-f 之下 exit 22）。
    curl: '#!/bin/sh\nexit 22\n',
    sleep: STUB_SLEEP,
    pkill: STUB_PKILL,
    pgrep: STUB_PGREP_STICKY,
  };
  for (const [name, body] of Object.entries(stubs)) {
    const path = join(bin, name);
    writeFileSync(path, body, { mode: 0o755 });
    chmodSync(path, 0o755);
  }

  return {
    log,
    env: {
      HOME: home, // DATA_DIR 不存在 → 不會去讀 daemon.json，流程完全可預期
      PATH: bin,
      SLEEP_LOG: log.sleep,
      PKILL_LOG: log.pkill,
      PGREP_LOG: log.pgrep,
      SIGKILL_MARKER: log.marker,
    },
  };
}

test(
  'tp-stop.sh：在只接受整數秒 sleep 的環境下，整條停止流程仍能收掉程序並回報 TP_STOPPED',
  { skip: SKIP },
  (t) => {
    const sandbox = makeSandbox(t);
    const result = spawnSync(SH, [SCRIPT], {
      encoding: 'utf8',
      timeout: 20_000,
      env: sandbox.env,
    });

    assert.equal(
      result.status,
      0,
      `tp-stop 應成功結束；status=${result.status} stderr=${result.stderr} stdout=${result.stdout}`,
    );
    assert.match(result.stdout, /^TP_STOPPED$/m);
    assert.doesNotMatch(result.stdout, /TP_STOP_FAILED/);

    // 每一次等待的參數都必須是整數秒；`sleep 1.0` 會在這種 sleep 上失敗。
    const sleeps = readLines(sandbox.log.sleep);
    assert.ok(sleeps.length >= 6, `等待迴圈沒有跑到逾時，sleep 次數=${sleeps.length}`);
    for (const arg of sleeps) {
      assert.match(
        arg,
        /^[0-9]+$/,
        `sleep 的參數必須是整數秒（POSIX 只保證整數）；實際傳入 "${arg}"，` +
          '在 BusyBox 等精簡環境會直接失敗並因 set -e 中止整個停止流程',
      );
    }

    const kills = readLines(sandbox.log.pkill);
    // 優雅路徑：對三個目標各送一次 SIGTERM。
    const terms = kills.filter((line) => line.startsWith('-f '));
    assert.equal(terms.length, 3, `SIGTERM 次數不符：${JSON.stringify(kills)}`);
    assert.ok(terms.some((line) => line.includes('ego-browserd')), '應終止 ego-browserd');
    assert.ok(terms.some((line) => line.includes('tp-browserd')), '應終止 tp-browserd');
    assert.ok(terms.some((line) => line.includes('profile-agent')), '應終止 agent Chrome profile');

    // 優雅等待逾時後必須升級為 SIGKILL，並在程序消失後才回報成功。
    assert.ok(
      kills.some((line) => line.startsWith('-9 ')),
      `逾時後應送出 SIGKILL：${JSON.stringify(kills)}`,
    );
    assert.ok(existsSync(sandbox.log.marker), 'SIGKILL stub 應該被觸發');
  },
);

test('tp-stop.sh：原始碼中的 sleep 一律使用整數秒（靜態鎖定）', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  const args = [];
  // 只看「真正的指令行」：去掉縮排後以 sleep 開頭，且不是註解／shebang。
  // 註解裡說明這個 bug 的文字（"...a sleep that rejects fractional values..."）
  // 不是可執行指令，不能被誤判成 sleep 呼叫。
  for (const rawLine of src.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = line.match(/^sleep\s+(\S+)/);
    if (m) args.push(m[1]);
  }
  assert.ok(
    args.length >= 2,
    `找不到預期的 sleep 呼叫（flush 後等待 + 輪詢等待）：${JSON.stringify(args)}`,
  );
  for (const arg of args) {
    assert.match(
      arg,
      /^[0-9]+$/,
      `sleep 參數必須是整數秒（POSIX 只保證整數）；原始碼出現 "sleep ${arg}"`,
    );
  }
});
