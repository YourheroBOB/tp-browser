// tests/fmb_w10_s13_tp_stop_daemon_port.test.mjs
// tp-stop.sh 回歸測試：/flush-and-close 必須打到 daemon.json 宣告的自訂連接埠。
//
// 為什麼這是真 bug：daemon 把實際 listen 的埠寫進 daemon.json（tp-start.sh
// --alt-port、STATE.md 記錄的 18802/18800 部署都不走 9772）。舊版腳本只 flush
// 9772 與 9774，於是自訂埠的主機會被 SIGTERM 而不會執行 /flush-and-close，
// 也就是「優雅關閉時把 Cookie/storage 落地」這件事被靜默跳過 → 登入態可能遺失。
//
// 零依賴、零網路：curl / pgrep / pkill / sleep 全部替換成暫存目錄內的假執行檔，
// 不接觸任何真實程序或服務；唯讀取 repo 內的 scripts/tp-stop.sh。

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/tp-stop.sh', import.meta.url));
const SKIP = process.platform === 'win32' ? 'tp-stop.sh is a POSIX shell script' : false;
const BASE_PATH =
  typeof process.env.PATH === 'string' && process.env.PATH.length > 0
    ? process.env.PATH
    : '/usr/local/bin:/usr/bin:/bin';

/**
 * 建立隔離沙箱：
 *  - HOME 指向暫存目錄，daemon.json（可省略）只寫在這個 HOME 底下
 *  - PATH 以沙箱 bin 優先，curl 只記錄參數，pgrep 一律回報「沒有程序在跑」，
 *    pkill 不會真的殺任何東西，sleep 立刻返回
 */
function makeSandbox(t, daemonJson) {
  const root = mkdtempSync(join(tmpdir(), 'fmb-w10-s13-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const home = join(root, 'home');
  const dataDir = join(home, '.local', 'share', 'ego-linux');
  const bin = join(root, 'bin');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(bin, { recursive: true });
  if (daemonJson !== undefined) writeFileSync(join(dataDir, 'daemon.json'), daemonJson, 'utf8');

  const curlLog = join(root, 'curl.log');
  writeFileSync(curlLog, '', 'utf8');

  const stubs = {
    curl: '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$CURL_LOG"\nexit 0\n',
    pgrep: '#!/bin/sh\nexit 1\n',
    pkill: '#!/bin/sh\nexit 0\n',
    sleep: '#!/bin/sh\nexit 0\n',
  };
  for (const [name, body] of Object.entries(stubs)) {
    const file = join(bin, name);
    writeFileSync(file, body, { mode: 0o755 });
    chmodSync(file, 0o755);
  }

  return { root, home, bin, curlLog };
}

function runStop(sandbox) {
  return spawnSync('/bin/sh', [SCRIPT], {
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      HOME: sandbox.home,
      PATH: `${sandbox.bin}:${BASE_PATH}`,
      CURL_LOG: sandbox.curlLog,
    },
  });
}

function flushedPorts(curlLog) {
  const log = readFileSync(curlLog, 'utf8');
  const found = log.match(/127\.0\.0\.1:(\d+)\/flush-and-close/g) ?? [];
  return found.map((m) => m.match(/(\d+)\/flush-and-close/)[1]);
}

test('tp-stop.sh 會 flush daemon.json 宣告的自訂連接埠', { skip: SKIP }, (t) => {
  const sandbox = makeSandbox(t, JSON.stringify({ port: 18802, chromePort: 18800 }));
  const res = runStop(sandbox);

  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /TP_STOPPED/);

  const ports = flushedPorts(sandbox.curlLog);
  assert.ok(ports.includes('18802'), `missing custom daemon port, got: ${ports.join(',')}`);
  assert.ok(ports.includes('9772'), `missing default port, got: ${ports.join(',')}`);
  assert.ok(ports.includes('9774'), `missing alt default port, got: ${ports.join(',')}`);
  // chromePort 是 CDP 埠，沒有 /flush-and-close 端點，不該被打。
  assert.ok(!ports.includes('18800'), `chrome CDP port must not be flushed: ${ports.join(',')}`);
});

test('tp-stop.sh 對無效／超範圍／字串型 port 一律退回內建埠', { skip: SKIP }, (t) => {
  const badConfigs = [
    'not json at all',
    '{}',
    '{"port":0}',
    '{"port":70000}',
    '{"port":"18802"}',
    '{"chromePort":18800}',
  ];
  for (const cfg of badConfigs) {
    const sandbox = makeSandbox(t, cfg);
    const res = runStop(sandbox);
    assert.equal(res.status, 0, `${cfg}: ${res.stderr}`);
    const ports = flushedPorts(sandbox.curlLog).sort();
    assert.deepEqual(ports, ['9772', '9774'], `${cfg}: unexpected flush targets`);
  }
});

test('tp-stop.sh 不會重複 flush 同一個埠，且沒有 daemon.json 時仍用內建埠', { skip: SKIP }, (t) => {
  const withConfig = makeSandbox(t, JSON.stringify({ port: 9772, chromePort: 9773 }));
  const res = runStop(withConfig);
  assert.equal(res.status, 0, res.stderr);
  const ports = flushedPorts(withConfig.curlLog);
  assert.deepEqual(ports.sort(), ['9772', '9774'], `duplicate flush detected: ${ports.join(',')}`);

  const withoutConfig = makeSandbox(t, undefined);
  const res2 = runStop(withoutConfig);
  assert.equal(res2.status, 0, res2.stderr);
  assert.deepEqual(flushedPorts(withoutConfig.curlLog).sort(), ['9772', '9774']);
});
