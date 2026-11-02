// tests/fmb_w11_s13_tp_stop_custom_port.test.mjs
//
// tp-stop.sh 原本只對硬編的 9772/9774 送 /flush-and-close，但 daemon 實際的埠可由
// daemon.json 指定（Windows 版 ego-stop.ps1 已經讀該檔）。自訂埠上的 daemon 因此收不到
// 優雅關閉請求，Cookie/Storage 可能在 SIGTERM 之前沒有落盤。
//
// 這個測試用 stub 的 curl / pkill / pgrep / sleep 執行腳本：
//   * 不連任何網路（curl stub 只把 URL 寫進 log）
//   * 不殺任何真實程序（pkill / pgrep 都是 stub）
//   * 只讀寫 mkdtemp() 出來的暫存目錄
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

const SCRIPT = fileURLToPath(new URL('../scripts/tp-stop.sh', import.meta.url));
const IS_WIN = process.platform === 'win32';
const SKIP = IS_WIN ? 'tp-stop.sh needs /bin/sh and sed' : false;

const DEFAULTS = [
  'http://127.0.0.1:9772/flush-and-close',
  'http://127.0.0.1:9774/flush-and-close',
];

function findExecutable(name) {
  for (const dir of ['/usr/bin', '/bin', '/usr/local/bin']) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate);
      return candidate;
    } catch {
      // keep looking in the next standard location
    }
  }
  throw new Error(`required system utility not found: ${name}`);
}

function makeSandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'fmb-w11-s13-tp-stop-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const home = join(root, 'home');
  const dataDir = join(home, '.local', 'share', 'ego-linux');
  const bin = join(root, 'bin');
  const realBin = join(root, 'real-bin');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(realBin, { recursive: true });

  // 只放腳本真正需要的系統工具；curl / pkill / pgrep / sleep 一律由 stub 取代。
  symlinkSync(findExecutable('sed'), join(realBin, 'sed'));

  const curlLog = join(root, 'curl.log');
  const pkillLog = join(root, 'pkill.log');
  writeFileSync(curlLog, '');
  writeFileSync(pkillLog, '');

  const stubs = {
    curl: [
      '#!/bin/sh',
      'for a in "$@"; do',
      '  case "$a" in',
      '    http://*) printf \'%s\\n\' "$a" >> "$CURL_LOG" ;;',
      '  esac',
      'done',
      'exit 0',
      '',
    ].join('\n'),
    pkill: ['#!/bin/sh', 'printf \'%s\\n\' "$*" >> "$PKILL_LOG"', 'exit 0', ''].join('\n'),
    pgrep: ['#!/bin/sh', 'exit 1', ''].join('\n'),
    sleep: ['#!/bin/sh', 'exit 0', ''].join('\n'),
  };
  for (const [name, contents] of Object.entries(stubs)) {
    const file = join(bin, name);
    writeFileSync(file, contents, { mode: 0o755 });
    chmodSync(file, 0o755);
  }

  return { root, home, dataDir, bin, realBin, curlLog, pkillLog };
}

function writeDaemonJson(sandbox, contents) {
  writeFileSync(join(sandbox.dataDir, 'daemon.json'), contents);
}

function runStop(sandbox) {
  return spawnSync('/bin/sh', [SCRIPT], {
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      HOME: sandbox.home,
      PATH: `${sandbox.bin}:${sandbox.realBin}`,
      CURL_LOG: sandbox.curlLog,
      PKILL_LOG: sandbox.pkillLog,
    },
  });
}

function flushUrls(sandbox) {
  return readFileSync(sandbox.curlLog, 'utf8').split('\n').filter(Boolean);
}

test('tp-stop 會 flush daemon.json 指定的自訂埠，而非只有 9772/9774', { skip: SKIP }, (t) => {
  const sandbox = makeSandbox(t);
  writeDaemonJson(sandbox, `${JSON.stringify({ port: 19772, chromePort: 19773 })}\n`);

  const res = runStop(sandbox);

  assert.equal(res.status, 0, res.stderr || res.error?.message);
  assert.match(res.stdout, /TP_STOPPED/);
  assert.deepEqual(flushUrls(sandbox), [
    ...DEFAULTS,
    'http://127.0.0.1:19772/flush-and-close',
  ]);

  // 程序清理行為不變：三個 pgrep/pkill pattern 仍然各處理一次。
  assert.equal(readFileSync(sandbox.pkillLog, 'utf8').split('\n').filter(Boolean).length, 3);
});

test('tp-stop 支援多行 pretty-print 的 daemon.json', { skip: SKIP }, (t) => {
  const sandbox = makeSandbox(t);
  writeDaemonJson(sandbox, '{\n  "port": 19555,\n  "chromePort": 19556\n}\n');

  const res = runStop(sandbox);

  assert.equal(res.status, 0, res.stderr || res.error?.message);
  assert.match(res.stdout, /TP_STOPPED/);
  assert.deepEqual(flushUrls(sandbox), [
    ...DEFAULTS,
    'http://127.0.0.1:19555/flush-and-close',
  ]);
});

test('壞掉或超範圍的 daemon.json 不影響停止流程，也不會 flush 奇怪的埠', { skip: SKIP }, (t) => {
  const cases = [
    ['not-json', 'this is not json at all\n'],
    ['empty-object', '{}\n'],
    ['port-zero', '{"port": 0}\n'],
    ['port-too-large', '{"port": 70000}\n'],
    ['port-not-a-number', '{"port": "FAKE_VALUE_FOR_TEST"}\n'],
    ['port-duplicates-default', '{"port": 9772}\n'],
  ];

  for (const [label, contents] of cases) {
    const sandbox = makeSandbox(t);
    writeDaemonJson(sandbox, contents);

    const res = runStop(sandbox);

    assert.equal(res.status, 0, `${label}: ${res.stderr || res.error?.message}`);
    assert.match(res.stdout, /TP_STOPPED/, label);
    assert.deepEqual(flushUrls(sandbox), DEFAULTS, label);
  }
});
