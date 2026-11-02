// fmb_w14_s13 — scripts/tp-stop.sh 的 daemon.json port 解析回歸測試。
// 只使用暫存 HOME（mkdtempSync(tmpdir())）與本機 stub（curl/pgrep/pkill/sleep），
// 不連線任何正式服務、不讀寫 repo 以外的既定路徑、不需要任何憑證。
//
// 被測行為：tp-stop 在 SIGTERM 之前會對 daemon.json 記載的 daemon port 呼叫
// /flush-and-close，避免自訂埠的 daemon 在停止時丟掉 cookies/storage。
// 這裡鎖住兩種合法但先前沒被覆蓋的寫法：
//   1) port 值以 JSON 字串表示（"port": "18802"）—— 安裝器或手改設定會這樣寫，
//      Windows 版 ego-stop.ps1 以 [int] 轉型即可接受，shell 版先前會直接忽略。
//   2) 多行 pretty-print 的 daemon.json。
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/tp-stop.sh', import.meta.url));

const STUBS = {
  curl: '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$CURL_LOG"\nexit 0\n',
  pgrep: '#!/bin/sh\nexit 1\n',
  pkill: '#!/bin/sh\nexit 0\n',
  sleep: '#!/bin/sh\nexit 0\n',
};

function makeSandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'fmb-w14-s13-tp-stop-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const home = join(root, 'home');
  const dataDir = join(home, '.local', 'share', 'ego-linux');
  const bin = join(root, 'bin');
  const curlLog = join(root, 'curl.log');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(curlLog, '', 'utf8');

  for (const [name, contents] of Object.entries(STUBS)) {
    const path = join(bin, name);
    writeFileSync(path, contents, { mode: 0o755 });
    chmodSync(path, 0o755);
  }

  return { root, home, dataDir, bin, curlLog };
}

function runStop(sandbox) {
  return spawnSync('/bin/sh', [SCRIPT], {
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      HOME: sandbox.home,
      PATH: `${sandbox.bin}:${process.env.PATH ?? ''}`,
      CURL_LOG: sandbox.curlLog,
    },
  });
}

test(
  'tp-stop flushes a JSON-string port from a pretty-printed daemon.json',
  { skip: process.platform === 'win32' },
  (t) => {
    const sandbox = makeSandbox(t);
    writeFileSync(
      join(sandbox.dataDir, 'daemon.json'),
      '{\n  "port": "18802",\n  "chromePort": "18803"\n}\n',
      'utf8',
    );

    const result = runStop(sandbox);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /TP_STOPPED/);

    const calls = readFileSync(sandbox.curlLog, 'utf8');
    assert.match(calls, /http:\/\/127\.0\.0\.1:9772\/flush-and-close/);
    assert.match(calls, /http:\/\/127\.0\.0\.1:9774\/flush-and-close/);
    assert.match(calls, /http:\/\/127\.0\.0\.1:18802\/flush-and-close/);
  },
);

test(
  'tp-stop still flushes a numeric custom port (single-line daemon.json)',
  { skip: process.platform === 'win32' },
  (t) => {
    const sandbox = makeSandbox(t);
    writeFileSync(
      join(sandbox.dataDir, 'daemon.json'),
      '{"port":19555,"chromePort":19556}\n',
      'utf8',
    );

    const result = runStop(sandbox);
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const calls = readFileSync(sandbox.curlLog, 'utf8');
    assert.match(calls, /http:\/\/127\.0\.0\.1:19555\/flush-and-close/);
  },
);
